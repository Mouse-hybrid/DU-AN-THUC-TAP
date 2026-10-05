"""Vertical slice bước 2+3: Tạo order → Gửi bếp, + vòng đời thanh toán và
void/refire món.

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
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_role,
)
from app.core.realtime import manager
from app.db.base import get_session
from app.db.models import (
    IdempotencyKey,
    KitchenQueue,
    MenuItem,
    Order,
    OrderItem,
    OrderVersion,
    RestaurantTable,
    TableSession,
)
from app.schemas.orders import (
    AddItemsRequest,
    CreateOrderRequest,
    OrderOut,
    SendToKitchenResponse,
    UpdateOrderItemRequest,
    VoidItemRequest,
)

router = APIRouter(prefix="/orders", tags=["orders"])

# --- Role theo đúng Permission Matrix thật trong BRD (Action × Cashier/
# --- Waiter/Kitchen/Supervisor/Customer) — đọc trực tiếp từ XML gốc của file
# --- .docx vì bản trích xuất text thông thường bị mất các ô ✓/✗ (nằm trong
# --- content-control, không phải text thường). Bảng gốc:
#
#   Action                       Cashier Waiter Kitchen Supervisor Customer
#   Create Order (POS)             v       x       x        x         x
#   Create Order (QR)              x       x       x        x         v
#   View KDS                       x       x       v        v         x
#   Start Cooking                  x       x       v        v         x
#   Mark Ready                     x       x       v        v         x
#   Serve Food                     x       v       x        v         x
#   Request Bill                   v       v       x        v         v
#   Apply Reward                   v       x       x        v         x
#   Process Payment                v       x       x        v         v
#   Merge/Split/Transfer Table     x       v       x        v         v
#   Override Actions               x       x       x        v         x
#
# "Send to Kitchen", "Add Item", "Void", "Refire" KHÔNG có trong 11 action
# trên — suy ra từ mô tả Key Responsibilities/Restrictions của từng role
# (vd Kitchen "Cannot modify orders" + Override Actions chỉ Supervisor ->
# void/refire coi là override action, Supervisor-only).
_ORDER_WRITE_ROLES = ("CASHIER", "SUPERVISOR")  # = "Create Order (POS)"
_SEND_TO_KITCHEN_ROLES = ("WAITER", "SUPERVISOR")  # suy từ Key Responsibilities của Waiter
_REQUEST_BILLING_ROLES = ("CASHIER", "WAITER", "SUPERVISOR")  # = "Request Bill"
_PAY_ROLES = (
    "CASHIER",
    "SUPERVISOR",
)  # = "Process Payment" — Waiter KHÔNG được (BRD: "Cannot process payment")
_VOID_ROLES = ("SUPERVISOR",)  # = "Override Actions"
_REFIRE_ROLES = (
    "SUPERVISOR",
)  # = "Override Actions" (Kitchen "Cannot modify orders" nên cũng không refire được)
_KITCHEN_ACTION_ROLES = ("KITCHEN", "SUPERVISOR")  # = "Start Cooking" / "Mark Ready"
# BRD không liệt kê "Pickup" trong 11 action gốc — coi là 1 bước nằm trong
# trách nhiệm "Serve Food" của Waiter (Waiter lấy món từ bếp rồi mang ra bàn),
# nên dùng chung role với bước "served". Cần BA/PM xác nhận nếu thực tế tách
# vai trò khác (vd Kitchen tự để món ra quầy, Waiter chỉ mang ra bàn).
_PICKUP_SERVE_ROLES = ("WAITER", "SUPERVISOR")  # = "Serve Food"
_CLOSED_ORDER_STATUSES = ("BILLING", "PAID", "CLOSED")
_VOIDABLE_ITEM_STATUSES = ("CREATED", "SENT", "ACCEPTED", "PREPARING")
_REFIRABLE_ITEM_STATUSES = ("SERVED", "PICKED_UP")


def _load_order_or_404(session: Session, order_id: uuid.UUID, outlet_id: uuid.UUID) -> Order:
    order = session.execute(
        select(Order)
        .where(Order.id == order_id)
        .options(selectinload(Order.items), selectinload(Order.table_session))
    ).scalar_one_or_none()
    if order is None or order.table_session.table.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy order")
    return order


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
                }
                for item in order.items
            ],
        }
    )


@router.post("", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: CreateOrderRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_ORDER_WRITE_ROLES)),
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

    table_session = session.get(TableSession, payload.table_session_id)
    if table_session is None or table_session.table.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy table_session")
    if table_session.status != "OPEN":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                f"table_session đang ở trạng thái '{table_session.status}', không thể tạo order mới"
            ),
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
    return result


@router.post("/{order_id}/items", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def add_order_items(
    order_id: uuid.UUID,
    payload: AddItemsRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_ORDER_WRITE_ROLES)),
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
    # BRD: Cashier là role duy nhất tạo order (Create Order (POS)); không role
    # nào trong Permission Matrix được liệt kê quyền "sửa order sau khi gửi bếp"
    # — chỉ Supervisor mới có "Override Actions". Sau khi order rời khỏi NEW
    # (tức đã gửi bếp ít nhất 1 lần), chỉ Supervisor được thêm món tiếp.
    if order.status != "NEW" and current.role != "SUPERVISOR":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Order đã gửi bếp — chỉ Supervisor mới được thêm món (override)",
        )

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

        session.add(
            OrderItem(
                order_id=order.id,
                menu_item_id=menu_item.id,
                status="CREATED",
                quantity=line.quantity,
                # snapshot giá tại thời điểm order — đổi giá menu sau không ảnh hưởng order cũ
                unit_price=menu_item.price,
                note=line.note,
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
    return result


def _ensure_item_editable_before_send(order: Order, item: OrderItem, current: CurrentStaff) -> None:
    """BRD In Scope: "Order modification (before kitchen send)". Chỉ món còn CREATED
    (bếp chưa nhận) mới sửa/bỏ tự do; món đã gửi bếp phải đi qua void/refire
    (Supervisor). Cùng quy tắc quyền với thêm món: order đã rời NEW thì chỉ
    Supervisor được đụng vào."""
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
    if order.status != "NEW" and current.role != "SUPERVISOR":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Order đã gửi bếp — chỉ Supervisor mới được sửa món (override)",
        )


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
    current: CurrentStaff = Depends(require_role(*_ORDER_WRITE_ROLES)),
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
    return result


@router.delete("/{order_id}/items/{item_id}", response_model=OrderOut)
def remove_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_ORDER_WRITE_ROLES)),
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
    return result


@router.post("/{order_id}/send-to-kitchen", response_model=SendToKitchenResponse)
def send_order_to_kitchen(
    order_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_SEND_TO_KITCHEN_ROLES)),
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

    order.status = "SENT" if order.status == "NEW" else order.status
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
    current: CurrentStaff = Depends(require_role(*_REQUEST_BILLING_ROLES)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """SENT/SERVED -> BILLING. Khách yêu cầu thanh toán — chưa nhận tiền, chỉ khóa
    order lại để không ai thêm/sửa món trong lúc tính tiền."""
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
    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_BILLING_REQUESTED",
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
    return result


@router.post("/{order_id}/pay", response_model=OrderOut)
def pay_order(
    order_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_PAY_ROLES)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """BILLING -> PAID. Đóng luôn table_session (status CLOSED) và chuyển bàn
    sang CLEANING (theo state machine bàn trong BRD: PAID rồi mới dọn bàn,
    không nhảy thẳng về AVAILABLE).

    LƯU Ý: đây là bước ghi nhận "đã thanh toán", KHÔNG xử lý cổng thanh toán
    thật (thẻ/QR/momo...) — tích hợp payment gateway là việc riêng, ngoài
    phạm vi vertical slice này.
    """
    endpoint = f"POST /api/v1/orders/{order_id}/pay"
    request_hash = hash_request_body({"order_id": str(order_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return OrderOut.model_validate_json(existing.response_body)

    order = _load_order_or_404(session, order_id, current.outlet_id)
    if order.status != "BILLING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Order đang ở trạng thái '{order.status}', phải ở BILLING mới pay được",
        )

    order.status = "PAID"

    table_session = order.table_session
    table_session.status = "CLOSED"
    table_session.closed_at = datetime.now(timezone.utc)

    table = session.get(RestaurantTable, table_session.table_id)
    table.status = "CLEANING"

    session.flush()
    session.refresh(order)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="ORDER_PAID",
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
            response_status=status.HTTP_200_OK,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    manager.publish(
        current.outlet_id,
        "tables",
        "TABLE_STATUS_CHANGED",
        {"table_id": str(table.id), "status": table.status},
    )
    return result


@router.post("/{order_id}/close", response_model=OrderOut)
def close_order(
    order_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_PAY_ROLES)),
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
    return result


@router.post("/{order_id}/items/{item_id}/void", response_model=OrderOut)
def void_order_item(
    order_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: VoidItemRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_VOID_ROLES)),
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
        payload={"reason": payload.reason},
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
    current: CurrentStaff = Depends(require_role(*_REFIRE_ROLES)),
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
    current: CurrentStaff = Depends(require_role(*_KITCHEN_ACTION_ROLES)),
    session: Session = Depends(get_session),
) -> OrderOut:
    """SENT -> PREPARING (bếp bắt đầu nấu). MVP gộp luôn bước "tiếp nhận"
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
    if item.status != "SENT":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Món đang ở trạng thái '{item.status}', phải ở SENT mới start-cooking được",
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
    current: CurrentStaff = Depends(require_role(*_KITCHEN_ACTION_ROLES)),
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
    current: CurrentStaff = Depends(require_role(*_PICKUP_SERVE_ROLES)),
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
    current: CurrentStaff = Depends(require_role(*_PICKUP_SERVE_ROLES)),
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
    manager.publish(
        current.outlet_id,
        "kitchen",
        "ORDER_ITEM_STATUS_CHANGED",
        {"order_id": str(order.id), "item_id": str(item.id), "status": item.status},
    )
    return result
