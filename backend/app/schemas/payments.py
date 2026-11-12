from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Money = Decimal


class CreatePaymentRequest(BaseModel):
    """Một lần nhận tiền. `amount` bỏ trống = trả hết số còn lại. Tiền mặt: `cash_received` là
    số khách đưa (bỏ trống = đưa vừa đủ), server tính tiền thối. Thẻ: thu ngân xác nhận máy
    POS đã quẹt thành công, `provider_ref` là số hóa đơn trên máy (nếu có). VNPay: trả lần
    thanh toán PENDING kèm `payment_url`; đơn đã có link còn hạn thì trả lại link đó."""

    model_config = ConfigDict(extra="forbid")

    method: Literal["CASH", "CARD", "VNPAY"]
    amount: Money | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    cash_received: Money | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    provider_ref: str | None = Field(default=None, min_length=1, max_length=100)
    note: str | None = Field(default=None, max_length=500)


class CancelPaymentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=3, max_length=500)


class RefundPaymentRequest(BaseModel):
    """`amount` bỏ trống = hoàn hết phần chưa hoàn của lần thanh toán này."""

    model_config = ConfigDict(extra="forbid")

    amount: Money | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    reason: str = Field(min_length=3, max_length=500)


class PaymentRefundOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    amount: Money
    reason: str
    created_by_staff_id: uuid.UUID | None = None
    created_at: datetime


class PaymentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    order_id: uuid.UUID
    method: str
    amount: Money
    status: str
    refunded_amount: Money
    cash_received: Money | None = None
    change_due: Money | None = None
    provider_ref: str | None = None
    note: str | None = None
    created_by_staff_id: uuid.UUID | None = None
    cancelled_by_staff_id: uuid.UUID | None = None
    cancel_reason: str | None = None
    # VNPay: link cho khách mở (hiện thành mã QR), hạn link, kết quả phía VNPay.
    payment_url: str | None = None
    expires_at: datetime | None = None
    provider_txn_no: str | None = None
    provider_code: str | None = None
    provider_paid_at: datetime | None = None
    created_at: datetime
    refunds: list[PaymentRefundOut] = []


class PaymentSummaryOut(BaseModel):
    """`total` = số phải trả của đơn (đã trừ ưu đãi). `paid` = tổng các lần đã nhận (không tính
    lần đã hủy). `refunded` = đã hoàn lại cho khách. `remaining` = còn phải thu (0 khi đã đủ).
    `pending` = đang chờ khách trả qua VNPay (link còn hạn), đã nằm trong `remaining`."""

    total: Money
    paid: Money
    refunded: Money
    remaining: Money
    pending: Money = Decimal("0")


class OrderPaymentsOut(BaseModel):
    order_id: uuid.UUID
    order_status: str
    summary: PaymentSummaryOut
    payments: list[PaymentOut]


class PaymentRecordedOut(BaseModel):
    """Kết quả 1 lần nhận tiền. `order_status` = PAID khi lần này trả đủ."""

    payment: PaymentOut
    order_status: str
    summary: PaymentSummaryOut
