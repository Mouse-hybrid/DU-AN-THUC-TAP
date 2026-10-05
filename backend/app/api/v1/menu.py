"""Menu của outlet hiện tại.

GET   /api/v1/menu              — danh sách món (BE-S1-08), mọi role đã login.
POST  /api/v1/menu              — tạo món mới (Supervisor, bắt buộc Idempotency-Key).
PATCH /api/v1/menu/{item_id}    — sửa tên/giá/trạm bếp/còn hàng (Supervisor). Giá đơn
                                  hàng cũ không đổi vì order_item đã snapshot unit_price.

Gán món vào trạm bếp ("station-mapping") = field `station_id` ở POST/PATCH; danh
sách trạm lấy từ GET /api/v1/kitchen/stations. CHƯA có "category": schema hiện tại
chưa có bảng/cột danh mục — thêm cần migration mới + chốt với BA (xem docs).

GET /menu (BE-S1-08):

Chưa có auth cho khách quét QR (Customer trong BRD) — endpoint này hiện chỉ
phục vụ staff đã login (mọi role, vì "xem menu" không phải action bị hạn chế
trong Permission Matrix). Cho khách quét QR xem menu công khai là 1 luồng
auth khác (qr_session_token trên table_session), ngoài phạm vi BE-S1-08 —
cần làm riêng khi có yêu cầu cụ thể.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_current_staff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_role,
)
from app.db.base import get_session
from app.db.models import IdempotencyKey, KitchenStation, MenuItem
from app.schemas.menu import MenuItemCreate, MenuItemOut, MenuItemUpdate

router = APIRouter(prefix="/menu", tags=["menu"])

# Quản lý menu không có trong 11 action của Permission Matrix (BRD) — chỉ
# Supervisor được sửa menu theo tinh thần "Override Actions"; cần BA/PM xác nhận.
_MENU_WRITE_ROLES = ("SUPERVISOR",)


def _ensure_station_in_outlet(
    session: Session, station_id: uuid.UUID, outlet_id: uuid.UUID
) -> None:
    station = session.get(KitchenStation, station_id)
    if station is None or station.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy trạm bếp")


@router.get("", response_model=list[MenuItemOut])
def list_menu(
    available_only: bool = Query(default=False, description="Chỉ trả món đang is_available=True"),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[MenuItemOut]:
    stmt = select(MenuItem).where(MenuItem.outlet_id == current.outlet_id)
    if available_only:
        stmt = stmt.where(MenuItem.is_available.is_(True))
    stmt = stmt.order_by(MenuItem.name)
    items = session.execute(stmt).scalars().all()
    return [MenuItemOut.model_validate(item) for item in items]


@router.post("", response_model=MenuItemOut, status_code=status.HTTP_201_CREATED)
def create_menu_item(
    payload: MenuItemCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_MENU_WRITE_ROLES)),
    session: Session = Depends(get_session),
) -> MenuItemOut:
    endpoint = "POST /api/v1/menu"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return MenuItemOut.model_validate_json(existing.response_body)

    if payload.station_id is not None:
        _ensure_station_in_outlet(session, payload.station_id, current.outlet_id)

    item = MenuItem(
        outlet_id=current.outlet_id,
        station_id=payload.station_id,
        name=payload.name,
        price=payload.price,
        is_available=payload.is_available,
    )
    session.add(item)
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="MENU_ITEM_CREATED",
        entity_type="menu_item",
        entity_id=item.id,
        payload={"name": item.name, "price": str(item.price)},
    )

    result = MenuItemOut.model_validate(item)
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


@router.patch("/{item_id}", response_model=MenuItemOut)
def update_menu_item(
    item_id: uuid.UUID,
    payload: MenuItemUpdate,
    current: CurrentStaff = Depends(require_role(*_MENU_WRITE_ROLES)),
    session: Session = Depends(get_session),
) -> MenuItemOut:
    """PATCH tự nhiên idempotent (gửi lại cùng nội dung ra cùng kết quả) nên
    không bắt buộc Idempotency-Key như các API tạo mới."""
    item = session.get(MenuItem, item_id)
    if item is None or item.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy món")

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Không có field nào để sửa"
        )
    if changes.get("name", "") is None or changes.get("price", 0) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name/price không được null"
        )
    if changes.get("is_available", True) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="is_available không được null"
        )
    if changes.get("station_id") is not None:
        _ensure_station_in_outlet(session, changes["station_id"], current.outlet_id)

    before = {key: str(getattr(item, key)) for key in changes}
    for key, value in changes.items():
        setattr(item, key, value)
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="MENU_ITEM_UPDATED",
        entity_type="menu_item",
        entity_id=item.id,
        payload={"before": before, "after": {key: str(value) for key, value in changes.items()}},
    )

    result = MenuItemOut.model_validate(item)
    session.commit()
    return result
