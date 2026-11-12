"""Nghiệp vụ điểm thưởng và ưu đãi dùng chung. Mọi thay đổi điểm đi qua add_points để số dư
và sổ điểm luôn khớp. Tiền giảm luôn do server tính, API không nhận số tiền từ client."""

from __future__ import annotations

import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import ROUND_FLOOR, Decimal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Customer, LoyaltyRule, Order, OrderReward, PointsLedger, Reward

REASONS = {
    "INACTIVE": "Ưu đãi đang tắt",
    "NOT_STARTED": "Ưu đãi chưa bắt đầu",
    "EXPIRED": "Ưu đãi đã hết hạn",
    "MIN_ORDER": "Đơn chưa đạt giá trị tối thiểu",
    "USAGE_LIMIT": "Ưu đãi đã hết lượt dùng",
    "NO_CUSTOMER": "Đơn chưa gắn khách hàng",
    "CUSTOMER_LOCKED": "Khách hàng đang bị khóa",
    "NO_RULE": "Chưa có luật điểm",
    "INSUFFICIENT_POINTS": "Khách không đủ điểm",
    "ZERO_DISCOUNT": "Ưu đãi không giảm được đồng nào cho đơn này",
}


def _floor(value: Decimal) -> Decimal:
    return value.quantize(Decimal("1"), rounding=ROUND_FLOOR)


def _as_utc(value: datetime) -> datetime:
    # SQLite (test) trả datetime không có múi giờ.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def current_rule(session: Session, outlet_id: uuid.UUID) -> LoyaltyRule | None:
    return session.scalars(
        select(LoyaltyRule)
        .where(LoyaltyRule.outlet_id == outlet_id)
        .order_by(LoyaltyRule.version.desc())
        .limit(1)
    ).first()


