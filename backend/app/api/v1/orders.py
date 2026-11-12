"""Vertical slice bước 2+3: Tạo order → Gửi bếp, + vòng đời thanh toán và
void/refire món.

GET  /api/v1/orders                             — danh sách order (lọc status/bàn/thời gian).
GET  /api/v1/orders/{order_id}                  — chi tiết order (tên món, thành tiền, bàn).
POST /api/v1/orders                             — tạo order mới cho 1 table_session đang OPEN.
POST /api/v1/orders/{order_id}/items             — thêm món vào order (snapshot giá tại thời
                                                     điểm thêm).
PATCH  /api/v1/orders/{order_id}/items/{item_id} — sửa số lượng/ghi chú món CHƯA gửi bếp.
DELETE /api/v1/orders/{order_id}/items/{item_id} — bỏ món CHƯA gửi bếp (-> VOIDED, giữ lịch sử).
POST /api/v1/orders/{order_id}/send-to-kitchen  — gửi các món đang CREATED xuống đúng
                                                     kitchen_station.
POST /api/v1/orders/{order_id}/request-billing   — SENT/SERVED -> BILLING (khách yêu cầu
                                                     thanh toán).
POST /api/v1/orders/{order_id}/pay               — BILLING -> PAID, đóng table_session, bàn
                                                     -> CLEANING.
POST /api/v1/orders/{order_id}/close             — PAID -> CLOSED (chốt sổ, kết thúc vòng
                                                     đời order).
POST /api/v1/orders/{order_id}/items/{item_id}/void   — hủy 1 món chưa phục vụ xong.
POST /api/v1/orders/{order_id}/items/{item_id}/refire — làm lại 1 món (gửi lại bếp).
POST /api/v1/orders/{order_id}/items/{item_id}/start-cooking — bếp bắt đầu nấu (BE-S1-06).
POST /api/v1/orders/{order_id}/items/{item_id}/mark-ready    — bếp làm xong, chờ lấy (BE-S1-06).
POST /api/v1/orders/{order_id}/items/{item_id}/pickup        — phục vụ lấy món từ bếp (BE-S1-06).
POST /api/v1/orders/{order_id}/items/{item_id}/served        — phục vụ đã mang ra bàn (BE-S1-06).

Toàn bộ API tạo mới/side-effect quan trọng đều bắt buộc Idempotency-Key (NFR).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session, selectinload

from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_current_staff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.loyalty import (
    REASONS,
    OrderPricing,
    active_order_reward,
    commit_order_reward,
    current_rule,
    earn_points_for_order,
    evaluate_reward,
    order_payable_amount,
    price_order,
)
from app.core.modifiers import resolve_modifiers
from app.core.payments import has_collected_payment, order_payments, payment_totals
from app.core.permissions import Permission
from app.core.rbac import role_has
from app.core.realtime import manager
from app.db.base import get_session
from app.db.models import (
    ORDER_STATUS,
    Customer,
    IdempotencyKey,
    KitchenQueue,
    LoyaltyRule,
    MenuItem,
    Order,
    OrderItem,
    OrderItemModifier,
    OrderReward,
    OrderVersion,
    Payment,
    RestaurantTable,
    Reward,
    TableSession,
)
from app.schemas.orders import (
    AddItemsRequest,
    AppliedRewardOut,
    AttachCustomerRequest,
    CreateOrderRequest,
    OrderDetailOut,
    OrderItemDetailOut,
    OrderItemModifierOut,
    OrderOut,
    OrderSummaryOut,
    PendingMemberOut,
    SendToKitchenResponse,
    SplitOrderOut,
    SplitOrderRequest,
    UpdateOrderItemRequest,
    VoidItemRequest,
)
from app.schemas.rewards import ApplyRewardRequest, EligibleRewardOut

router = APIRouter(prefix="/orders", tags=["orders"])

_CLOSED_ORDER_STATUSES = ("BILLING", "PAID", "CLOSED")
_UNPAID_ORDER_STATUSES = ("NEW", "SENT", "SERVED", "BILLING")
# Món đã rời bếp (hoặc chưa vào bếp) mới tách lẻ số lượng được; món đang ở bếp chỉ chuyển
# nguyên dòng, để số lượng trên phiếu bếp không đổi giữa chừng.
_PARTIAL_SPLIT_ITEM_STATUSES = ("CREATED", "SERVED")
_VOIDABLE_ITEM_STATUSES = ("CREATED", "SENT", "ACCEPTED", "PREPARING")
_REFIRABLE_ITEM_STATUSES = ("SERVED", "PICKED_UP")
# Món refire có phiếu bếp mới (QUEUED) và đi lại vòng nấu như món mới gửi bếp.
_STARTABLE_ITEM_STATUSES = ("SENT", "REFIRED")


def _load_order_or_404(
    session: Session, order_id: uuid.UUID, outlet_id: uuid.UUID, *, for_update: bool = True
) -> Order:
    """Mặc định KHÓA dòng order (SELECT ... FOR UPDATE) tới hết transaction: mọi API
    ghi vào cùng 1 order (gửi bếp, thêm món, thanh toán...) chạy lần lượt, request
    sau đọc trạng thái mới nhất thay vì cùng xử lý trên dữ liệu cũ (QA TC-007: 2
    lần gửi bếp đồng thời tạo phiếu bếp trùng). Chỉ API đọc mới truyền False."""
    stmt = (
        select(Order)
        .where(Order.id == order_id)
        .options(selectinload(Order.items), selectinload(Order.table_session))
    )
    if for_update:
        stmt = stmt.with_for_update()
    order = session.execute(stmt).scalar_one_or_none()
    if order is None or order.table_session.table.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy order")
    return order


def lock_order_for_payment(session: Session, order_id: uuid.UUID, outlet_id: uuid.UUID) -> Order:
    """Khóa phiên bàn TRƯỚC rồi mới khóa đơn, cho mọi API thu tiền và chốt đơn. Lần trả cuối
    còn khóa các đơn khác cùng bàn (tách đơn) để quyết định đóng phiên; nếu khóa đơn trước thì
    hai thu ngân trả hai hóa đơn tách cùng lúc sẽ chờ nhau (A giữ A chờ B, B giữ B chờ A) và
    Postgres hủy một bên. Khóa phiên trước làm hai lần trả cùng bàn chạy lần lượt."""
    session_id = session.scalar(select(Order.table_session_id).where(Order.id == order_id))
    if session_id is not None:
        session.execute(
            select(TableSession.id).where(TableSession.id == session_id).with_for_update()
        )
    return _load_order_or_404(session, order_id, outlet_id)


def _publish_order_updated(
    current: CurrentStaff, order: Order, reason: str, *, item_id: uuid.UUID | None = None
) -> None:
    """Báo kênh `tables` (màn POS, chi tiết bàn) rằng 1 order vừa đổi — gọi SAU
    commit. Event chỉ là tín hiệu: client gọi lại GET /orders/{id} hoặc
    GET /tables/{id} để lấy dữ liệu mới. Quan trọng nhất là ITEM_READY: phục vụ
    biết món đã xong để ra bếp lấy mà không phải tải lại trang."""
    manager.publish(
        current.outlet_id,
        "tables",
        "ORDER_UPDATED",
        {
            "order_id": str(order.id),
            "table_id": str(order.table_session.table_id),
            "table_session_id": str(order.table_session_id),
            "status": order.status,
            "current_version": order.current_version,
            "reason": reason,
            "item_id": str(item_id) if item_id else None,
        },
    )


def _load_order_item_or_404(
    session: Session, order_id: uuid.UUID, item_id: uuid.UUID, outlet_id: uuid.UUID
) -> tuple[Order, OrderItem]:
    order = _load_order_or_404(session, order_id, outlet_id)
    item = next((i for i in order.items if i.id == item_id), None)
    if item is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Không tìm thấy order_item trong order này"
        )
    return order, item


def _snapshot_order(order: Order) -> str:
    return json.dumps(
        {
            "order_id": str(order.id),
            "status": order.status,
            "items": [
                {
                    "id": str(item.id),
                    "menu_item_id": str(item.menu_item_id),
                    "status": item.status,
                    "quantity": item.quantity,
                    "unit_price": str(item.unit_price),
                    "note": item.note,
                    "modifiers": [
                        {"group": m.group_name, "option": m.option_name} for m in item.modifiers
                    ],
                }
                for item in order.items
            ],
        }
    )


def _applied_reward_out(pricing: OrderPricing) -> AppliedRewardOut | None:
    if pricing.active is None:
        return None
    return AppliedRewardOut(
        id=pricing.active.id,
        reward_id=pricing.active.reward_id,
        reward_name=pricing.active.reward_name,
        reward_type=pricing.active.reward_type,
        status=pricing.active.status,
        discount_amount=pricing.discount,
        points_used=pricing.points,
        invalid_reason=pricing.invalid_reason,
    )


def build_order_detail(session: Session, order: Order) -> OrderDetailOut:
    """Dùng chung cho GET /orders/{id} và GET /tables/{id} (tables.py)."""
    menu_ids = {item.menu_item_id for item in order.items}
    names = (
        dict(
            session.execute(select(MenuItem.id, MenuItem.name).where(MenuItem.id.in_(menu_ids)))
            .tuples()
            .all()
        )
        if menu_ids
        else {}
    )
    items = [
        OrderItemDetailOut(
            id=item.id,
            menu_item_id=item.menu_item_id,
            menu_item_name=names.get(item.menu_item_id, ""),
            status=item.status,
            quantity=item.quantity,
            unit_price=item.unit_price,
            note=item.note,
            source=item.source,
            modifiers=[OrderItemModifierOut.model_validate(m) for m in item.modifiers],
            line_total=item.unit_price * item.quantity,
        )
        for item in sorted(order.items, key=lambda i: i.created_at)
    ]
    table = order.table_session.table
    pricing = price_order(session, order)
    totals = payment_totals(order_payments(session, order.id))
    return OrderDetailOut(
        id=order.id,
        table_session_id=order.table_session_id,
        table_id=table.id,
        table_code=table.code,
        status=order.status,
        current_version=order.current_version,
        created_at=order.created_at,
        customer_id=order.customer_id,
        items=items,
        subtotal=pricing.subtotal,
        discount_total=pricing.discount,
        total=pricing.total,
        applied_reward=_applied_reward_out(pricing),
        amount_paid=totals.paid,
        amount_due=totals.remaining(pricing.total) if order.status in _UNPAID_ORDER_STATUSES else 0,
        has_pending_member=order.table_session.pending_member_phone is not None,
    )


@router.get("", response_model=list[OrderSummaryOut])
def list_orders(
    order_status: list[str] | None = Query(
        default=None,
        alias="status",
        description="Lọc theo trạng thái, lặp lại được: ?status=SENT&status=SERVED",
    ),
    table_id: uuid.UUID | None = Query(default=None, description="Chỉ order của 1 bàn"),
    created_from: datetime | None = Query(default=None, description="created_at >= (ISO 8601)"),
    created_to: datetime | None = Query(default=None, description="created_at < (ISO 8601)"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[OrderSummaryOut]:
    """Danh sách order của outlet, mới nhất trước. Dùng để tìm order (QA fixture,
    màn tra cứu); chi tiết từng món lấy qua GET /orders/{id}. Như GET /orders/{id},
    mọi role đã login đều xem được."""
    invalid = sorted(set(order_status or ()) - set(ORDER_STATUS))
    if invalid:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status không hợp lệ: {', '.join(invalid)}. "
            f"Chỉ nhận: {', '.join(ORDER_STATUS)}",
        )

    stmt = (
        select(Order, RestaurantTable)
        .join(TableSession, Order.table_session_id == TableSession.id)
        .join(RestaurantTable, TableSession.table_id == RestaurantTable.id)
        .where(RestaurantTable.outlet_id == current.outlet_id)
        .options(selectinload(Order.items))
        .order_by(Order.created_at.desc(), Order.id)
        .limit(limit)
        .offset(offset)
    )
    if order_status:
        stmt = stmt.where(Order.status.in_(order_status))
    if table_id is not None:
        stmt = stmt.where(RestaurantTable.id == table_id)
    if created_from is not None:
        stmt = stmt.where(Order.created_at >= created_from)
    if created_to is not None:
        stmt = stmt.where(Order.created_at < created_to)

    summaries = []
    for order, table in session.execute(stmt).all():
        active = [item for item in order.items if item.status != "VOIDED"]
        summaries.append(
            OrderSummaryOut(
                id=order.id,
                table_session_id=order.table_session_id,
                table_id=table.id,
                table_code=table.code,
                status=order.status,
                current_version=order.current_version,
                created_at=order.created_at,
                item_count=len(active),
                subtotal=sum((i.unit_price * i.quantity for i in active), Decimal("0")),
            )
        )
    return summaries


@router.get("/{order_id}", response_model=OrderDetailOut)
def get_order(
    order_id: uuid.UUID,
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> OrderDetailOut:
    """Chi tiết order (Figma screen-09 POS ordering / screen-19 order summary): FE
    tải lại order đang làm dở sau khi refresh hoặc mở từ màn chi tiết bàn. Xem
    order không bị hạn chế trong Permission Matrix — mọi role đã login."""
    order = _load_order_or_404(session, order_id, current.outlet_id, for_update=False)
    return build_order_detail(session, order)


@router.post("", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: CreateOrderRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.ORDER_WRITE)),
    session: Session = Depends(get_session),
) -> OrderOut:
    endpoint = "POST /api/v1/orders"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    # Khóa phiên bàn: tạo order chạy lần lượt với yêu cầu thanh toán/thanh toán
    # trên cùng bàn, không chen vào giữa lúc bàn đang chuyển BILLING.
    table_session = session.execute(
        select(TableSession).where(TableSession.id == payload.table_session_id).with_for_update()
    ).scalar_one_or_none()
    if table_session is None or table_session.table.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy table_session")
    if table_session.status != "OPEN":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                f"table_session đang ở trạng thái '{table_session.status}', không thể tạo order mới"
            ),
        )
    if table_session.table.status == "BILLING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Bàn đang chờ thanh toán (BILLING) — không thể tạo order mới",
        )

    order = Order(
        table_session_id=table_session.id,
        status="NEW",
        current_version=1,
        created_by_staff_id=current.id,
    )
    session.add(order)
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_CREATED",
        entity_type="order",
        entity_id=order.id,
        payload={"table_session_id": str(table_session.id)},
    )

    result = OrderOut.model_validate(order)

    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_201_CREATED,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ORDER_CREATED")
    return result


@router.post("/{order_id}/items", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def add_order_items(
    order_id: uuid.UUID,
    payload: AddItemsRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.ORDER_WRITE)),
    session: Session = Depends(get_session),
) -> OrderOut:
    endpoint = f"POST /api/v1/orders/{order_id}/items"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status in _CLOSED_ORDER_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể thêm món",
        )
    # PO chốt 12/10 (O1 = A): khách gọi thêm sau khi đã gửi bếp là chuyện thường —
    # Cashier/Waiter thêm món mới tự do rồi gửi bếp đợt sau. Món ĐÃ gửi thì vẫn
    # không sửa trực tiếp được (409, phải void/refire — Supervisor).
    _ensure_table_not_billing(order)

    for line in payload.items:
        menu_item = session.get(MenuItem, line.menu_item_id)
        if menu_item is None or menu_item.outlet_id != current.outlet_id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail=f"Không tìm thấy menu_item {line.menu_item_id}"
            )
        if not menu_item.is_available:
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail=f"Món '{menu_item.name}' hiện không khả dụng"
            )
        modifiers, modifier_total = resolve_modifiers(menu_item, line.modifier_option_ids)

        session.add(
            OrderItem(
                order_id=order.id,
                menu_item_id=menu_item.id,
                status="CREATED",
                quantity=line.quantity,
                # snapshot giá tại thời điểm order — đổi giá menu sau không ảnh hưởng order cũ
                unit_price=menu_item.price + modifier_total,
                note=line.note,
                modifiers=modifiers,
            )
        )

    order.current_version += 1
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_ITEMS_ADDED",
        entity_type="order",
        entity_id=order.id,
        payload={"items_added": len(payload.items)},
    )

    result = OrderOut.model_validate(order)

    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_201_CREATED,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEMS_ADDED")
    return result


def _ensure_table_not_billing(order: Order) -> None:
    """PO chốt 12/10 (B1 = A): bàn đang BILLING (khách đã yêu cầu thanh toán) thì
    khóa gọi thêm món — kể cả trên order khác của cùng phiên bàn."""
    if order.table_session.table.status == "BILLING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Bàn đang chờ thanh toán (BILLING) — không thể gọi thêm món",
        )


def _ensure_item_editable_before_send(order: Order, item: OrderItem, current: CurrentStaff) -> None:
    """BRD In Scope: "Order modification (before kitchen send)". Chỉ món còn CREATED
    (bếp chưa nhận) mới sửa/bỏ tự do — kể cả món gọi thêm sau khi order đã gửi bếp
    đợt trước; món đã gửi bếp phải đi qua void/refire (Supervisor)."""
    if order.status in _CLOSED_ORDER_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể sửa món",
        )
    if item.status != "CREATED":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                f"Món đang ở trạng thái '{item.status}' (đã gửi bếp) — "
                "dùng void/refire thay vì sửa trực tiếp"
            ),
        )
    _ensure_table_not_billing(order)


def _record_item_change(
    session: Session,
    order: Order,
    item: OrderItem,
    current: CurrentStaff,
    action: str,
    payload: dict,
) -> None:
    order.current_version += 1
    session.flush()
    session.refresh(order)
    session.add(
        OrderVersion(
            order_id=order.id,
            version_number=order.current_version,
            snapshot=_snapshot_order(order),
            created_by_staff_id=current.id,
        )
    )
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action=action,
        entity_type="order_item",
        entity_id=item.id,
        payload=payload,
    )


@router.patch("/{order_id}/items/{item_id}", response_model=OrderOut)
def update_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: UpdateOrderItemRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.ORDER_WRITE)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """Sửa số lượng/ghi chú của món CHƯA gửi bếp (CREATED)."""
    endpoint = f"PATCH /api/v1/orders/{order_id}/items/{item_id}"
    changes = payload.model_dump(mode="json", exclude_unset=True)
    request_hash = hash_request_body(changes)

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    _ensure_item_editable_before_send(order, item, current)

    before = {"quantity": item.quantity, "note": item.note}
    if "quantity" in changes:
        item.quantity = payload.quantity
    if "note" in changes:
        item.note = payload.note

    _record_item_change(
        session,
        order,
        item,
        current,
        action="ORDER_ITEM_UPDATED",
        payload={"before": before, "after": {"quantity": item.quantity, "note": item.note}},
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_UPDATED", item_id=item.id)
    return result


@router.delete("/{order_id}/items/{item_id}", response_model=OrderOut)
def remove_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.ORDER_WRITE)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """Bỏ món CHƯA gửi bếp (CREATED). Không xóa dòng khỏi DB — chuyển sang VOIDED
    để giữ lịch sử trong order_version/audit_log (BRD: không sửa lịch sử)."""
    endpoint = f"DELETE /api/v1/orders/{order_id}/items/{item_id}"
    request_hash = hash_request_body({"order_id": str(order_id), "item_id": str(item_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    _ensure_item_editable_before_send(order, item, current)

    item.status = "VOIDED"
    _record_item_change(
        session,
        order,
        item,
        current,
        action="ORDER_ITEM_REMOVED_BEFORE_SEND",
        payload={"quantity": item.quantity, "note": item.note},
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_REMOVED", item_id=item.id)
    return result


@router.post("/{order_id}/send-to-kitchen", response_model=SendToKitchenResponse)
def send_order_to_kitchen(
    order_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.SEND_TO_KITCHEN)),
    session: Session = Depends(get_session),
) -> SendToKitchenResponse:
    endpoint = f"POST /api/v1/orders/{order_id}/send-to-kitchen"
    # Endpoint này không có body — hash trên chính order_id để vẫn đối chiếu được nội dung.
    request_hash = hash_request_body({"order_id": str(order_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return SendToKitchenResponse.model_validate_json(existing.response_body)

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status in _CLOSED_ORDER_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể gửi bếp",
        )
    _ensure_table_not_billing(order)

    pending_items = [item for item in order.items if item.status == "CREATED"]
    if not pending_items:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Không có món nào ở trạng thái CREATED để gửi bếp"
        )

    created_count = 0
    for item in pending_items:
        menu_item = session.get(MenuItem, item.menu_item_id)
        if menu_item.station_id is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Món '{menu_item.name}' chưa được gán kitchen_station — không thể gửi bếp",
            )
        session.add(
            KitchenQueue(order_item_id=item.id, station_id=menu_item.station_id, status="QUEUED")
        )
        item.status = "SENT"
        created_count += 1

    # Món gọi thêm sau khi order đã SERVED: order lại có món đang nấu → về SENT,
    # phục vụ xong món cuối thì _maybe_mark_order_served đưa lại SERVED.
    order.status = "SENT"
    order.current_version += 1
    session.flush()
    session.refresh(order)

    session.add(
        OrderVersion(
            order_id=order.id,
            version_number=order.current_version,
            snapshot=_snapshot_order(order),
            created_by_staff_id=current.id,
        )
    )

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_SENT_TO_KITCHEN",
        entity_type="order",
        entity_id=order.id,
        payload={"items_sent": created_count},
    )

    result = SendToKitchenResponse(
        order=OrderOut.model_validate(order), kitchen_queue_entries_created=created_count
    )

    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "SENT_TO_KITCHEN")
    manager.publish(
        current.outlet_id,
        "kitchen",
        "KITCHEN_QUEUE_UPDATED",
        {"order_id": str(order.id), "items_sent": result.kitchen_queue_entries_created},
    )
    return result


@router.post("/{order_id}/request-billing", response_model=OrderOut)
def request_billing(
    order_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.REQUEST_BILLING)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """SENT/SERVED -> BILLING. Khách yêu cầu thanh toán — chưa nhận tiền, chỉ khóa
    order lại để không ai thêm/sửa món trong lúc tính tiền. PO chốt 12/10 (B1 = A):
    bàn cũng chuyển OCCUPIED -> BILLING để sơ đồ bàn thấy ngay bàn sắp trống và
    khóa gọi thêm/gộp bàn; thanh toán xong bàn sang thẳng CLEANING (B2 = A)."""
    endpoint = f"POST /api/v1/orders/{order_id}/request-billing"
    request_hash = hash_request_body({"order_id": str(order_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status not in ("SENT", "SERVED"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể chuyển sang BILLING",
        )

    order.status = "BILLING"
    table = order.table_session.table
    table.status = "BILLING"
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_BILLING_REQUESTED",
        entity_type="order",
        entity_id=order.id,
        payload={"table_id": str(table.id)},
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "BILLING_REQUESTED")
    manager.publish(
        current.outlet_id,
        "tables",
        "TABLE_STATUS_CHANGED",
        {"table_id": str(table.id), "status": table.status},
    )
    return result


@router.post("/{order_id}/customer", response_model=OrderOut)
def attach_customer(
    order_id: uuid.UUID,
    payload: AttachCustomerRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.CUSTOMER_ACCESS)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """Gắn khách để tích điểm khi thanh toán, không bắt buộc; `customer_id: null` để bỏ.
    Được đổi tới trước lúc thanh toán."""
    endpoint = f"POST /api/v1/orders/{order_id}/customer"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status in ("PAID", "CLOSED"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể đổi khách",
        )
    if has_collected_payment(session, order.id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Đơn đã nhận một phần tiền, không đổi khách được",
        )
    active = active_order_reward(session, order.id)
    if (
        active is not None
        and active.reward_type == "POINTS"
        and payload.customer_id != order.customer_id
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Đơn đang đổi điểm, hãy gỡ ưu đãi trước khi đổi khách"
        )
    if payload.customer_id is not None:
        customer = session.get(Customer, payload.customer_id)
        if customer is None or customer.outlet_id != current.outlet_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy khách hàng")
        if not customer.is_active:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="Khách hàng đang bị khóa")

    order.customer_id = payload.customer_id
    if payload.customer_id is not None:
        # Thu ngân đã xử lý số khách nhập trên QR (đăng ký hoặc chọn khách khác).
        order.table_session.pending_member_phone = None
    session.flush()
    session.refresh(order)
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_CUSTOMER_CHANGED",
        entity_type="order",
        entity_id=order.id,
        payload={"customer_id": payload.customer_id},
    )
    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    return result


@router.get("/{order_id}/pending-member", response_model=PendingMemberOut)
def get_pending_member(
    order_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.CUSTOMER_ACCESS)),
    session: Session = Depends(get_session),
) -> PendingMemberOut:
    """Số điện thoại khách nhập trên QR cho bàn của đơn này (specs/002-rewards-dot-3, FR-010).
    Thu ngân xác nhận đồng ý rồi đăng ký bằng POST /customers, gắn bằng POST .../customer."""
    order = _load_order_or_404(session, order_id, current.outlet_id, for_update=False)
    phone = order.table_session.pending_member_phone
    if phone is None:
        return PendingMemberOut()
    member = session.execute(
        select(Customer.id).where(
            Customer.outlet_id == current.outlet_id,
            Customer.phone == phone,
            Customer.is_active.is_(True),
        )
    ).scalar_one_or_none()
    return PendingMemberOut(phone=phone, member_customer_id=member)


def _reward_context(session: Session, order: Order) -> tuple[Customer | None, LoyaltyRule | None]:
    customer = session.get(Customer, order.customer_id) if order.customer_id else None
    return customer, current_rule(session, order.table_session.table.outlet_id)


@router.get("/{order_id}/eligible-rewards", response_model=list[EligibleRewardOut])
def list_eligible_rewards(
    order_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.REWARD_APPLY)),
    session: Session = Depends(get_session),
) -> list[EligibleRewardOut]:
    """Mọi ưu đãi đang bật, kèm dùng được hay không và lý do (RW-004). Ưu đãi đổi điểm báo số
    điểm tối đa dùng được cho đơn này."""
    order = _load_order_or_404(session, order_id, current.outlet_id, for_update=False)
    customer, rule = _reward_context(session, order)
    subtotal = order_payable_amount(order)
    rewards = session.scalars(
        select(Reward)
        .where(Reward.outlet_id == current.outlet_id, Reward.is_active.is_(True))
        .order_by(Reward.name)
    ).all()
    rows = []
    for reward in rewards:
        evaluation = evaluate_reward(reward, subtotal=subtotal, customer=customer, rule=rule)
        rows.append(
            EligibleRewardOut(
                reward_id=reward.id,
                name=reward.name,
                reward_type=reward.reward_type,
                eligible=evaluation.eligible,
                reason_code=evaluation.reason_code,
                reason=REASONS.get(evaluation.reason_code),
                discount_amount=evaluation.discount,
                points=evaluation.points,
                max_points=evaluation.max_points,
            )
        )
    return rows


@router.post(
    "/{order_id}/rewards", response_model=OrderDetailOut, status_code=status.HTTP_201_CREATED
)
def apply_reward(
    order_id: uuid.UUID,
    payload: ApplyRewardRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.REWARD_APPLY)),
    session: Session = Depends(get_session),
) -> OrderDetailOut:
    """Mỗi đơn chỉ 1 ưu đãi (RW-007). Điểm chỉ bị trừ khi thanh toán, nên gỡ ưu đãi không phải
    hoàn gì; số dư được kiểm tra lại lúc đó."""
    endpoint = f"POST /api/v1/orders/{order_id}/rewards"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderDetailOut.model_validate_json(existing.response_body)

    is_override = payload.override_reason is not None
    if is_override and not role_has(
        session, current.outlet_id, current.role, Permission.OVERRIDE
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="Vai trò này không được bỏ qua điều kiện ưu đãi"
        )

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status in ("PAID", "CLOSED"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể áp ưu đãi",
        )
    if active_order_reward(session, order.id) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Đơn đã có ưu đãi, hãy gỡ trước khi áp ưu đãi khác"
        )
    if has_collected_payment(session, order.id):
        # Áp ưu đãi làm giảm số phải trả, có thể thấp hơn số khách đã trả.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Đơn đã nhận một phần tiền, không áp thêm ưu đãi được",
        )
    reward = session.get(Reward, payload.reward_id)
    if reward is None or reward.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy ưu đãi")
    if reward.reward_type == "POINTS" and payload.points is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Cần số điểm muốn đổi")
    if reward.reward_type != "POINTS" and payload.points is not None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Ưu đãi này không dùng điểm"
        )

    customer, rule = _reward_context(session, order)
    evaluation = evaluate_reward(
        reward,
        subtotal=order_payable_amount(order),
        customer=customer,
        rule=rule,
        points_requested=payload.points,
        override=is_override,
    )
    if not evaluation.eligible:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=REASONS[evaluation.reason_code])
    if payload.points is not None and payload.points > evaluation.max_points:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Đơn này chỉ đổi được tối đa {evaluation.max_points} điểm",
        )

    session.add(
        OrderReward(
            order_id=order.id,
            reward_id=reward.id,
            customer_id=order.customer_id,
            reward_name=reward.name,
            reward_type=reward.reward_type,
            points_requested=payload.points or 0,
            rule_version=rule.version if rule and reward.reward_type == "POINTS" else None,
            override_reason=payload.override_reason,
            applied_by_staff_id=current.id,
        )
    )
    session.flush()
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_REWARD_OVERRIDDEN" if is_override else "ORDER_REWARD_APPLIED",
        entity_type="order",
        entity_id=order.id,
        payload={
            "reward_id": str(reward.id),
            "discount": evaluation.discount,
            "points": evaluation.points,
            "override_reason": payload.override_reason,
        },
    )
    result = build_order_detail(session, order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_201_CREATED,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "REWARD_APPLIED")
    return result


@router.delete("/{order_id}/rewards/{order_reward_id}", response_model=OrderDetailOut)
def remove_reward(
    order_id: uuid.UUID,
    order_reward_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.REWARD_APPLY)),
    session: Session = Depends(get_session),
) -> OrderDetailOut:
    """Gỡ trước khi thanh toán (RW-014). Đã thanh toán thì phải hoàn, chưa có ở đợt này."""
    endpoint = f"DELETE /api/v1/orders/{order_id}/rewards/{order_reward_id}"
    request_hash = hash_request_body({"order_reward_id": str(order_reward_id)})
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderDetailOut.model_validate_json(existing.response_body)

    order = _load_order_or_404(session, order_id, current.outlet_id)
    applied = session.get(OrderReward, order_reward_id)
    if applied is None or applied.order_id != order.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy ưu đãi trong đơn")
    if applied.status != "APPLIED":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Ưu đãi đang ở trạng thái '{applied.status}', không thể gỡ",
        )
    applied.status = "REMOVED"
    session.flush()
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_REWARD_REMOVED",
        entity_type="order",
        entity_id=order.id,
        payload={"reward_id": str(applied.reward_id)},
    )
    result = build_order_detail(session, order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "REWARD_REMOVED")
    return result


@dataclass
class PaidOrderResult:
    pricing: OrderPricing
    table: RestaurantTable
    released: list[RestaurantTable]


def finalize_paid_order(
    session: Session, order: Order, current: CurrentStaff, *, extra_audit: dict | None = None
) -> PaidOrderResult:
    """BILLING -> PAID trong transaction của người gọi (order đã bị khóa): chốt ưu đãi, tích
    điểm, đóng phiên bàn khi không còn đơn nào chưa trả, ghi audit ORDER_PAID. Dùng chung cho
    /pay và cho lần thanh toán cuối của API payments. Gọi xong thì commit rồi
    `publish_order_paid`."""
    order.status = "PAID"

    table_session = order.table_session
    table = session.get(RestaurantTable, table_session.table_id)
    # Bàn có thể có nhiều hóa đơn (tách đơn): chỉ đóng phiên khi không còn đơn nào có món
    # chưa trả. Đơn rỗng (mọi món đã bỏ, hoặc đã dồn sang đơn khác) không giữ bàn.
    others = list(
        session.scalars(
            select(Order)
            .where(
                Order.table_session_id == table_session.id,
                Order.id != order.id,
                Order.status.in_(_UNPAID_ORDER_STATUSES),
            )
            .with_for_update()
        )
    )
    unpaid = [o for o in others if any(item.status != "VOIDED" for item in o.items)]
    released: list[RestaurantTable] = []
    if unpaid:
        table.status = "BILLING" if any(o.status == "BILLING" for o in unpaid) else "OCCUPIED"
    else:
        for empty in others:
            empty.status = "CLOSED"
        table_session.status = "CLOSED"
        table_session.closed_at = datetime.now(timezone.utc)
        table_session.pending_member_phone = None  # không giữ số điện thoại sau khi khách về
        table.status = "CLEANING"
        # Bàn đã gộp vào bàn này cũng trả lại, chờ dọn như bàn chính.
        released = list(
            session.scalars(
                select(RestaurantTable)
                .where(RestaurantTable.merged_into_table_id == table.id)
                .with_for_update()
            )
        )
        for merged in released:
            merged.status = "CLEANING"
            merged.merged_into_table_id = None

    # Cùng transaction: đơn đã PAID thì điểm đã trừ và đã tích, request đã khóa đơn nên chỉ
    # làm 1 lần. Ưu đãi không còn hợp lệ thì 409 và rollback cả việc chuyển PAID ở trên.
    pricing = commit_order_reward(session, order, current.outlet_id, current.id)
    earned = earn_points_for_order(
        session, order, current.outlet_id, current.id, pricing.total
    )

    session.flush()
    session.refresh(order)

    audit_payload = {
        "table_session_id": str(table_session.id),
        "session_closed": not unpaid,
        "subtotal": pricing.subtotal,
        "discount": pricing.discount,
        "total": pricing.total,
        **(extra_audit or {}),
    }
    if pricing.points:
        audit_payload["points_redeemed"] = pricing.points
    if earned is not None:
        audit_payload["points_earned"] = earned.points
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_PAID",
        entity_type="order",
        entity_id=order.id,
        payload=audit_payload,
    )
    return PaidOrderResult(pricing=pricing, table=table, released=released)


def publish_order_paid(current: CurrentStaff, order: Order, result: PaidOrderResult) -> None:
    _publish_order_updated(current, order, "ORDER_PAID")
    for changed in (result.table, *result.released):
        manager.publish(
            current.outlet_id,
            "tables",
            "TABLE_STATUS_CHANGED",
            {"table_id": str(changed.id), "status": changed.status},
        )


@router.post("/{order_id}/pay", response_model=OrderOut)
def pay_order(
    order_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.PROCESS_PAYMENT)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """Lối tắt "khách trả nốt bằng tiền mặt": ghi 1 lần thanh toán CASH cho số còn lại rồi
    BILLING -> PAID. Muốn trả nhiều lần, bằng thẻ, hoặc tính tiền thối thì dùng
    POST /orders/{id}/payments. Đơn cuối cùng của bàn được trả thì đóng table_session và
    chuyển bàn sang CLEANING; bàn còn đơn khác chưa trả (đã tách đơn) thì phiên vẫn mở."""
    endpoint = f"POST /api/v1/orders/{order_id}/pay"
    request_hash = hash_request_body({"order_id": str(order_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order = lock_order_for_payment(session, order_id, current.outlet_id)
    if order.status != "BILLING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', phải ở BILLING mới pay được",
        )

    totals = payment_totals(order_payments(session, order.id, for_update=True))
    paid = finalize_paid_order(session, order, current)
    remaining = totals.remaining(paid.pricing.total)
    if remaining > 0:
        session.add(
            Payment(
                order_id=order.id,
                outlet_id=current.outlet_id,
                method="CASH",
                amount=remaining,
                status="SUCCEEDED",
                cash_received=remaining,
                change_due=Decimal("0"),
                note="Thanh toán nhanh (/pay)",
                created_by_staff_id=current.id,
            )
        )
        session.flush()

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    publish_order_paid(current, order, paid)
    return result


def _derive_order_status(items: list[OrderItem]) -> str:
    """Trạng thái đơn theo các món còn lại: có món đang ở bếp hoặc đang mang ra thì SENT,
    mọi món đã phục vụ thì SERVED, còn lại NEW (chỉ có món chưa gửi bếp)."""
    live = [item for item in items if item.status != "VOIDED"]
    if any(item.status not in ("CREATED", "SERVED") for item in live):
        return "SENT"
    if any(item.status == "SERVED" for item in live):
        return "SERVED"
    return "NEW"


@router.post("/{order_id}/split", response_model=SplitOrderOut, status_code=status.HTTP_201_CREATED)
def split_order(
    order_id: uuid.UUID,
    payload: SplitOrderRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_TRANSFER)),
    session: Session = Depends(get_session),
) -> SplitOrderOut:
    """Tách một phần đơn sang hóa đơn mới cùng bàn, mỗi hóa đơn thanh toán riêng. Tách theo
    món và số lượng; món đang ở bếp chỉ chuyển nguyên dòng (phiếu bếp đi theo). Đơn đang áp
    ưu đãi thì phải gỡ trước. Phải để lại ít nhất 1 món ở đơn cũ, muốn chuyển hết thì dùng
    chuyển bàn. Khách hàng đã gắn vẫn ở đơn cũ."""
    endpoint = f"POST /api/v1/orders/{order_id}/split"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return SplitOrderOut.model_validate_json(existing.response_body)

    item_ids = [line.order_item_id for line in payload.items]
    if len(set(item_ids)) != len(item_ids):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Món bị chọn trùng")

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status not in ("NEW", "SENT", "SERVED"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể tách",
        )
    _ensure_table_not_billing(order)
    if active_order_reward(session, order.id) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Đơn đang áp ưu đãi, hãy gỡ trước khi tách"
        )

    items_by_id = {item.id: item for item in order.items}
    plan = []
    for line in payload.items:
        item = items_by_id.get(line.order_item_id)
        if item is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail="Không tìm thấy món trong đơn này"
            )
        if item.status == "VOIDED":
            raise HTTPException(status.HTTP_409_CONFLICT, detail="Món đã hủy, không tách được")
        if line.quantity > item.quantity:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Món chỉ có {item.quantity} phần",
            )
        if line.quantity < item.quantity and item.status not in _PARTIAL_SPLIT_ITEM_STATUSES:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="Món đang ở bếp chỉ tách được nguyên dòng",
            )
        plan.append((item, line.quantity))

    moved = sum(quantity for _item, quantity in plan)
    live_total = sum(item.quantity for item in order.items if item.status != "VOIDED")
    if moved >= live_total:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Phải để lại ít nhất 1 món ở đơn cũ; muốn chuyển hết hãy dùng chuyển bàn",
        )

    new_order = Order(
        table_session_id=order.table_session_id,
        status="NEW",
        current_version=1,
        created_by_staff_id=current.id,
    )
    session.add(new_order)
    session.flush()
    for item, quantity in plan:
        if quantity == item.quantity:
            item.order_id = new_order.id
            continue
        item.quantity -= quantity
        session.add(
            OrderItem(
                order_id=new_order.id,
                menu_item_id=item.menu_item_id,
                status=item.status,
                quantity=quantity,
                unit_price=item.unit_price,
                note=item.note,
                source=item.source,
                modifiers=[
                    OrderItemModifier(
                        option_id=m.option_id,
                        group_name=m.group_name,
                        option_name=m.option_name,
                        price_delta=m.price_delta,
                    )
                    for m in item.modifiers
                ],
            )
        )
    session.flush()
    session.expire(order, ["items"])
    session.expire(new_order, ["items"])

    order.status = _derive_order_status(order.items)
    new_order.status = _derive_order_status(new_order.items)
    order.current_version += 1
    session.flush()
    for target in (order, new_order):
        session.add(
            OrderVersion(
                order_id=target.id,
                version_number=target.current_version,
                snapshot=_snapshot_order(target),
                created_by_staff_id=current.id,
            )
        )
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_SPLIT",
        entity_type="order",
        entity_id=order.id,
        payload={
            "new_order_id": str(new_order.id),
            "items": [{"order_item_id": str(item.id), "quantity": q} for item, q in plan],
        },
    )
    session.flush()
    session.refresh(new_order)
    result = SplitOrderOut(
        order=build_order_detail(session, order),
        new_order=build_order_detail(session, new_order),
    )
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_201_CREATED,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ORDER_SPLIT")
    _publish_order_updated(current, new_order, "ORDER_SPLIT")
    # Phiếu bếp của món chuyển nguyên dòng giờ thuộc đơn mới: màn bếp phải tải lại.
    manager.publish(
        current.outlet_id,
        "kitchen",
        "KITCHEN_QUEUE_UPDATED",
        {"order_id": str(new_order.id), "items_sent": 0, "reason": "ORDER_SPLIT"},
    )
    return result


@router.post("/{order_id}/close", response_model=OrderOut)
def close_order(
    order_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.PROCESS_PAYMENT)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """PAID -> CLOSED. Chốt sổ cuối cùng (vd sau khi in hóa đơn xong) — tách
    riêng khỏi bước `pay` để thu ngân có thể xử lý hoàn tất giấy tờ trước khi
    thật sự đóng order."""
    endpoint = f"POST /api/v1/orders/{order_id}/close"
    request_hash = hash_request_body({"order_id": str(order_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status != "PAID":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', phải ở PAID mới close được",
        )

    order.status = "CLOSED"
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_CLOSED",
        entity_type="order",
        entity_id=order.id,
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ORDER_CLOSED")
    return result


@router.post("/{order_id}/items/{item_id}/void", response_model=OrderOut)
def void_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: VoidItemRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.OVERRIDE)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """Hủy 1 món CHƯA phục vụ xong (CREATED/SENT/ACCEPTED/PREPARING). Món đã
    SERVED/PICKED_UP thì không void được nữa — dùng `refire` nếu cần làm lại."""
    endpoint = f"POST /api/v1/orders/{order_id}/items/{item_id}/void"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    if order.status in _CLOSED_ORDER_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể hủy món",
        )
    if item.status not in _VOIDABLE_ITEM_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Món đang ở trạng thái '{item.status}', không thể hủy",
        )

    item.status = "VOIDED"
    # Món hủy thì phiếu bếp đang chờ/đang nấu của nó cũng hủy (CANCELLED), để món
    # biến khỏi màn bếp. QA GAP-14 / TC_API_20_002: trước đây phiếu vẫn QUEUED.
    cancelled_tickets = session.execute(
        update(KitchenQueue)
        .where(KitchenQueue.order_item_id == item.id)
        .where(KitchenQueue.status.in_(("QUEUED", "IN_PROGRESS")))
        .values(status="CANCELLED", done_at=datetime.now(timezone.utc))
    ).rowcount
    order.current_version += 1
    session.flush()
    session.refresh(order)

    session.add(
        OrderVersion(
            order_id=order.id,
            version_number=order.current_version,
            snapshot=_snapshot_order(order),
            created_by_staff_id=current.id,
        )
    )

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_ITEM_VOIDED",
        entity_type="order_item",
        entity_id=item.id,
        payload={"reason": payload.reason, "kitchen_tickets_cancelled": cancelled_tickets},
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_VOIDED", item_id=item.id)
    manager.publish(
        current.outlet_id,
        "kitchen",
        "ORDER_ITEM_VOIDED",
        {"order_id": str(order.id), "item_id": str(item.id), "status": item.status},
    )
    return result


@router.post("/{order_id}/items/{item_id}/refire", response_model=OrderOut)
def refire_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.OVERRIDE)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """Làm lại 1 món đã SERVED/PICKED_UP nhưng có vấn đề (nấu sai, khách phàn
    nàn...) — chuyển status sang REFIRED và tạo lại 1 kitchen_queue entry mới
    để bếp làm lại, KHÔNG tạo order_item mới (giữ nguyên lịch sử món gốc)."""
    endpoint = f"POST /api/v1/orders/{order_id}/items/{item_id}/refire"
    request_hash = hash_request_body({"item_id": str(item_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    if order.status in _CLOSED_ORDER_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', không thể refire món",
        )
    if item.status not in _REFIRABLE_ITEM_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                f"Món đang ở trạng thái '{item.status}', chỉ refire được món đã SERVED/PICKED_UP"
            ),
        )

    menu_item = session.get(MenuItem, item.menu_item_id)
    if menu_item.station_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Món '{menu_item.name}' chưa được gán kitchen_station — không thể refire",
        )

    item.status = "REFIRED"
    session.add(
        KitchenQueue(order_item_id=item.id, station_id=menu_item.station_id, status="QUEUED")
    )
    order.current_version += 1
    session.flush()
    session.refresh(order)

    session.add(
        OrderVersion(
            order_id=order.id,
            version_number=order.current_version,
            snapshot=_snapshot_order(order),
            created_by_staff_id=current.id,
        )
    )

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_ITEM_REFIRED",
        entity_type="order_item",
        entity_id=item.id,
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_REFIRED", item_id=item.id)
    manager.publish(
        current.outlet_id,
        "kitchen",
        "ORDER_ITEM_REFIRED",
        {"order_id": str(order.id), "item_id": str(item.id), "status": item.status},
    )
    return result


def _load_active_kitchen_queue_entry(
    session: Session, order_item_id: uuid.UUID
) -> KitchenQueue | None:
    """Entry KitchenQueue mới nhất, còn đang hoạt động (chưa DONE/CANCELLED)
    cho 1 order_item — refire tạo entry mới nên luôn lấy entry gần nhất."""
    return (
        session.execute(
            select(KitchenQueue)
            .where(KitchenQueue.order_item_id == order_item_id)
            .where(KitchenQueue.status.in_(("QUEUED", "IN_PROGRESS")))
            .order_by(KitchenQueue.queued_at.desc())
        )
        .scalars()
        .first()
    )


def _maybe_mark_order_served(session: Session, order: Order) -> None:
    """SENT -> SERVED khi mọi món (trừ món đã VOIDED) đều đã SERVED. Không tự
    lùi lại nếu order đã ở BILLING/PAID/CLOSED (khách có thể yêu cầu thanh
    toán trước khi món cuối cùng được phục vụ xong)."""
    if order.status != "SENT":
        return
    remaining = [item for item in order.items if item.status != "VOIDED"]
    if remaining and all(item.status == "SERVED" for item in remaining):
        order.status = "SERVED"


@router.post("/{order_id}/items/{item_id}/start-cooking", response_model=OrderOut)
def start_cooking_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.KITCHEN_ACTION)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """SENT/REFIRED -> PREPARING (bếp bắt đầu nấu). MVP gộp luôn bước "tiếp nhận"
    (ACCEPTED) vào action này — BRD chỉ định nghĩa 1 action "Start Cooking",
    không tách riêng bước "accept". Nếu sau này cần tách, thêm action mới và
    dùng ACCEPTED làm bước trung gian (schema đã có sẵn giá trị này)."""
    endpoint = f"POST /api/v1/orders/{order_id}/items/{item_id}/start-cooking"
    request_hash = hash_request_body({"item_id": str(item_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    if item.status not in _STARTABLE_ITEM_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                f"Món đang ở trạng thái '{item.status}', "
                "phải ở SENT hoặc REFIRED mới start-cooking được"
            ),
        )

    queue_entry = _load_active_kitchen_queue_entry(session, item.id)
    if queue_entry is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Không tìm thấy kitchen_queue entry đang hoạt động cho món này",
        )

    item.status = "PREPARING"
    queue_entry.status = "IN_PROGRESS"
    queue_entry.started_at = datetime.now(timezone.utc)
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_ITEM_START_COOKING",
        entity_type="order_item",
        entity_id=item.id,
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_STARTED", item_id=item.id)
    manager.publish(
        current.outlet_id,
        "kitchen",
        "ORDER_ITEM_STATUS_CHANGED",
        {"order_id": str(order.id), "item_id": str(item.id), "status": item.status},
    )
    return result


@router.post("/{order_id}/items/{item_id}/mark-ready", response_model=OrderOut)
def mark_ready_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.KITCHEN_ACTION)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """PREPARING -> READY (bếp làm xong, chờ phục vụ tới lấy)."""
    endpoint = f"POST /api/v1/orders/{order_id}/items/{item_id}/mark-ready"
    request_hash = hash_request_body({"item_id": str(item_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    if item.status != "PREPARING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Món đang ở trạng thái '{item.status}', phải ở PREPARING mới mark-ready được",
        )

    queue_entry = _load_active_kitchen_queue_entry(session, item.id)
    if queue_entry is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Không tìm thấy kitchen_queue entry đang hoạt động cho món này",
        )

    item.status = "READY"
    queue_entry.status = "DONE"
    queue_entry.done_at = datetime.now(timezone.utc)
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_ITEM_MARKED_READY",
        entity_type="order_item",
        entity_id=item.id,
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_READY", item_id=item.id)
    manager.publish(
        current.outlet_id,
        "kitchen",
        "ORDER_ITEM_STATUS_CHANGED",
        {"order_id": str(order.id), "item_id": str(item.id), "status": item.status},
    )
    return result


@router.post("/{order_id}/items/{item_id}/pickup", response_model=OrderOut)
def pickup_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.SERVE_FOOD)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """READY -> PICKED_UP (phục vụ đã lấy món từ bếp, chuẩn bị mang ra bàn)."""
    endpoint = f"POST /api/v1/orders/{order_id}/items/{item_id}/pickup"
    request_hash = hash_request_body({"item_id": str(item_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    if item.status != "READY":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Món đang ở trạng thái '{item.status}', phải ở READY mới pickup được",
        )

    item.status = "PICKED_UP"
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_ITEM_PICKED_UP",
        entity_type="order_item",
        entity_id=item.id,
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_PICKED_UP", item_id=item.id)
    manager.publish(
        current.outlet_id,
        "kitchen",
        "ORDER_ITEM_STATUS_CHANGED",
        {"order_id": str(order.id), "item_id": str(item.id), "status": item.status},
    )
    return result


@router.post("/{order_id}/items/{item_id}/served", response_model=OrderOut)
def serve_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.SERVE_FOOD)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """PICKED_UP -> SERVED. Khi TOÀN BỘ món (trừ món VOIDED) trong order đã
    SERVED, tự động chuyển order.status SENT -> SERVED (BRD state machine)."""
    endpoint = f"POST /api/v1/orders/{order_id}/items/{item_id}/served"
    request_hash = hash_request_body({"item_id": str(item_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order, item = _load_order_item_or_404(session, order_id, item_id, current.outlet_id)
    if item.status != "PICKED_UP":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Món đang ở trạng thái '{item.status}', phải ở PICKED_UP mới served được",
        )

    item.status = "SERVED"
    _maybe_mark_order_served(session, order)
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_ITEM_SERVED",
        entity_type="order_item",
        entity_id=item.id,
    )

    result = OrderOut.model_validate(order)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    _publish_order_updated(current, order, "ITEM_SERVED", item_id=item.id)
    manager.publish(
        current.outlet_id,
        "kitchen",
        "ORDER_ITEM_STATUS_CHANGED",
        {"order_id": str(order.id), "item_id": str(item.id), "status": item.status},
    )
    return result
