"""Xác nhận kết quả VNPay (SDD R2, specs/001-vnpay-sandbox).

POST /api/v1/payments/{payment_id}/check — thu ngân bấm "Kiểm tra lại" (hỏi VNPay bằng QueryDR)
GET  /api/v1/payments/vnpay/return       — trình duyệt khách quay về sau khi trả (công khai)
GET  /api/v1/payments/vnpay/ipn          — VNPay báo kết quả (công khai, chỉ bật khi có HTTPS)

Không tin Return URL một mình: kết quả "đã trả" chỉ được ghi khi QueryDR hoặc IPN (có chữ ký
VNPay) xác nhận. Mọi nguồn kết quả, kể cả script đối soát, đi qua `confirm_vnpay_payment`: khóa
phiên bàn → đơn → thanh toán, lần đã có kết quả cuối thì không làm lại, so số tiền, rồi chốt đơn
bằng đúng `finalize_paid_order` như tiền mặt. Gọi VNPay TRƯỚC khi khóa để không giữ khóa lúc
chờ mạng.
"""

from __future__ import annotations

import html
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.orders import (
    PaidOrderResult,
    _publish_order_updated,
    finalize_paid_order,
    lock_order_for_payment,
    publish_order_paid,
)
from app.api.v1.payments import _remember, _replay, _summary, client_ip
from app.core import config, vnpay
from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.loyalty import price_order
from app.core.payments import order_payments, payment_totals
from app.core.permissions import Permission
from app.db.base import get_session
from app.db.models import Order, Payment
from app.schemas.payments import PaymentOut, PaymentRecordedOut

router = APIRouter(tags=["payments"])

FINAL_STATUSES = ("SUCCEEDED", "FAILED", "EXPIRED", "REFUNDED", "CANCELLED")


@dataclass
class Confirmation:
    payment: Payment
    order: Order
    paid: PaidOrderResult | None = None
    reason: str | None = None  # lý do event ORDER_UPDATED; None = không đổi gì


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def query_payment(payment: Payment, ip_addr: str = "127.0.0.1") -> vnpay.VnpayResult:
    """Hỏi VNPay cho một lần thanh toán. Gọi khi CHƯA giữ khóa."""
    # Cùng nội dung với lúc tạo link (payments.vnpay_order_info): 6 ký tự cuối id đơn.
    order_info = f"Thanh toan don {payment.order_id.hex[-6:]}"
    return vnpay.query_transaction(payment.id, payment.vnp_create_date or "", order_info, ip_addr)


