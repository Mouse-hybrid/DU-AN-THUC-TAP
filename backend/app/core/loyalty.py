"""Nghiệp vụ điểm thưởng dùng chung. Mọi thay đổi điểm đi qua add_points để số dư và sổ
điểm luôn khớp."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import ROUND_FLOOR, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Customer, LoyaltyRule, Order, PointsLedger


def current_rule(session: Session, outlet_id: uuid.UUID) -> LoyaltyRule | None:
    return session.scalars(
        select(LoyaltyRule)
        .where(LoyaltyRule.outlet_id == outlet_id)
        .order_by(LoyaltyRule.version.desc())
        .limit(1)
    ).first()


def lock_customer(session: Session, customer_id: uuid.UUID) -> Customer | None:
    """Khóa dòng khách tới hết transaction: hai giao dịch điểm đồng thời chạy lần lượt,
    không ghi đè số dư của nhau. Đọc lại vì đối tượng có thể đang giữ số dư cũ."""
    return session.execute(
        select(Customer)
        .where(Customer.id == customer_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()


def add_points(
    session: Session,
    customer: Customer,
    *,
    entry_type: str,
    points: int,
    order_id: uuid.UUID | None = None,
    rule_version: int | None = None,
    reason: str | None = None,
    staff_id: uuid.UUID | None = None,
    expires_at: datetime | None = None,
) -> PointsLedger:
    """Người gọi phải giữ khóa từ lock_customer và đã kiểm tra số dư đủ."""
    customer.points_balance += points
    entry = PointsLedger(
        customer_id=customer.id,
        entry_type=entry_type,
        points=points,
        balance_after=customer.points_balance,
        order_id=order_id,
        rule_version=rule_version,
        reason=reason,
        staff_id=staff_id,
        expires_at=expires_at,
    )
    session.add(entry)
    return entry


def order_payable_amount(order: Order) -> Decimal:
    return sum(
        (
            Decimal(item.unit_price) * item.quantity
            for item in order.items
            if item.status != "VOIDED"
        ),
        Decimal("0"),
    )


def earn_points_for_order(
    session: Session, order: Order, outlet_id: uuid.UUID, staff_id: uuid.UUID
) -> PointsLedger | None:
    """Tích điểm khi thanh toán, trong cùng transaction với việc chuyển đơn sang PAID. Đơn
    không gắn khách, khách bị khóa, chưa có luật hoặc chưa đủ tiền cho 1 điểm thì bỏ qua."""
    if order.customer_id is None:
        return None
    rule = current_rule(session, outlet_id)
    if rule is None:
        return None
    customer = lock_customer(session, order.customer_id)
    if customer is None or not customer.is_active:
        return None
    points = int(
        (order_payable_amount(order) / Decimal(rule.earn_amount_per_point)).to_integral_value(
            rounding=ROUND_FLOOR
        )
    )
    if points <= 0:
        return None
    expires_at = (
        datetime.now(timezone.utc) + timedelta(days=rule.points_expire_days)
        if rule.points_expire_days
        else None
    )
    return add_points(
        session,
        customer,
        entry_type="EARN",
        points=points,
        order_id=order.id,
        rule_version=rule.version,
        staff_id=staff_id,
        expires_at=expires_at,
    )
