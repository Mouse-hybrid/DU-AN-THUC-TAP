"""Cộng tiền đã nhận của 1 đơn. Dùng chung cho API thanh toán, /pay và chi tiết đơn."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Payment

# Tiền đã vào tay quán: lần đã hoàn hết (REFUNDED) vẫn tính là đã thu, phần hoàn ghi riêng.
COLLECTED_STATUSES = ("SUCCEEDED", "REFUNDED")
# Lần VNPay chưa có kết quả: chưa tính là đã thu, nhưng còn hạn link thì giữ chỗ số tiền để
# không phát hai link (hoặc thu tiền mặt) cho cùng một khoản.
WAITING_STATUSES = ("PENDING", "UNKNOWN")


@dataclass(frozen=True)
class PaymentTotals:
    paid: Decimal
    refunded: Decimal

    def remaining(self, total: Decimal) -> Decimal:
        return max(total - self.paid, Decimal("0"))


def order_payments(
    session: Session, order_id: uuid.UUID, *, for_update: bool = False
) -> list[Payment]:
    stmt = select(Payment).where(Payment.order_id == order_id).order_by(Payment.created_at)
    if for_update:
        stmt = stmt.with_for_update()
    return list(session.scalars(stmt))


def payment_totals(payments: list[Payment]) -> PaymentTotals:
    collected = [p for p in payments if p.status in COLLECTED_STATUSES]
    return PaymentTotals(
        paid=sum((Decimal(p.amount) for p in collected), Decimal("0")),
        refunded=sum((Decimal(p.refunded_amount) for p in collected), Decimal("0")),
    )


def has_collected_payment(session: Session, order_id: uuid.UUID) -> bool:
    return (
        session.scalar(
            select(Payment.id)
            .where(Payment.order_id == order_id, Payment.status.in_(COLLECTED_STATUSES))
            .limit(1)
        )
        is not None
    )


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:  # SQLite trả datetime naive (UTC)
        return value.replace(tzinfo=timezone.utc)
    return value


def is_waiting(payment: Payment, now: datetime) -> bool:
    """Đang chờ kết quả VNPay và link còn hạn. UNKNOWN (quá hạn mà chưa hỏi được VNPay) không
    giữ chỗ nữa, để thu ngân thu cách khác; nếu VNPay sau đó báo đã trả thì ghi audit hoàn tay."""
    expires_at = _aware(payment.expires_at)
    return payment.status == "PENDING" and (expires_at is None or expires_at > now)


def reserved_amount(payments: list[Payment], now: datetime) -> Decimal:
    return sum((Decimal(p.amount) for p in payments if is_waiting(p, now)), Decimal("0"))


def active_vnpay_link(payments: list[Payment], now: datetime) -> Payment | None:
    return next((p for p in payments if p.method == "VNPAY" and is_waiting(p, now)), None)