def confirm_vnpay_payment(
    session: Session,
    payment_id: uuid.UUID,
    result: vnpay.VnpayResult,
    source: str,
    actor: CurrentStaff,
    now: datetime | None = None,
) -> Confirmation:
    """Ghi kết quả VNPay vào lần thanh toán, trong transaction của người gọi (người gọi commit
    rồi phát event). Idempotent: lần đã có kết quả cuối thì chỉ ghi audit nếu VNPay báo đã trả
    muộn (lần đó đã hủy/hết hạn) để hoàn tay, không đổi gì khác."""
    now = now or datetime.now(timezone.utc)
    found = session.get(Payment, payment_id)
    order = lock_order_for_payment(session, found.order_id, found.outlet_id)
    payment = session.execute(
        select(Payment)
        .where(Payment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    payment.last_checked_at = now
    outcome = Confirmation(payment, order)

    def audit(action: str, **extra) -> None:
        write_audit_log(
            session,
            outlet_id=payment.outlet_id,
            staff_id=actor.id,
            action=action,
            entity_type="order",
            entity_id=order.id,
            payload={
                "payment_id": str(payment.id),
                "source": source,
                "result": result.status,
                "provider_code": result.code,
                **extra,
            },
        )

    if result.status == vnpay.ERROR:
        expired = _aware(payment.expires_at) is not None and _aware(payment.expires_at) < now
        if payment.status == "PENDING" and expired and source == "reconcile":
            payment.status = "UNKNOWN"
            audit("PAYMENT_CONFIRMED", status="UNKNOWN")
            outcome.reason = "PAYMENT_UNKNOWN"
        return outcome

    if payment.status in FINAL_STATUSES:
        if (
            result.status == vnpay.PAID
            and payment.status in ("CANCELLED", "EXPIRED", "FAILED")
            and payment.provider_txn_no is None
        ):
            payment.provider_txn_no = result.txn_no
            payment.provider_code = result.code
            audit("PAYMENT_LATE_SUCCESS", status=payment.status, amount=result.amount)
        return outcome

    payment.provider_code = result.code
    if result.status == vnpay.PAID:
        if result.amount is not None and result.amount != Decimal(payment.amount):
            payment.status = "UNKNOWN"
            audit(
                "PAYMENT_AMOUNT_MISMATCH",
                expected=Decimal(payment.amount),
                reported=result.amount,
            )
            outcome.reason = "PAYMENT_UNKNOWN"
            return outcome
        payment.status = "SUCCEEDED"
        payment.provider_txn_no = result.txn_no
        payment.provider_paid_at = result.paid_at
        session.flush()
        audit("PAYMENT_CONFIRMED", status="SUCCEEDED", amount=Decimal(payment.amount))
        if order.status == "BILLING":
            total = price_order(session, order).total
            if payment_totals(order_payments(session, order.id)).remaining(total) <= 0:
                outcome.paid = finalize_paid_order(
                    session, order, actor, extra_audit={"payment_id": str(payment.id)}
                )
        else:
            # Đơn đã chốt bằng cách khác trong lúc khách trả VNPay: thu thừa, cần hoàn tay.
            audit("PAYMENT_LATE_SUCCESS", status="SUCCEEDED", order_status=order.status)
        outcome.reason = "PAYMENT_RECORDED"
        return outcome

    expired = _aware(payment.expires_at) is not None and _aware(payment.expires_at) < now
    if result.status == vnpay.FAILED:
        payment.status = "FAILED"
        audit("PAYMENT_CONFIRMED", status="FAILED")
        outcome.reason = "PAYMENT_FAILED"
    elif expired:  # PENDING / NOT_FOUND sau khi hết hạn link: khách bỏ ngang
        payment.status = "EXPIRED"
        audit("PAYMENT_CONFIRMED", status="EXPIRED")
        outcome.reason = "PAYMENT_FAILED"
    return outcome


def publish_confirmation(actor: CurrentStaff, outcome: Confirmation) -> None:
    if outcome.paid is not None:
        publish_order_paid(actor, outcome.order, outcome.paid)
    elif outcome.reason:
        _publish_order_updated(actor, outcome.order, outcome.reason)


def system_actor(payment: Payment) -> CurrentStaff:
    """Kết quả đến từ khách hoặc VNPay, không có nhân viên: audit ghi staff_id null."""
    return CurrentStaff(id=None, outlet_id=payment.outlet_id, role="SYSTEM")


def _find_by_txn_ref(session: Session, ref: str | None) -> Payment | None:
    if not ref:
        return None
    return session.execute(
        select(Payment).where(Payment.provider_ref == ref, Payment.method == "VNPAY")
    ).scalar_one_or_none()


@router.post("/payments/{payment_id}/check", response_model=PaymentRecordedOut)
def check_vnpay_payment(
    payment_id: uuid.UUID,
    request: Request,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.PROCESS_PAYMENT)),
    session: Session = Depends(get_session),
) -> PaymentRecordedOut:
    """Thu ngân bấm "Kiểm tra lại" cho lần VNPay đang chờ: hỏi VNPay rồi ghi kết quả. Lần đã có
    kết quả cuối thì trả lại kết quả đó. VNPay không trả lời: 502, trạng thái giữ nguyên."""
    endpoint = f"POST /api/v1/payments/{payment_id}/check"
    request_hash = hash_request_body({"payment_id": str(payment_id)})
    replay = _replay(session, idempotency_key, endpoint, request_hash, status.HTTP_200_OK)
    if replay is not None:
        return PaymentRecordedOut.model_validate_json(replay)

    payment = session.get(Payment, payment_id)
    if payment is None or payment.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy lần thanh toán")
    if payment.method != "VNPAY":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Không phải thanh toán VNPay")

    outcome = None
    if payment.status not in FINAL_STATUSES:
        if not vnpay.is_configured():
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, detail="VNPay chưa được cấu hình"
            )
        result = query_payment(payment, client_ip(request))
        if result.status == vnpay.ERROR:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                detail="Chưa hỏi được VNPay, vui lòng thử lại sau ít phút",
            )
        outcome = confirm_vnpay_payment(session, payment_id, result, "check", current)
        payment, order = outcome.payment, outcome.order
    else:
        order = session.get(Order, payment.order_id)

    session.flush()
    session.refresh(payment)
    response = PaymentRecordedOut(
        payment=PaymentOut.model_validate(payment),
        order_status=order.status,
        summary=_summary(session, order, order_payments(session, order.id)),
    )
    _remember(
        session, idempotency_key, endpoint, request_hash, status.HTTP_200_OK,
        response.model_dump_json(),
    )  # fmt: skip
    session.commit()
    if outcome is not None:
        publish_confirmation(current, outcome)
    return response


