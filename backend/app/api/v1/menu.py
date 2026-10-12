"""Menu của outlet hiện tại.

GET   /api/v1/menu              — danh sách món (BE-S1-08), mọi role đã login. Lọc
                                  theo ?q= (tên chứa chuỗi), ?category_id=, ?available_only=.
POST  /api/v1/menu              — tạo món mới (Supervisor, bắt buộc Idempotency-Key).
PATCH /api/v1/menu/{item_id}    — sửa tên/giá/trạm bếp/nhóm/còn hàng (Supervisor). Giá đơn
                                  hàng cũ không đổi vì order_item đã snapshot unit_price.

GET   /api/v1/menu/categories              — danh sách nhóm món (mọi role đã login).
POST  /api/v1/menu/categories              — tạo nhóm món (Supervisor, Idempotency-Key).
PATCH /api/v1/menu/categories/{category_id} — sửa tên/thứ tự/ẩn hiện nhóm (Supervisor).

Gán món vào trạm bếp ("station-mapping") = field `station_id` ở POST/PATCH; danh
sách trạm lấy từ GET /api/v1/kitchen/stations. Gán nhóm = field `category_id`.

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
from app.db.models import IdempotencyKey, KitchenStation, MenuCategory, MenuItem
from app.schemas.menu import (
    MenuCategoryCreate,
    MenuCategoryOut,
    MenuCategoryUpdate,
    MenuItemCreate,
    MenuItemOut,
    MenuItemUpdate,
)

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


def _ensure_category_in_outlet(
    session: Session, category_id: uuid.UUID, outlet_id: uuid.UUID
) -> MenuCategory:
    category = session.get(MenuCategory, category_id)
    if category is None or category.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy nhóm món")
    return category


def _ensure_category_name_free(
    session: Session, name: str, outlet_id: uuid.UUID, exclude_id: uuid.UUID | None = None
) -> None:
    stmt = select(MenuCategory.id).where(
        MenuCategory.outlet_id == outlet_id, MenuCategory.name == name
    )
    if exclude_id is not None:
        stmt = stmt.where(MenuCategory.id != exclude_id)
    if session.execute(stmt).first() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"Nhóm món '{name}' đã tồn tại")


@router.get("/categories", response_model=list[MenuCategoryOut])
def list_menu_categories(
    active_only: bool = Query(default=False, description="Chỉ trả nhóm đang is_active=True"),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[MenuCategoryOut]:
    stmt = select(MenuCategory).where(MenuCategory.outlet_id == current.outlet_id)
    if active_only:
        stmt = stmt.where(MenuCategory.is_active.is_(True))
    stmt = stmt.order_by(MenuCategory.sort_order, MenuCategory.name)
    return [MenuCategoryOut.model_validate(c) for c in session.execute(stmt).scalars().all()]


@router.post("/categories", response_model=MenuCategoryOut, status_code=status.HTTP_201_CREATED)
def create_menu_category(
    payload: MenuCategoryCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_MENU_WRITE_ROLES)),
    session: Session = Depends(get_session),
) -> MenuCategoryOut:
    endpoint = "POST /api/v1/menu/categories"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return MenuCategoryOut.model_validate_json(existing.response_body)

    _ensure_category_name_free(session, payload.name, current.outlet_id)
    category = MenuCategory(
        outlet_id=current.outlet_id,
        name=payload.name,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )
    session.add(category)
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="MENU_CATEGORY_CREATED",
        entity_type="menu_category",
        entity_id=category.id,
        payload={"name": category.name},
    )

    result = MenuCategoryOut.model_validate(category)
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


@router.patch("/categories/{category_id}", response_model=MenuCategoryOut)
def update_menu_category(
    category_id: uuid.UUID,
    payload: MenuCategoryUpdate,
    current: CurrentStaff = Depends(require_role(*_MENU_WRITE_ROLES)),
    session: Session = Depends(get_session),
) -> MenuCategoryOut:
    """Ẩn nhóm = `is_active: false` (không xóa, để món cũ vẫn giữ liên kết)."""
    category = _ensure_category_in_outlet(session, category_id, current.outlet_id)

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Không có field nào để sửa"
        )
    if any(value is None for value in changes.values()):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="name/sort_order/is_active không được null",
        )
    if "name" in changes:
        _ensure_category_name_free(session, changes["name"], current.outlet_id, category.id)

    before = {key: str(getattr(category, key)) for key in changes}
    for key, value in changes.items():
        setattr(category, key, value)
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="MENU_CATEGORY_UPDATED",
        entity_type="menu_category",
        entity_id=category.id,
        payload={"before": before, "after": {key: str(value) for key, value in changes.items()}},
    )

    result = MenuCategoryOut.model_validate(category)
    session.commit()
    return result


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("", response_model=list[MenuItemOut])
def list_menu(
    available_only: bool = Query(default=False, description="Chỉ trả món đang is_available=True"),
    q: str | None = Query(
        default=None,
        max_length=100,
        description="Tìm món có tên chứa chuỗi này (không phân biệt hoa thường)",
    ),
    category_id: uuid.UUID | None = Query(default=None, description="Chỉ lấy món thuộc nhóm này"),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[MenuItemOut]:
    stmt = select(MenuItem).where(MenuItem.outlet_id == current.outlet_id)
    if available_only:
        stmt = stmt.where(MenuItem.is_available.is_(True))
    if q and q.strip():
        stmt = stmt.where(MenuItem.name.ilike(f"%{_escape_like(q.strip())}%", escape="\\"))
    if category_id is not None:
        stmt = stmt.where(MenuItem.category_id == category_id)
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
    if payload.category_id is not None:
        _ensure_category_in_outlet(session, payload.category_id, current.outlet_id)

    item = MenuItem(
        outlet_id=current.outlet_id,
        station_id=payload.station_id,
        category_id=payload.category_id,
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
    if changes.get("category_id") is not None:
        _ensure_category_in_outlet(session, changes["category_id"], current.outlet_id)

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
