"""Thanh toán v2 (SDD R1): một đơn trả nhiều lần, nhiều hình thức, hủy lần ghi nhầm, hoàn tiền.

POST /api/v1/orders/{order_id}/payments     — nhận 1 lần tiền (tiền mặt, thẻ); đủ tiền thì PAID
GET  /api/v1/orders/{order_id}/payments     — các lần thanh toán + tổng đã thu, còn phải thu
POST /api/v1/payments/{payment_id}/cancel   — Supervisor hủy lần ghi nhầm khi đơn chưa PAID
POST /api/v1/payments/{payment_id}/refunds  — Supervisor hoàn tiền (một phần hoặc hết) sau PAID

Mọi API ghi đều khóa dòng đơn (như /pay) nên hai thu ngân bấm cùng lúc không thu trùng
(BRD "No duplicate payment"), và cần Idempotency-Key để bấm lại không ghi 2 lần.
VNPay (R2) sẽ dùng chung bảng payment với trạng thái PENDING.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.orders import (
    _load_order_or_404,
    _publish_order_updated,
    finalize_paid_order,
    publish_order_paid,
)
from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.loyalty import REASONS, price_order
from app.core.payments import order_payments, payment_totals
from app.core.permissions import Permission
from app.db.base import get_session
from app.db.models import IdempotencyKey, Order, Payment, PaymentRefund
from app.schemas.payments import (
    CancelPaymentRequest,
    CreatePaymentRequest,
    OrderPaymentsOut,
    PaymentOut,
    PaymentRecordedOut,
    PaymentSummaryOut,
    RefundPaymentRequest,
)

router = APIRouter(tags=["payments"])

_ZERO = Decimal("0")


def _summary(session: Session, order: Order, payments: list[Payment]) -> PaymentSummaryOut:
    total = price_order(session, order).total
    totals = payment_totals(payments)
    unpaid = order.status not in ("PAID", "CLOSED")
    return PaymentSummaryOut(
        total=total,
        paid=totals.paid,
        refunded=totals.refunded,
        remaining=totals.remaining(total) if unpaid else _ZERO,
    )


def _order_payments_out(session: Session, order: Order) -> OrderPaymentsOut:
    payments = order_payments(session, order.id)
    return OrderPaymentsOut(
        order_id=order.id,
        order_status=order.status,
        summary=_summary(session, order, payments),
        payments=[PaymentOut.model_validate(p) for p in payments],
    )


def _load_payment_and_order(
    session: Session, payment_id: uuid.UUID, current: CurrentStaff
) -> tuple[Payment, Order]:
    """Khóa đơn trước rồi mới khóa dòng thanh toán, cùng thứ tự với API nhận tiền để không
    deadlock."""
    found = session.get(Payment, payment_id)
    if found is None or found.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy lần thanh toán")
    order = _load_order_or_404(session, found.order_id, current.outlet_id)
    payment = session.execute(
        select(Payment)
        .where(Payment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    return payment, order


def _replay(session: Session, key: str, endpoint: str, request_hash: str, expected: int):
    existing = get_idempotent_response(
        session, key=key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is None:
        return None
    if existing.response_status != expected:
        raise HTTPException(existing.response_status, detail=existing.response_body)
    return existing.response_body


def _remember(
    session: Session, key: str, endpoint: str, request_hash: str, code: int, body: str
) -> None:
    session.add(
        IdempotencyKey(
            key=key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=code,
            response_body=body,
        )
    )


@router.post(
    "/orders/{order_id}/payments",
    response_model=PaymentRecordedOut,
    status_code=status.HTTP_201_CREATED,
)
def create_payment(
    order_id: uuid.UUID,
    payload: CreatePaymentRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.PROCESS_PAYMENT)),
    session: Session = Depends(get_session),
) -> PaymentRecordedOut:
    """Đơn phải ở BILLING. Không nhận quá số còn phải thu; tiền khách đưa dư thì là tiền thối,
    không phải trả vượt. Lần trả đủ tiền chạy đúng logic /pay: chốt ưu đãi, tích điểm, đóng
    phiên bàn khi là đơn cuối."""
    endpoint = f"POST /api/v1/orders/{order_id}/payments"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    replay = _replay(
        session, idempotency_key, endpoint, request_hash, status.HTTP_201_CREATED
    )
    if replay is not None:
        return PaymentRecordedOut.model_validate_json(replay)

    if payload.method == "CARD" and payload.cash_received is not None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Thanh toán thẻ không có tiền khách đưa"
        )

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status != "BILLING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', phải ở BILLING mới thanh toán được",
        )
    pricing = price_order(session, order)
    if pricing.invalid_reason:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"{REASONS[pricing.invalid_reason]}. Hãy gỡ ưu đãi rồi thanh toán lại",
        )
    payments = order_payments(session, order.id, for_update=True)
    remaining = payment_totals(payments).remaining(pricing.total)
    if remaining <= 0:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Đơn không còn số tiền phải thu, dùng /pay để chốt đơn",
        )
    amount = payload.amount if payload.amount is not None else remaining
    if amount > remaining:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Số tiền vượt quá số còn phải thu ({remaining:,.0f}đ)",
        )

    cash_received = change_due = None
    if payload.method == "CASH":
        cash_received = payload.cash_received if payload.cash_received is not None else amount
        if cash_received < amount:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Tiền khách đưa ít hơn số tiền thanh toán",
            )
        change_due = cash_received - amount

    payment = Payment(
        order_id=order.id,
        outlet_id=current.outlet_id,
        method=payload.method,
        amount=amount,
        status="SUCCEEDED",
        cash_received=cash_received,
        change_due=change_due,
        provider_ref=payload.provider_ref,
        note=payload.note,
        created_by_staff_id=current.id,
    )
    session.add(payment)
    session.flush()
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="PAYMENT_RECORDED",
        entity_type="order",
        entity_id=order.id,
        payload={
            "payment_id": str(payment.id),
            "method": payment.method,
            "amount": amount,
            "change_due": change_due,
            "remaining_after": remaining - amount,
        },
    )

    paid = None
    if amount == remaining:
        paid = finalize_paid_order(session, order, current)

    session.refresh(payment)
    result = PaymentRecordedOut(
        payment=PaymentOut.model_validate(payment),
        order_status=order.status,
        summary=_summary(session, order, order_payments(session, order.id)),
    )
    _remember(
        session,
        idempotency_key,
        endpoint,
        request_hash,
        status.HTTP_201_CREATED,
        result.model_dump_json(),
    )
    session.commit()
    if paid is not None:
        publish_order_paid(current, order, paid)
    else:
        _publish_order_updated(current, order, "PAYMENT_RECORDED")
    return result


@router.get("/orders/{order_id}/payments", response_model=OrderPaymentsOut)
def list_order_payments(
    order_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.PROCESS_PAYMENT)),
    session: Session = Depends(get_session),
) -> OrderPaymentsOut:
    order = _load_order_or_404(session, order_id, current.outlet_id, for_update=False)
    return _order_payments_out(session, order)


@router.post("/payments/{payment_id}/cancel", response_model=OrderPaymentsOut)
def cancel_payment(
    payment_id: uuid.UUID,
    payload: CancelPaymentRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.PAYMENT_REFUND)),
    session: Session = Depends(get_session),
) -> OrderPaymentsOut:
    """Hủy lần thanh toán ghi nhầm khi đơn còn BILLING (chưa đủ tiền). Đơn đã PAID thì dùng
    hoàn tiền, vì phiên bàn đã đóng và điểm đã tích."""
    endpoint = f"POST /api/v1/payments/{payment_id}/cancel"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    replay = _replay(session, idempotency_key, endpoint, request_hash, status.HTTP_200_OK)
    if replay is not None:
        return OrderPaymentsOut.model_validate_json(replay)

    payment, order = _load_payment_and_order(session, payment_id, current)
    if order.status != "BILLING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', chỉ hủy được khi chưa trả xong",
        )
    if payment.status != "SUCCEEDED":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Lần thanh toán đang ở trạng thái '{payment.status}', không hủy được",
        )
    payment.status = "CANCELLED"
    payment.cancelled_by_staff_id = current.id
    payment.cancel_reason = payload.reason
    session.flush()
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="PAYMENT_CANCELLED",
        entity_type="order",
        entity_id=order.id,
        payload={
            "payment_id": str(payment.id),
            "method": payment.method,
            "amount": payment.amount,
            "reason": payload.reason,
        },
    )
    result = _order_payments_out(session, order)
    _remember(
        session,
        idempotency_key,
        endpoint,
        request_hash,
        status.HTTP_200_OK,
        result.model_dump_json(),
    )
    session.commit()
    _publish_order_updated(current, order, "PAYMENT_CANCELLED")
    return result


@router.post(
    "/payments/{payment_id}/refunds",
    response_model=OrderPaymentsOut,
    status_code=status.HTTP_201_CREATED,
)
def refund_payment(
    payment_id: uuid.UUID,
    payload: RefundPaymentRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.PAYMENT_REFUND)),
    session: Session = Depends(get_session),
) -> OrderPaymentsOut:
    """Hoàn tiền sau khi đơn đã PAID/CLOSED, tối đa phần chưa hoàn của lần thanh toán đó. Đơn
    giữ nguyên trạng thái; điểm đã tích không tự trừ lại (làm cùng Rewards đợt 3)."""
    endpoint = f"POST /api/v1/payments/{payment_id}/refunds"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    replay = _replay(
        session, idempotency_key, endpoint, request_hash, status.HTTP_201_CREATED
    )
    if replay is not None:
        return OrderPaymentsOut.model_validate_json(replay)

    payment, order = _load_payment_and_order(session, payment_id, current)
    if order.status not in ("PAID", "CLOSED"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Đơn chưa thanh toán xong; ghi nhầm thì hủy lần thanh toán thay vì hoàn tiền",
        )
    if payment.status != "SUCCEEDED":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Lần thanh toán đang ở trạng thái '{payment.status}', không hoàn được",
        )
    refundable = Decimal(payment.amount) - Decimal(payment.refunded_amount)
    amount = payload.amount if payload.amount is not None else refundable
    if amount > refundable:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Chỉ hoàn được tối đa {refundable:,.0f}đ cho lần thanh toán này",
        )

    session.add(
        PaymentRefund(
            payment_id=payment.id,
            order_id=order.id,
            amount=amount,
            reason=payload.reason,
            created_by_staff_id=current.id,
        )
    )
    payment.refunded_amount = Decimal(payment.refunded_amount) + amount
    if payment.refunded_amount == payment.amount:
        payment.status = "REFUNDED"
    session.flush()
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="PAYMENT_REFUNDED",
        entity_type="order",
        entity_id=order.id,
        payload={
            "payment_id": str(payment.id),
            "method": payment.method,
            "amount": amount,
            "refunded_total": payment.refunded_amount,
            "reason": payload.reason,
        },
    )
    session.expire(payment, ["refunds"])
    result = _order_payments_out(session, order)
    _remember(
        session,
        idempotency_key,
        endpoint,
        request_hash,
        status.HTTP_201_CREATED,
        result.model_dump_json(),
    )
    session.commit()
    _publish_order_updated(current, order, "PAYMENT_REFUNDED")
    return result