_PAGE = """<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title>
<style>body{{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;
text-align:center;color:#1f2933}}h1{{font-size:1.4rem}}p{{color:#52606d}}</style></head>
<body><h1>{title}</h1><p>{message}</p></body></html>"""


def _page(title: str, message: str, code: int = 200) -> HTMLResponse:
    return HTMLResponse(
        _PAGE.format(title=html.escape(title), message=html.escape(message)), status_code=code
    )


@router.get("/payments/vnpay/return", response_class=HTMLResponse, include_in_schema=True)
def vnpay_return(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    """Trình duyệt khách quay về sau trang VNPay. Kiểm chữ ký, hỏi lại VNPay (QueryDR), ghi kết
    quả, trả trang HTML chỉ có kết quả và số tiền (không lộ đơn, khách)."""
    params = dict(request.query_params)
    if not vnpay.is_configured() or not vnpay.verify_signature(params):
        return _page("Liên kết không hợp lệ", "Vui lòng báo nhân viên thu ngân.", 400)
    payment = _find_by_txn_ref(session, params.get("vnp_TxnRef"))
    if payment is None:
        return _page("Liên kết không hợp lệ", "Vui lòng báo nhân viên thu ngân.", 400)

    result = query_payment(payment)
    if result.status == vnpay.ERROR:
        return _page(
            "Chưa xác nhận được kết quả",
            "Hệ thống chưa liên lạc được VNPay. Vui lòng báo thu ngân bấm “Kiểm tra lại”.",
        )
    actor = system_actor(payment)
    outcome = confirm_vnpay_payment(session, payment.id, result, "return", actor)
    session.commit()
    publish_confirmation(actor, outcome)
    amount = f"{Decimal(outcome.payment.amount):,.0f}đ".replace(",", ".")
    if outcome.payment.status == "SUCCEEDED":
        return _page("Thanh toán thành công", f"Đã nhận {amount}. Cảm ơn quý khách!")
    if outcome.payment.status == "UNKNOWN":
        return _page("Đang chờ xác nhận", "Vui lòng báo nhân viên thu ngân kiểm tra giúp.")
    return _page("Thanh toán chưa hoàn tất", f"Khoản {amount} chưa được thanh toán.")


@router.get("/payments/vnpay/ipn", include_in_schema=True)
def vnpay_ipn(request: Request, session: Session = Depends(get_session)) -> JSONResponse:
    """VNPay gọi vào báo kết quả. Trả RspCode theo tài liệu VNPay (research.md R-4). Tắt mặc
    định (VNPAY_IPN_ENABLED=false) vì cần HTTPS: khi tắt luôn trả 99 để VNPay gửi lại sau."""

    def reply(code: str, message: str) -> JSONResponse:
        return JSONResponse({"RspCode": code, "Message": message})

    if not config.VNPAY_IPN_ENABLED or not vnpay.is_configured():
        return reply("99", "IPN disabled")
    params = dict(request.query_params)
    if not vnpay.verify_signature(params):
        return reply("97", "Invalid signature")
    payment = _find_by_txn_ref(session, params.get("vnp_TxnRef"))
    if payment is None:
        return reply("01", "Order not found")
    result = vnpay.result_from_params(params)
    if result.amount is None or result.amount != Decimal(payment.amount):
        return reply("04", "Invalid amount")
    if payment.status in FINAL_STATUSES or (
        payment.status == "UNKNOWN" and payment.provider_txn_no
    ):
        return reply("02", "Order already confirmed")
    actor = system_actor(payment)
    outcome = confirm_vnpay_payment(session, payment.id, result, "ipn", actor)
    session.commit()
    publish_confirmation(actor, outcome)
    return reply("00", "Confirm Success")