def rule_by_version(session: Session, outlet_id: uuid.UUID, version: int) -> LoyaltyRule | None:
    return session.scalars(
        select(LoyaltyRule).where(
            LoyaltyRule.outlet_id == outlet_id, LoyaltyRule.version == version
        )
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
    # Ghi xuống ngay: lock_customer đọc lại từ DB, nếu chưa flush sẽ đè mất số dư vừa đổi.
    session.flush()
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


@dataclass(frozen=True)
class RewardEvaluation:
    reason_code: str | None = None
    discount: Decimal = Decimal("0")
    points: int = 0
    max_points: int = 0

    @property
    def eligible(self) -> bool:
        return self.reason_code is None


def evaluate_reward(
    reward: Reward,
    *,
    subtotal: Decimal,
    customer: Customer | None,
    rule: LoyaltyRule | None,
    points_requested: int | None = None,
    override: bool = False,
) -> RewardEvaluation:
    """`override`: Supervisor bỏ qua thời hạn, đơn tối thiểu, số lượt. Không bỏ qua được số
    dư điểm hay trần đổi điểm vì đó là tiền thật của khách và của nhà hàng."""
    if not reward.is_active:
        return RewardEvaluation("INACTIVE")
    if not override:
        now = datetime.now(timezone.utc)
        if reward.valid_from and _as_utc(reward.valid_from) > now:
            return RewardEvaluation("NOT_STARTED")
        if reward.valid_to and _as_utc(reward.valid_to) <= now:
            return RewardEvaluation("EXPIRED")
        if subtotal < Decimal(reward.min_order_amount):
            return RewardEvaluation("MIN_ORDER")
        if reward.max_uses is not None and reward.used_count >= reward.max_uses:
            return RewardEvaluation("USAGE_LIMIT")

    if reward.reward_type == "POINTS":
        if customer is None:
            return RewardEvaluation("NO_CUSTOMER")
        if not customer.is_active:
            return RewardEvaluation("CUSTOMER_LOCKED")
        if rule is None:
            return RewardEvaluation("NO_RULE")
        value = Decimal(rule.redeem_value_per_point)
        cap = subtotal * rule.max_redeem_percent / 100
        if reward.max_discount is not None:
            cap = min(cap, Decimal(reward.max_discount))
        max_points = int(_floor(cap / value))
        if max_points <= 0:
            return RewardEvaluation("ZERO_DISCOUNT")
        wanted = max_points if points_requested is None else points_requested
        if customer.points_balance <= 0 or (
            points_requested is not None and points_requested > customer.points_balance
        ):
            return RewardEvaluation("INSUFFICIENT_POINTS", max_points=max_points)
        points = min(wanted, max_points, customer.points_balance)
        return RewardEvaluation(discount=points * value, points=points, max_points=max_points)

    amount = (
        _floor(subtotal * Decimal(reward.value) / 100)
        if reward.reward_type == "PERCENT"
        else Decimal(reward.value)
    )
    if reward.max_discount is not None:
        amount = min(amount, Decimal(reward.max_discount))
    amount = min(amount, subtotal)
    if amount <= 0:
        return RewardEvaluation("ZERO_DISCOUNT")
    return RewardEvaluation(discount=amount)


def active_order_reward(session: Session, order_id: uuid.UUID) -> OrderReward | None:
    return session.scalars(
        select(OrderReward).where(
            OrderReward.order_id == order_id,
            # REVERSED (đơn đã hoàn hết) vẫn trả về để hóa đơn cũ giữ đúng số tiền đã giảm.
            OrderReward.status.in_(("APPLIED", "COMMITTED", "REVERSED")),
        )
    ).first()


@dataclass(frozen=True)
class OrderPricing:
    subtotal: Decimal
    discount: Decimal = Decimal("0")
    points: int = 0
    active: OrderReward | None = None
    invalid_reason: str | None = None  # ưu đãi đã áp nhưng không còn dùng được

    @property
    def total(self) -> Decimal:
        return self.subtotal - self.discount


def price_order(session: Session, order: Order) -> OrderPricing:
    """Tính khi cần thay vì lưu sẵn: mọi API đổi món đều tự được tính lại đúng (RW-017)."""
    subtotal = order_payable_amount(order)
    active = active_order_reward(session, order.id)
    if active is None:
        return OrderPricing(subtotal)
    if active.status in ("COMMITTED", "REVERSED"):
        return OrderPricing(
            subtotal,
            discount=Decimal(active.discount_amount),
            points=active.points_used,
            active=active,
        )
    outlet_id = order.table_session.table.outlet_id
    evaluation = evaluate_reward(
        active.reward,
        subtotal=subtotal,
        customer=session.get(Customer, order.customer_id) if order.customer_id else None,
        rule=(
            rule_by_version(session, outlet_id, active.rule_version)
            if active.rule_version
            else None
        ),
        points_requested=active.points_requested or None,
        override=bool(active.override_reason),
    )
    if not evaluation.eligible:
        return OrderPricing(subtotal, active=active, invalid_reason=evaluation.reason_code)
    return OrderPricing(
        subtotal, discount=evaluation.discount, points=evaluation.points, active=active
    )


def commit_order_reward(
    session: Session, order: Order, outlet_id: uuid.UUID, staff_id: uuid.UUID
) -> OrderPricing:
    """Chốt ưu đãi khi thanh toán, trong transaction của /pay: trừ điểm, tăng số lượt, lưu số
    cuối cùng. Khóa khách và ưu đãi trước khi tính, nên hai đơn đổi cùng số điểm chỉ một đơn
    thành công (RW-011). Không còn hợp lệ thì chặn thanh toán để thu ngân biết, không âm thầm
    thu thêm tiền của khách."""
    active = active_order_reward(session, order.id)
    if active is None:
        return price_order(session, order)

    customer = lock_customer(session, order.customer_id) if order.customer_id else None
    session.execute(
        select(Reward)
        .where(Reward.id == active.reward_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    pricing = price_order(session, order)
    if pricing.invalid_reason:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"{REASONS[pricing.invalid_reason]}. Hãy gỡ ưu đãi rồi thanh toán lại",
        )

    if pricing.points:
        add_points(
            session,
            customer,
            entry_type="REDEEM",
            points=-pricing.points,
            order_id=order.id,
            rule_version=active.rule_version,
            staff_id=staff_id,
        )
    active.reward.used_count += 1
    active.discount_amount = pricing.discount
    active.points_used = pricing.points
    active.status = "COMMITTED"
    return pricing


def earn_points_for_order(
    session: Session, order: Order, outlet_id: uuid.UUID, staff_id: uuid.UUID, amount: Decimal
) -> PointsLedger | None:
    """Tích điểm khi thanh toán trên số tiền thực trả (`amount`, đã trừ ưu đãi), trong cùng
    transaction với việc chuyển đơn sang PAID. Đơn không gắn khách, khách bị khóa, chưa có
    luật hoặc chưa đủ tiền cho 1 điểm thì bỏ qua."""
    if order.customer_id is None:
        return None
    rule = current_rule(session, outlet_id)
    if rule is None:
        return None
    customer = lock_customer(session, order.customer_id)
    if customer is None or not customer.is_active:
        return None
    points = int(_floor(amount / Decimal(rule.earn_amount_per_point)))
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


# ---------------------------------------------------------------------------
# Rewards đợt 3 (specs/002-rewards-dot-3)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PointsReversal:
    entry: PointsLedger | None
    redeemed_returned: int
    earned_taken: int
    shortfall: int


def reverse_order_points(
    session: Session, order: Order, staff_id: uuid.UUID
) -> PointsReversal | None:
    """Đơn được hoàn tiền hết: ghi MỘT dòng REVERSAL gộp (trả lại điểm đã đổi, thu lại điểm
    đã tích), chuyển ưu đãi đã chốt sang REVERSED và trả lại một lượt dùng. Số dư không âm:
    thu không đủ điểm tích thì phần thiếu nằm ở `shortfall` để người gọi ghi audit. Gọi lần
    hai cho cùng đơn không làm gì (ràng buộc unique (order_id, entry_type) cũng chặn)."""
    reward = session.scalars(
        select(OrderReward).where(
            OrderReward.order_id == order.id, OrderReward.status == "COMMITTED"
        )
    ).first()
    if reward is not None:
        reward.status = "REVERSED"
        locked = session.execute(
            select(Reward).where(Reward.id == reward.reward_id).with_for_update()
        ).scalar_one()
        locked.used_count = max(0, locked.used_count - 1)

    if order.customer_id is None:
        return None
    rows = {
        row.entry_type: row
        for row in session.scalars(select(PointsLedger).where(PointsLedger.order_id == order.id))
    }
    if "REVERSAL" in rows or not ({"EARN", "REDEEM"} & rows.keys()):
        return None
    redeemed = -rows["REDEEM"].points if "REDEEM" in rows else 0
    earned = rows["EARN"].points if "EARN" in rows else 0
    customer = lock_customer(session, order.customer_id)
    available = customer.points_balance + redeemed
    taken = min(earned, max(available, 0))
    entry = add_points(
        session,
        customer,
        entry_type="REVERSAL",
        points=redeemed - taken,
        order_id=order.id,
        reason=f"Hoàn tiền: trả {redeemed} điểm đổi, thu {taken} điểm tích",
        staff_id=staff_id,
    )
    return PointsReversal(entry, redeemed, taken, earned - taken)


_LEDGER_ORDER = {"REDEEM": 0, "ADJUST": 1, "EARN": 2, "REVERSAL": 3, "EXPIRE": 4}


def _consume(lots: deque, amount: int, expired_before: datetime | None = None) -> None:
    """Trừ `amount` điểm theo thứ tự lô cũ trước. `expired_before`: ưu tiên các lô đã hết hạn
    tại thời điểm đó (dòng EXPIRE chỉ trừ vào lô hết hạn)."""
    if expired_before is not None:
        for lot in lots:
            if amount <= 0:
                return
            if lot[1] is not None and lot[1] <= expired_before and lot[0] > 0:
                used = min(lot[0], amount)
                lot[0] -= used
                amount -= used
    for lot in lots:
        if amount <= 0:
            return
        used = min(lot[0], amount)
        lot[0] -= used
        amount -= used


def expiring_points(session: Session, customer: Customer, now: datetime) -> int:
    """Số điểm đã hết hạn mà chưa bị trừ, tính bằng cách duyệt lại sổ điểm theo thời gian
    (FIFO: điểm dùng trước trừ vào lô cũ nhất). Lô = [còn lại, hạn, order_id]; điểm cộng tay
    (ADJUST dương) và điểm được trả lại khi hoàn tiền không có hạn."""
    lots: deque = deque()
    earn_by_order: dict = {}
    redeem_by_order: dict = {}
    # Cùng thời điểm (vd REDEEM và EARN trong một lần thanh toán) thì xếp theo thứ tự nghiệp vụ.
    rows = sorted(
        session.scalars(select(PointsLedger).where(PointsLedger.customer_id == customer.id)),
        key=lambda r: (_as_utc(r.created_at), _LEDGER_ORDER.get(r.entry_type, 9)),
    )
    for row in rows:
        if row.entry_type == "EARN":
            lot = [row.points, _as_utc(row.expires_at) if row.expires_at else None, row.order_id]
            lots.append(lot)
            earn_by_order[row.order_id] = lot
        elif row.entry_type == "REDEEM":
            redeem_by_order[row.order_id] = -row.points
            _consume(lots, -row.points)
        elif row.entry_type == "ADJUST":
            if row.points > 0:
                lots.append([row.points, None, None])
            else:
                _consume(lots, -row.points)
        elif row.entry_type == "REVERSAL":
            returned = redeem_by_order.get(row.order_id, 0)
            taken = returned - row.points
            lot = earn_by_order.get(row.order_id)
            if lot is not None and taken > 0:
                own = min(lot[0], taken)
                lot[0] -= own
                taken -= own
            _consume(lots, taken)
            if returned:
                lots.append([returned, None, None])
        elif row.entry_type == "EXPIRE":
            _consume(lots, -row.points, expired_before=_as_utc(row.created_at))
    due = sum(lot[0] for lot in lots if lot[1] is not None and lot[1] <= now and lot[0] > 0)
    return min(due, max(customer.points_balance, 0))


def expire_points_for_customer(
    session: Session, customer_id: uuid.UUID, now: datetime
) -> PointsLedger | None:
    """Khóa khách rồi trừ phần điểm đã hết hạn. Chạy lại ngay sau đó không trừ thêm."""
    customer = lock_customer(session, customer_id)
    if customer is None:
        return None
    amount = expiring_points(session, customer, now)
    if amount <= 0:
        return None
    return add_points(
        session,
        customer,
        entry_type="EXPIRE",
        points=-amount,
        reason=f"Hết hạn điểm tích đến {now.astimezone(timezone(timedelta(hours=7))):%d/%m/%Y}",
    )
