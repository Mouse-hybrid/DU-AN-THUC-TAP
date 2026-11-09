"""Cộng tiền đã nhận của 1 đơn. Dùng chung cho API thanh toán, /pay và chi tiết đơn."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Payment

# Tiền đã vào tay quán: lần đã hoàn hết (REFUNDED) vẫn tính là đã thu, phần hoàn ghi riêng.
COLLECTED_STATUSES = ("SUCCEEDED", "REFUNDED")


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
