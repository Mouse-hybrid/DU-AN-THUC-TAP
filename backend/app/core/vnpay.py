"""Tích hợp VNPay phiên bản 2.1.0 (SDD R2, specs/001-vnpay-sandbox): tạo link thanh toán có chữ
ký, kiểm chữ ký dữ liệu VNPay gửi về, tra cứu giao dịch (QueryDR).

Tham số và cách ký theo tài liệu tích hợp VNPay mà nhóm đã đọc (research.md R-2, R-3). Chuỗi
ký của QueryDR **phải đối chiếu lại** với tài liệu VNPay gửi kèm tài khoản sandbox trước khi
chạy thật; test tự động chỉ kiểm được tính nhất quán (ký rồi kiểm lại được, sửa một ký tự là
hỏng), không kiểm được việc khớp với máy chủ VNPay.

Không ghi `vnp_SecureHash`, khóa hay toàn bộ query ra log.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import quote_plus

import httpx

from app.core import config

logger = logging.getLogger("app.vnpay")

VN_TZ = timezone(timedelta(hours=7))
VERSION = "2.1.0"

# Cho test thay bằng httpx.MockTransport; None = gọi mạng thật.
HTTP_TRANSPORT: httpx.BaseTransport | None = None


class VnpayNotConfigured(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(config.VNPAY_TMN_CODE and config.VNPAY_HASH_SECRET and config.VNPAY_RETURN_URL)


def _secret() -> bytes:
    if not is_configured():
        raise VnpayNotConfigured("VNPay chưa được cấu hình")
    return config.VNPAY_HASH_SECRET.encode()


def _hmac(data: str) -> str:
    return hmac.new(_secret(), data.encode(), hashlib.sha512).hexdigest()


def vn_time(value: datetime) -> str:
    """yyyyMMddHHmmss theo giờ Việt Nam, như VNPay yêu cầu."""
    return value.astimezone(VN_TZ).strftime("%Y%m%d%H%M%S")


def parse_vn_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=VN_TZ)
    except ValueError:
        return None


def _query_string(params: dict[str, str]) -> str:
    """Sắp theo tên tham số, URL-encode giá trị (dấu cách thành '+'), nối bằng '&'. Chuỗi này
    vừa là chuỗi ký vừa là query của link."""
    return "&".join(
        f"{key}={quote_plus(str(value))}"
        for key, value in sorted(params.items())
        if value not in (None, "")
    )


def txn_ref(payment_id: uuid.UUID) -> str:
    return payment_id.hex


def build_payment_url(
    payment_id: uuid.UUID,
    amount: Decimal,
    order_info: str,
    ip_addr: str,
    created_at: datetime,
) -> tuple[str, str, datetime]:
    """Trả (link, vnp_CreateDate, hạn link)."""
    expires_at = created_at + timedelta(minutes=config.VNPAY_LINK_TTL_MINUTES)
    create_date = vn_time(created_at)
    params = {
        "vnp_Version": VERSION,
        "vnp_Command": "pay",
        "vnp_TmnCode": config.VNPAY_TMN_CODE,
        "vnp_Amount": str(int(Decimal(amount) * 100)),
        "vnp_CurrCode": "VND",
        "vnp_TxnRef": txn_ref(payment_id),
        "vnp_OrderInfo": order_info,
        "vnp_OrderType": "other",
        "vnp_Locale": "vn",
        "vnp_ReturnUrl": config.VNPAY_RETURN_URL,
        "vnp_IpAddr": ip_addr or "127.0.0.1",
        "vnp_CreateDate": create_date,
        "vnp_ExpireDate": vn_time(expires_at),
    }
    query = _query_string(params)
    url = f"{config.VNPAY_PAY_URL}?{query}&vnp_SecureHash={_hmac(query)}"
    return url, create_date, expires_at


def verify_signature(params: dict[str, str]) -> bool:
    """Kiểm chữ ký dữ liệu VNPay gửi về (Return URL, IPN): ký lại các tham số vnp_* trừ
    vnp_SecureHash, vnp_SecureHashType rồi so bằng compare_digest."""
    received = params.get("vnp_SecureHash", "")
    data = {
        k: v
        for k, v in params.items()
        if k.startswith("vnp_") and k not in ("vnp_SecureHash", "vnp_SecureHashType")
    }
    if not received or not data:
        return False
    return hmac.compare_digest(_hmac(_query_string(data)).lower(), received.lower())


# --- Kết quả giao dịch ---------------------------------------------------------

PAID = "PAID"
FAILED = "FAILED"
PENDING = "PENDING"  # VNPay: chưa hoàn tất (khách chưa trả xong)
NOT_FOUND = "NOT_FOUND"  # VNPay không có giao dịch này (khách chưa mở link / bỏ ngang)
ERROR = "ERROR"  # không hỏi được VNPay: mạng, quá thời gian chờ, chữ ký phản hồi sai


@dataclass(frozen=True)
class VnpayResult:
    status: str
    amount: Decimal | None = None
    txn_no: str | None = None
    paid_at: datetime | None = None
    code: str | None = None


def result_from_params(params: dict[str, str]) -> VnpayResult:
    """Đọc kết quả từ dữ liệu VNPay gửi về (IPN, Return URL) — chỉ dùng sau khi đã kiểm chữ ký.
    Thành công khi vnp_ResponseCode = 00 và vnp_TransactionStatus = 00."""
    response_code = params.get("vnp_ResponseCode")
    txn_status = params.get("vnp_TransactionStatus", response_code)
    amount = params.get("vnp_Amount")
    paid = response_code == "00" and txn_status == "00"
    return VnpayResult(
        status=PAID if paid else FAILED,
        amount=Decimal(amount) / 100 if amount and amount.isdigit() else None,
        txn_no=params.get("vnp_TransactionNo"),
        paid_at=parse_vn_time(params.get("vnp_PayDate")),
        code=txn_status or response_code,
    )


def query_transaction(
    payment_id: uuid.UUID, create_date: str, order_info: str, ip_addr: str = "127.0.0.1"
) -> VnpayResult:
    """QueryDR: hỏi VNPay trạng thái giao dịch. Mọi lỗi (mạng, quá thời gian chờ, phản hồi
    sai chữ ký) trả ERROR, không ném lỗi, để người gọi giữ nguyên trạng thái."""
    now = datetime.now(timezone.utc)
    body = {
        "vnp_RequestId": uuid.uuid4().hex,
        "vnp_Version": VERSION,
        "vnp_Command": "querydr",
        "vnp_TmnCode": config.VNPAY_TMN_CODE,
        "vnp_TxnRef": txn_ref(payment_id),
        "vnp_OrderInfo": order_info,
        "vnp_TransactionDate": create_date,
        "vnp_CreateDate": vn_time(now),
        "vnp_IpAddr": ip_addr,
    }
    # Thứ tự trường của chuỗi ký QueryDR (cần đối chiếu tài liệu VNPay, research.md R-3).
    sign_fields = (
        "vnp_RequestId", "vnp_Version", "vnp_Command", "vnp_TmnCode", "vnp_TxnRef",
        "vnp_TransactionDate", "vnp_CreateDate", "vnp_IpAddr", "vnp_OrderInfo",
    )  # fmt: skip
    body["vnp_SecureHash"] = _hmac("|".join(body[f] for f in sign_fields))
    try:
        with httpx.Client(
            transport=HTTP_TRANSPORT, timeout=config.VNPAY_TIMEOUT_SECONDS
        ) as client:
            response = client.post(config.VNPAY_API_URL, json=body)
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("QueryDR lỗi: %s", type(exc).__name__)
        return VnpayResult(ERROR)

    response_code = str(data.get("vnp_ResponseCode") or "")
    if response_code and "vnp_SecureHash" not in data:
        # VNPay từ chối yêu cầu: phản hồi lỗi không có chữ ký (vd sandbox 12/11: "99 Unexpected
        # error" cho mọi QueryDR). Không phải lệch chữ ký.
        logger.warning(
            "QueryDR: VNPay trả mã lỗi",
            extra={
                "fields": {
                    "vnp_response_code": response_code,
                    "vnp_message": str(data.get("vnp_Message") or "")[:200],
                }
            },
        )
        return VnpayResult(ERROR, code=response_code)
    if not _querydr_response_valid(data):
        # Không ghi giá trị (có số tiền, mã giao dịch); chỉ tên trường và kiểu để đối chiếu.
        logger.warning(
            "QueryDR: chữ ký phản hồi không khớp, bỏ qua kết quả",
            extra={
                "fields": {
                    "vnp_response_code": response_code,
                    "vnp_message": str(data.get("vnp_Message") or "")[:200],
                    "response_shape": {k: type(v).__name__ for k, v in data.items()},
                }
            },
        )
        return VnpayResult(ERROR, code=response_code or None)
    if response_code == "91":
        return VnpayResult(NOT_FOUND, code=response_code)
    if response_code != "00":
        logger.warning(
            "QueryDR: VNPay trả mã lỗi",
            extra={
                "fields": {
                    "vnp_response_code": response_code,
                    "vnp_message": str(data.get("vnp_Message") or "")[:200],
                }
            },
        )
        return VnpayResult(ERROR, code=response_code)
    # VNPay có thể trả số thay vì chuỗi: đưa hết về chữ trước khi so và lưu.
    txn_status = _text(data.get("vnp_TransactionStatus"), "")
    if txn_status.isdigit():
        txn_status = txn_status.zfill(2)  # 0 → "00"; thiếu trường thì giữ rỗng (không phải đã trả)
    status = {"00": PAID, "01": PENDING}.get(txn_status, FAILED)
    amount = _text(data.get("vnp_Amount"), "")
    txn_no = _text(data.get("vnp_TransactionNo"), "")
    return VnpayResult(
        status=status,
        amount=Decimal(amount) / 100 if amount.isdigit() else None,
        txn_no=txn_no or None,
        paid_at=parse_vn_time(_text(data.get("vnp_PayDate"), "")),
        code=txn_status,
    )


# Thứ tự trường của chuỗi ký phản hồi QueryDR (cần đối chiếu tài liệu VNPay).
_QUERYDR_RESPONSE_FIELDS = (
    "vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode",
    "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo",
    "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode",
    "vnp_PromotionAmount",
)  # fmt: skip


def _text(value, null_as: str) -> str:
    """Giá trị → chữ như VNPay ký: trường thiếu = rỗng; số giữ nguyên (0 → "0", không bị coi
    là rỗng); null theo `null_as`."""
    if value is None:
        return null_as
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def _querydr_response_data(data: dict, null_as: str = "") -> str:
    return "|".join(
        _text(data[f], null_as) if f in data else "" for f in _QUERYDR_RESPONSE_FIELDS
    )


def _querydr_response_valid(data: dict) -> bool:
    """So chữ ký phản hồi QueryDR. Tài liệu VNPay không nói trường null ghép thành gì, nên
    thử cả "" và "null"; mỗi cách vẫn phải khớp HMAC bằng khóa bí mật."""
    received = str(data.get("vnp_SecureHash") or "").lower()
    if not received:
        return False
    return any(
        hmac.compare_digest(_hmac(_querydr_response_data(data, null_as)).lower(), received)
        for null_as in ("", "null")
    )


def sign_querydr_response(data: dict, null_as: str = "") -> str:
    """Dùng trong test để giả lập phản hồi QueryDR hợp lệ."""
    return _hmac(_querydr_response_data(data, null_as))


def sign_params(params: dict[str, str]) -> str:
    """Dùng trong test để giả lập dữ liệu VNPay gửi về (Return URL, IPN)."""
    return _hmac(_query_string(params))
