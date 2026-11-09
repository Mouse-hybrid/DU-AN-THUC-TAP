"""QR Ordering (Key Focus BRD): khách quét mã tại bàn và tự gọi món, không đăng nhập.

Nhân viên (quyền QR_SESSION_MANAGE):
POST   /api/v1/tables/{id}/qr-session — cấp mã cho phiên đang mở; cấp lại thì mã cũ hết dùng.
GET    /api/v1/tables/{id}/qr-session — xem lại mã còn hạn.
DELETE /api/v1/tables/{id}/qr-session — thu hồi.

Khách (token trong URL là quyền truy cập duy nhất):
GET  /api/v1/public/qr/{token}         — bàn, khu, hạn dùng (màn 40).
GET  /api/v1/public/qr/{token}/menu    — thực đơn (màn 41, 42).
GET  /api/v1/public/qr/{token}/order   — các món của phiên bàn (màn 48, 53); gọi định kỳ
                                         vì khách không có JWT để mở WebSocket.
POST /api/v1/public/qr/{token}/orders  — gửi món (màn 44, 47), cần Idempotency-Key.

Token sai hoặc đã thu hồi trả 401; hết hạn hoặc phiên đã đóng trả 410 (màn 54).

Theo phiếu quyết định B6, món của khách KHÔNG vào bếp ngay: món nằm ở CREATED trong đơn
đang mở của bàn, phục vụ xem lại rồi bấm gửi bếp như món POS (POST /orders/{id}/send-to-kitchen),
món không hợp lệ thì bỏ bằng DELETE /orders/{id}/items/{item_id}. Khách không có API sửa/xóa
sau khi gửi. Dùng chung 1 đơn với POS để bàn chỉ có 1 hóa đơn.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.config import QR_MAX_PENDING_ITEMS, QR_SESSION_TTL_MINUTES
from app.core.deps import (
    CurrentStaff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.loyalty import price_order
from app.core.modifiers import resolve_modifiers
from app.core.permissions import Permission
from app.core.realtime import manager
from app.db.base import get_session
from app.db.models import (
    IdempotencyKey,
    MenuCategory,
    MenuItem,
    Order,
    OrderItem,
    RestaurantTable,
    TableSession,
)
from app.schemas.menu import ModifierGroupOut
from app.schemas.orders import OrderItemModifierOut
from app.schemas.qr import (
    QrCategoryOut,
    QrInfoOut,
    QrMenuItemOut,
    QrMenuOut,
    QrOrderItemOut,
    QrOrderOut,
    QrSessionOut,
    QrSubmitRequest,
)

router = APIRouter(prefix="/tables", tags=["qr"])
public_router = APIRouter(prefix="/public/qr", tags=["qr-public"])

_OPEN_ORDER_STATUSES = ("NEW", "SENT", "SERVED")


def _as_utc(value: datetime) -> datetime:
    # SQLite (test) trả datetime không có múi giờ.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _session_out(table_session: TableSession) -> QrSessionOut:
    return QrSessionOut(
        table_id=table_session.table_id,
        table_session_id=table_session.id,
        token=table_session.qr_session_token,
        expires_at=_as_utc(table_session.qr_expires_at),
        path=f"/qr/{table_session.qr_session_token}",
    )


def _open_session_or_error(
    session: Session, table_id: uuid.UUID, outlet_id: uuid.UUID
) -> TableSession:
    table = session.get(RestaurantTable, table_id)
    if table is None or table.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn")
    table_session = session.execute(
        select(TableSession)
        .where(TableSession.table_id == table.id, TableSession.status == "OPEN")
        .with_for_update()
    ).scalar_one_or_none()
    if table_session is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Bàn chưa mở phiên")
    return table_session


@router.post(
    "/{table_id}/qr-session", response_model=QrSessionOut, status_code=status.HTTP_201_CREATED
)
def issue_qr_session(
    table_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.QR_SESSION_MANAGE)),
    session: Session = Depends(get_session),
) -> QrSessionOut:
    endpoint = f"POST /api/v1/tables/{table_id}/qr-session"
    request_hash = hash_request_body({"table_id": str(table_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return QrSessionOut.model_validate_json(existing.response_body)

    table_session = _open_session_or_error(session, table_id, current.outlet_id)
    table_session.qr_session_token = secrets.token_urlsafe(32)
    table_session.qr_expires_at = datetime.now(timezone.utc) + timedelta(
        minutes=QR_SESSION_TTL_MINUTES
    )
    # Không ghi token vào audit: nhật ký không được trở thành nơi lấy lại quyền gọi món.
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="QR_SESSION_ISSUED",
        entity_type="table_session",
        entity_id=table_session.id,
        payload={"table_id": str(table_id), "expires_at": table_session.qr_expires_at},
    )

    result = _session_out(table_session)
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


@router.get("/{table_id}/qr-session", response_model=QrSessionOut)
def get_qr_session(
    table_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.QR_SESSION_MANAGE)),
    session: Session = Depends(get_session),
) -> QrSessionOut:
    table_session = _open_session_or_error(session, table_id, current.outlet_id)
    if (
        table_session.qr_session_token is None
        or _as_utc(table_session.qr_expires_at) <= datetime.now(timezone.utc)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Bàn chưa có mã QR còn hạn")
    return _session_out(table_session)


@router.delete(
    "/{table_id}/qr-session", response_model=None, status_code=status.HTTP_204_NO_CONTENT
)
def revoke_qr_session(
    table_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.QR_SESSION_MANAGE)),
    session: Session = Depends(get_session),
) -> None:
    table_session = _open_session_or_error(session, table_id, current.outlet_id)
    if table_session.qr_session_token is None:
        return
    table_session.qr_session_token = None
    table_session.qr_expires_at = None
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="QR_SESSION_REVOKED",
        entity_type="table_session",
        entity_id=table_session.id,
        payload={"table_id": str(table_id)},
    )
    session.commit()


def _ensure_usable(table_session: TableSession) -> None:
    expired = _as_utc(table_session.qr_expires_at) <= datetime.now(timezone.utc)
    if table_session.status != "OPEN" or expired:
        raise HTTPException(status.HTTP_410_GONE, detail="Phiên gọi món đã hết hạn")


def _session_from_token(
    token: str = Path(max_length=255), session: Session = Depends(get_session)
) -> TableSession:
    """Là dependency để token sai trả 401 trước khi kiểm tra body request."""
    table_session = session.execute(
        select(TableSession).where(TableSession.qr_session_token == token)
    ).scalar_one_or_none()
    if table_session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Mã QR không hợp lệ")
    _ensure_usable(table_session)
    return table_session


def _ordering_locked(table_session: TableSession) -> bool:
    return table_session.table.status == "BILLING"


def _order_view(session: Session, table_session: TableSession) -> QrOrderOut:
    rows = session.execute(
        select(OrderItem, MenuItem.name)
        .join(Order, OrderItem.order_id == Order.id)
        .join(MenuItem, OrderItem.menu_item_id == MenuItem.id)
        .where(Order.table_session_id == table_session.id)
        .order_by(OrderItem.created_at, OrderItem.id)
    ).all()
    items = [
        QrOrderItemOut(
            id=item.id,
            menu_item_name=name,
            quantity=item.quantity,
            unit_price=item.unit_price,
            line_total=item.unit_price * item.quantity,
            note=item.note,
            status=item.status,
            source=item.source,
            modifiers=[OrderItemModifierOut.model_validate(m) for m in item.modifiers],
        )
        for item, name in rows
    ]
    subtotal = sum((i.line_total for i in items if i.status != "VOIDED"), Decimal("0"))
    discount = Decimal("0")
    for order in session.scalars(select(Order).where(Order.table_session_id == table_session.id)):
        # Món vừa thêm chưa nằm trong order.items đã nạp sẵn.
        session.expire(order, ["items"])
        discount += price_order(session, order).discount
    return QrOrderOut(
        table_code=table_session.table.code,
        items=items,
        subtotal=subtotal,
        discount_total=discount,
        total=subtotal - discount,
    )


@public_router.get("/{token}", response_model=QrInfoOut)
def qr_info(table_session: TableSession = Depends(_session_from_token)) -> QrInfoOut:
    table = table_session.table
    return QrInfoOut(
        table_code=table.code,
        area_name=table.area_name,
        expires_at=_as_utc(table_session.qr_expires_at),
        ordering_locked=_ordering_locked(table_session),
    )


@public_router.get("/{token}/menu", response_model=QrMenuOut)
def qr_menu(
    table_session: TableSession = Depends(_session_from_token),
    session: Session = Depends(get_session),
) -> QrMenuOut:
    """Có cả món hết hàng (is_available=false) để giao diện hiện mờ. Bỏ món chưa gán trạm bếp
    vì không gửi bếp được, và món thuộc nhóm đang ẩn."""
    outlet_id = table_session.table.outlet_id
    categories = session.scalars(
        select(MenuCategory)
        .where(MenuCategory.outlet_id == outlet_id, MenuCategory.is_active.is_(True))
        .order_by(MenuCategory.sort_order, MenuCategory.name)
    ).all()
    items = session.scalars(
        select(MenuItem)
        .outerjoin(MenuCategory, MenuItem.category_id == MenuCategory.id)
        .where(
            MenuItem.outlet_id == outlet_id,
            MenuItem.station_id.is_not(None),
            or_(MenuItem.category_id.is_(None), MenuCategory.is_active.is_(True)),
        )
        .order_by(MenuItem.name)
    ).all()
    return QrMenuOut(
        categories=[QrCategoryOut.model_validate(c) for c in categories],
        items=[
            QrMenuItemOut(
                id=item.id,
                name=item.name,
                price=item.price,
                category_id=item.category_id,
                is_available=item.is_available,
                modifier_groups=[
                    ModifierGroupOut.model_validate(group) for group in item.active_modifier_groups
                ],
            )
            for item in items
        ],
    )


@public_router.get("/{token}/order", response_model=QrOrderOut)
def qr_order(
    table_session: TableSession = Depends(_session_from_token),
    session: Session = Depends(get_session),
) -> QrOrderOut:
    return _order_view(session, table_session)


@public_router.post(
    "/{token}/orders", response_model=QrOrderOut, status_code=status.HTTP_201_CREATED
)
def qr_submit(
    payload: QrSubmitRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    table_session: TableSession = Depends(_session_from_token),
    session: Session = Depends(get_session),
) -> QrOrderOut:
    # Dùng id phiên, không dùng token, để bảng idempotency_key không lưu token.
    endpoint = f"POST /api/v1/public/qr/{table_session.id}/orders"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return QrOrderOut.model_validate_json(existing.response_body)

    # Khóa phiên: hai khách cùng bàn, hoặc khách và POS, gửi đồng thời chạy lần lượt và
    # không chen vào giữa lúc bàn chuyển BILLING. Đọc lại vì trạng thái có thể vừa đổi.
    session.execute(
        select(TableSession)
        .where(TableSession.id == table_session.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    _ensure_usable(table_session)
    table = table_session.table
    if _ordering_locked(table_session):
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Bàn đang chờ thanh toán, chưa gọi thêm được"
        )

    pending = session.scalar(
        select(func.coalesce(func.sum(OrderItem.quantity), 0))
        .join(Order, OrderItem.order_id == Order.id)
        .where(
            Order.table_session_id == table_session.id,
            OrderItem.status == "CREATED",
            OrderItem.source == "QR",
        )
    )
    if pending + sum(line.quantity for line in payload.items) > QR_MAX_PENDING_ITEMS:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Bàn có quá nhiều món đang chờ xác nhận, vui lòng đợi nhân viên",
        )

    resolved = []
    for line in payload.items:
        menu_item = session.get(MenuItem, line.menu_item_id)
        if menu_item is None or menu_item.outlet_id != table.outlet_id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail=f"Không tìm thấy món {line.menu_item_id}"
            )
        if not menu_item.is_available or menu_item.station_id is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail=f"Món '{menu_item.name}' hiện không khả dụng"
            )
        modifiers, modifier_total = resolve_modifiers(menu_item, line.modifier_option_ids)
        resolved.append((line, menu_item, modifiers, modifier_total))

    order = session.execute(
        select(Order)
        .where(
            Order.table_session_id == table_session.id,
            Order.status.in_(_OPEN_ORDER_STATUSES),
        )
        # Đơn cũ nhất: bàn đã tách đơn thì món khách gọi thêm vào hóa đơn gốc.
        .order_by(Order.created_at, Order.id)
        .with_for_update()
    ).scalars().first()
    if order is None:
        order = Order(table_session_id=table_session.id, status="NEW", current_version=1)
        session.add(order)
        session.flush()
        write_audit_log(
            session,
            outlet_id=table.outlet_id,
            staff_id=None,
            action="ORDER_CREATED",
            entity_type="order",
            entity_id=order.id,
            payload={"table_session_id": str(table_session.id), "source": "QR"},
        )

    for line, menu_item, modifiers, modifier_total in resolved:
        session.add(
            OrderItem(
                order_id=order.id,
                menu_item_id=menu_item.id,
                status="CREATED",
                quantity=line.quantity,
                unit_price=menu_item.price + modifier_total,
                note=line.note,
                source="QR",
                modifiers=modifiers,
            )
        )
    order.current_version += 1
    session.flush()
    write_audit_log(
        session,
        outlet_id=table.outlet_id,
        staff_id=None,
        action="ORDER_ITEMS_ADDED",
        entity_type="order",
        entity_id=order.id,
        payload={"items_added": len(payload.items), "source": "QR"},
    )

    result = _order_view(session, table_session)
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
    manager.publish(
        table.outlet_id,
        "tables",
        "ORDER_UPDATED",
        {
            "order_id": str(order.id),
            "table_id": str(table.id),
            "table_session_id": str(table_session.id),
            "status": order.status,
            "current_version": order.current_version,
            "reason": "QR_ITEMS_SUBMITTED",
            "item_id": None,
        },
    )
    return result
