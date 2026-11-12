"""Rewards đợt 1 (Key Focus BRD): khách hàng, luật điểm, sổ điểm.

Cashier, Supervisor (CUSTOMER_ACCESS, có dữ liệu cá nhân nên không mở cho role khác):
GET  /api/v1/customers?phone=          — tra đúng số điện thoại. Không truyền phone: chỉ Supervisor.
POST /api/v1/customers                 — tạo khách, bắt buộc `consent: true`.
GET  /api/v1/customers/{id}            — thông tin và số dư.
GET  /api/v1/customers/{id}/points     — lịch sử điểm, mới nhất trước.

Supervisor (LOYALTY_MANAGE):
PATCH /api/v1/customers/{id}               — sửa tên, khóa khách.
POST  /api/v1/customers/{id}/points/adjust — điều chỉnh điểm, bắt buộc lý do.
GET/POST /api/v1/loyalty-rules             — xem và tạo phiên bản luật mới.
POST/PATCH /api/v1/rewards                 — tạo, sửa, tắt ưu đãi.

GET /api/v1/rewards và GET /api/v1/customers/{id}/reward-usage: Cashier, Supervisor.

Gắn khách và áp ưu đãi vào đơn ở orders.py. Điểm được trừ và tích khi thanh toán. Audit log
chỉ ghi id khách, không ghi số điện thoại.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.loyalty import add_points, current_rule, lock_customer
from app.core.permissions import Permission
from app.core.rbac import role_has
from app.db.base import get_session
from app.db.models import (
    Customer,
    IdempotencyKey,
    LoyaltyRule,
    OrderReward,
    PointsLedger,
    Reward,
)
from app.schemas.rewards import (
    CustomerCreate,
    CustomerOut,
    CustomerUpdate,
    LoyaltyRuleCreate,
    LoyaltyRuleOut,
    PointsAdjustRequest,
    PointsEntryOut,
    RewardCreate,
    RewardOut,
    RewardUpdate,
    RewardUsageOut,
    normalize_phone,
)

customers_router = APIRouter(prefix="/customers", tags=["rewards"])
rules_router = APIRouter(prefix="/loyalty-rules", tags=["rewards"])
rewards_router = APIRouter(prefix="/rewards", tags=["rewards"])


def _customer_or_404(session: Session, customer_id: uuid.UUID, outlet_id: uuid.UUID) -> Customer:
    customer = session.get(Customer, customer_id)
    if customer is None or customer.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy khách hàng")
    return customer


def _remember(session: Session, key: str, endpoint: str, request_hash: str, body: str) -> None:
    session.add(
        IdempotencyKey(
            key=key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_201_CREATED,
            response_body=body,
        )
    )


@customers_router.get("", response_model=list[CustomerOut])
def list_customers(
    phone: str | None = Query(default=None, max_length=20),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current: CurrentStaff = Depends(require_permission(Permission.CUSTOMER_ACCESS)),
    session: Session = Depends(get_session),
) -> list[CustomerOut]:
    """Thu ngân chỉ tra được đúng 1 số, không xem được cả danh sách khách (RW-015)."""
    stmt = select(Customer).where(Customer.outlet_id == current.outlet_id)
    if phone is None:
        if not role_has(session, current.outlet_id, current.role, Permission.LOYALTY_MANAGE):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, detail="Cần số điện thoại để tra cứu khách hàng"
            )
    else:
        try:
            stmt = stmt.where(Customer.phone == normalize_phone(phone))
        except ValueError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    stmt = stmt.order_by(Customer.created_at.desc(), Customer.id).limit(limit).offset(offset)
    return [CustomerOut.model_validate(c) for c in session.scalars(stmt).all()]


@customers_router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(
    payload: CustomerCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.CUSTOMER_ACCESS)),
    session: Session = Depends(get_session),
) -> CustomerOut:
    endpoint = "POST /api/v1/customers"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        return CustomerOut.model_validate_json(existing.response_body)

    phone_taken = HTTPException(status.HTTP_409_CONFLICT, detail="Số điện thoại đã có khách hàng")
    duplicate = session.execute(
        select(Customer.id).where(
            Customer.outlet_id == current.outlet_id, Customer.phone == payload.phone
        )
    ).first()
    if duplicate:
        raise phone_taken

    customer = Customer(
        outlet_id=current.outlet_id,
        phone=payload.phone,
        full_name=payload.full_name,
        member_code=f"M{secrets.token_hex(6).upper()}",
        consent_at=datetime.now(timezone.utc),
    )
    session.add(customer)
    try:
        session.flush()
    except IntegrityError:
        # 2 thu ngân tạo cùng 1 số đồng thời: unique constraint chặn request sau.
        session.rollback()
        raise phone_taken
    session.refresh(customer)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="CUSTOMER_CREATED",
        entity_type="customer",
        entity_id=customer.id,
    )
    result = CustomerOut.model_validate(customer)
    _remember(session, idempotency_key, endpoint, request_hash, result.model_dump_json())
    session.commit()
    return result


@customers_router.get("/{customer_id}", response_model=CustomerOut)
def get_customer(
    customer_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.CUSTOMER_ACCESS)),
    session: Session = Depends(get_session),
) -> CustomerOut:
    return CustomerOut.model_validate(_customer_or_404(session, customer_id, current.outlet_id))


@customers_router.patch("/{customer_id}", response_model=CustomerOut)
def update_customer(
    customer_id: uuid.UUID,
    payload: CustomerUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.LOYALTY_MANAGE)),
    session: Session = Depends(get_session),
) -> CustomerOut:
    """Khóa khách (`is_active: false`): không tích điểm, không gắn được vào đơn mới. Không
    có API xóa để sổ điểm vẫn đối chiếu được."""
    customer = _customer_or_404(session, customer_id, current.outlet_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes or changes.get("is_active", True) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Cần ít nhất 1 trường; is_active không được null",
        )
    for field, value in changes.items():
        setattr(customer, field, value)
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="CUSTOMER_UPDATED",
        entity_type="customer",
        entity_id=customer.id,
        payload={"fields": sorted(changes)},
    )
    session.commit()
    session.refresh(customer)
    return CustomerOut.model_validate(customer)


@customers_router.get("/{customer_id}/points", response_model=list[PointsEntryOut])
def list_points(
    customer_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current: CurrentStaff = Depends(require_permission(Permission.CUSTOMER_ACCESS)),
    session: Session = Depends(get_session),
) -> list[PointsEntryOut]:
    customer = _customer_or_404(session, customer_id, current.outlet_id)
    entries = session.scalars(
        select(PointsLedger)
        .where(PointsLedger.customer_id == customer.id)
        .order_by(PointsLedger.created_at.desc(), PointsLedger.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return [PointsEntryOut.model_validate(entry) for entry in entries]


@customers_router.post(
    "/{customer_id}/points/adjust",
    response_model=PointsEntryOut,
    status_code=status.HTTP_201_CREATED,
)
def adjust_points(
    customer_id: uuid.UUID,
    payload: PointsAdjustRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.LOYALTY_MANAGE)),
    session: Session = Depends(get_session),
) -> PointsEntryOut:
    endpoint = f"POST /api/v1/customers/{customer_id}/points/adjust"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        return PointsEntryOut.model_validate_json(existing.response_body)

    if payload.points == 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Số điểm phải khác 0")
    _customer_or_404(session, customer_id, current.outlet_id)
    customer = lock_customer(session, customer_id)
    if customer.points_balance + payload.points < 0:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Không đủ điểm để trừ")

    entry = add_points(
        session,
        customer,
        entry_type="ADJUST",
        points=payload.points,
        reason=payload.reason,
        staff_id=current.id,
    )
    session.flush()
    session.refresh(entry)
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="POINTS_ADJUSTED",
        entity_type="customer",
        entity_id=customer.id,
        payload={"points": payload.points, "reason": payload.reason},
    )
    result = PointsEntryOut.model_validate(entry)
    _remember(session, idempotency_key, endpoint, request_hash, result.model_dump_json())
    session.commit()
    return result


@customers_router.get("/{customer_id}/reward-usage", response_model=list[RewardUsageOut])
def list_reward_usage(
    customer_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current: CurrentStaff = Depends(require_permission(Permission.CUSTOMER_ACCESS)),
    session: Session = Depends(get_session),
) -> list[RewardUsageOut]:
    """Lịch sử dùng ưu đãi: chỉ các lần đã thanh toán, mới nhất trước."""
    customer = _customer_or_404(session, customer_id, current.outlet_id)
    rows = session.scalars(
        select(OrderReward)
        .where(OrderReward.customer_id == customer.id, OrderReward.status == "COMMITTED")
        .order_by(OrderReward.created_at.desc(), OrderReward.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return [RewardUsageOut.model_validate(row) for row in rows]


@rewards_router.get("", response_model=list[RewardOut])
def list_rewards(
    active_only: bool = Query(default=False, description="Chỉ trả ưu đãi đang bật"),
    current: CurrentStaff = Depends(require_permission(Permission.REWARD_APPLY)),
    session: Session = Depends(get_session),
) -> list[RewardOut]:
    stmt = select(Reward).where(Reward.outlet_id == current.outlet_id)
    if active_only:
        stmt = stmt.where(Reward.is_active.is_(True))
    return [RewardOut.model_validate(r) for r in session.scalars(stmt.order_by(Reward.name)).all()]


def _reward_name_free(
    session: Session, name: str, outlet_id: uuid.UUID, exclude_id: uuid.UUID | None = None
) -> None:
    stmt = select(Reward.id).where(Reward.outlet_id == outlet_id, Reward.name == name)
    if exclude_id is not None:
        stmt = stmt.where(Reward.id != exclude_id)
    if session.execute(stmt).first() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"Ưu đãi '{name}' đã tồn tại")


@rewards_router.post("", response_model=RewardOut, status_code=status.HTTP_201_CREATED)
def create_reward(
    payload: RewardCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.LOYALTY_MANAGE)),
    session: Session = Depends(get_session),
) -> RewardOut:
    endpoint = "POST /api/v1/rewards"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        return RewardOut.model_validate_json(existing.response_body)

    _reward_name_free(session, payload.name, current.outlet_id)
    reward = Reward(outlet_id=current.outlet_id, **payload.model_dump())
    session.add(reward)
    session.flush()
    session.refresh(reward)
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="REWARD_CREATED",
        entity_type="reward",
        entity_id=reward.id,
        payload=payload.model_dump(mode="json"),
    )
    result = RewardOut.model_validate(reward)
    _remember(session, idempotency_key, endpoint, request_hash, result.model_dump_json())
    session.commit()
    return result


@rewards_router.patch("/{reward_id}", response_model=RewardOut)
def update_reward(
    reward_id: uuid.UUID,
    payload: RewardUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.LOYALTY_MANAGE)),
    session: Session = Depends(get_session),
) -> RewardOut:
    """Không có API xóa, tắt bằng `is_active: false`. Gửi null cho max_discount, valid_from,
    valid_to, max_uses để bỏ giới hạn đó."""
    reward = session.get(Reward, reward_id)
    if reward is None or reward.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy ưu đãi")
    changes = payload.model_dump(exclude_unset=True)
    required = ("name", "min_order_amount", "is_active", "value")
    if not changes or any(key in changes and changes[key] is None for key in required):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Cần ít nhất 1 trường; name, value, min_order_amount, is_active không được null",
        )
    if "value" in changes and reward.reward_type == "POINTS":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Ưu đãi đổi điểm không có value"
        )
    if "value" in changes and reward.reward_type == "PERCENT" and changes["value"] > 100:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Phần trăm không được quá 100"
        )
    valid_from = changes.get("valid_from", reward.valid_from)
    valid_to = changes.get("valid_to", reward.valid_to)
    if valid_from and valid_to:
        start = valid_from if valid_from.tzinfo else valid_from.replace(tzinfo=timezone.utc)
        end = valid_to if valid_to.tzinfo else valid_to.replace(tzinfo=timezone.utc)
        if start >= end:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, detail="valid_from phải trước valid_to"
            )
    if "name" in changes:
        _reward_name_free(session, changes["name"], current.outlet_id, exclude_id=reward.id)

    for field, value in changes.items():
        setattr(reward, field, value)
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="REWARD_UPDATED",
        entity_type="reward",
        entity_id=reward.id,
        payload=payload.model_dump(mode="json", exclude_unset=True),
    )
    session.commit()
    session.refresh(reward)
    return RewardOut.model_validate(reward)


@rules_router.get("", response_model=list[LoyaltyRuleOut])
def list_rules(
    current: CurrentStaff = Depends(require_permission(Permission.LOYALTY_MANAGE)),
    session: Session = Depends(get_session),
) -> list[LoyaltyRuleOut]:
    """Phiên bản mới nhất đứng đầu và là luật đang áp dụng."""
    rules = session.scalars(
        select(LoyaltyRule)
        .where(LoyaltyRule.outlet_id == current.outlet_id)
        .order_by(LoyaltyRule.version.desc())
    ).all()
    return [LoyaltyRuleOut.model_validate(rule) for rule in rules]


@rules_router.post("", response_model=LoyaltyRuleOut, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: LoyaltyRuleCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.LOYALTY_MANAGE)),
    session: Session = Depends(get_session),
) -> LoyaltyRuleOut:
    """Không sửa luật cũ: tạo phiên bản mới, sổ điểm vẫn biết từng lần tích dùng luật nào."""
    endpoint = "POST /api/v1/loyalty-rules"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        return LoyaltyRuleOut.model_validate_json(existing.response_body)

    latest = current_rule(session, current.outlet_id)
    rule = LoyaltyRule(
        outlet_id=current.outlet_id,
        version=(latest.version + 1) if latest else 1,
        created_by_staff_id=current.id,
        **payload.model_dump(),
    )
    session.add(rule)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Vừa có phiên bản luật khác được tạo, hãy thử lại"
        )
    session.refresh(rule)
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="LOYALTY_RULE_CREATED",
        entity_type="loyalty_rule",
        entity_id=rule.id,
        payload={"version": rule.version, **payload.model_dump(mode="json")},
    )
    result = LoyaltyRuleOut.model_validate(rule)
    _remember(session, idempotency_key, endpoint, request_hash, result.model_dump_json())
    session.commit()
    return result
