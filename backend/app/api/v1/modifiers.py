"""Tùy chọn món (phiếu quyết định B7: size và topping có giá cộng thêm, chưa có combo).

GET   /api/v1/menu/{item_id}/modifiers         — mọi role đã đăng nhập, cho POS.
POST  /api/v1/menu/{item_id}/modifiers         — thêm nhóm kèm tùy chọn.
PATCH /api/v1/menu/modifiers/{group_id}        — sửa nhóm; ẩn bằng `is_active: false`.
POST  /api/v1/menu/modifiers/{group_id}/options — thêm tùy chọn.
PATCH /api/v1/menu/modifier-options/{option_id} — sửa tùy chọn; hết hàng bằng `is_available: false`.

Không có API xóa, giống món và nhóm món. Khi gọi món, gửi `modifier_option_ids` (xem
app/core/modifiers.py); giá của dòng món đã gồm giá cộng thêm.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_current_staff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.permissions import Permission
from app.db.base import get_session
from app.db.models import IdempotencyKey, MenuItem, ModifierGroup, ModifierOption
from app.schemas.menu import (
    ModifierGroupCreate,
    ModifierGroupOut,
    ModifierGroupUpdate,
    ModifierOptionCreate,
    ModifierOptionOut,
    ModifierOptionUpdate,
)

router = APIRouter(prefix="/menu", tags=["menu"])


def _item_or_404(session: Session, item_id: uuid.UUID, outlet_id: uuid.UUID) -> MenuItem:
    item = session.get(MenuItem, item_id)
    if item is None or item.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy món")
    return item


def _group_or_404(session: Session, group_id: uuid.UUID, outlet_id: uuid.UUID) -> ModifierGroup:
    group = session.get(ModifierGroup, group_id)
    if group is None or group.menu_item.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy nhóm tùy chọn")
    return group


def _ensure_select_range(min_select: int, max_select: int) -> None:
    if min_select > max_select:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="min_select không được lớn hơn max_select",
        )


def _changes(payload) -> dict:
    changes = payload.model_dump(exclude_unset=True)
    if not changes or None in changes.values():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Cần ít nhất 1 trường và không trường nào được null",
        )
    return changes


def _audit(session: Session, current: CurrentStaff, action: str, entity_id, payload: dict) -> None:
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action=action,
        entity_type="modifier",
        entity_id=entity_id,
        payload=payload,
    )


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


@router.get("/{item_id}/modifiers", response_model=list[ModifierGroupOut])
def list_modifiers(
    item_id: uuid.UUID,
    active_only: bool = Query(default=False, description="Chỉ trả nhóm đang is_active=True"),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[ModifierGroupOut]:
    item = _item_or_404(session, item_id, current.outlet_id)
    groups = item.active_modifier_groups if active_only else item.modifier_groups
    return [ModifierGroupOut.model_validate(group) for group in groups]


@router.post(
    "/{item_id}/modifiers", response_model=ModifierGroupOut, status_code=status.HTTP_201_CREATED
)
def create_modifier_group(
    item_id: uuid.UUID,
    payload: ModifierGroupCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.MENU_WRITE)),
    session: Session = Depends(get_session),
) -> ModifierGroupOut:
    endpoint = f"POST /api/v1/menu/{item_id}/modifiers"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        return ModifierGroupOut.model_validate_json(existing.response_body)

    item = _item_or_404(session, item_id, current.outlet_id)
    _ensure_select_range(payload.min_select, payload.max_select)
    if payload.min_select > len(payload.options):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="min_select không được lớn hơn số tùy chọn",
        )
    if len({option.name for option in payload.options}) != len(payload.options):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Tùy chọn bị trùng tên")
    if any(group.name == payload.name for group in item.modifier_groups):
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"Nhóm '{payload.name}' đã tồn tại")

    group = ModifierGroup(
        menu_item_id=item.id,
        name=payload.name,
        min_select=payload.min_select,
        max_select=payload.max_select,
        sort_order=payload.sort_order,
        options=[ModifierOption(**option.model_dump()) for option in payload.options],
    )
    session.add(group)
    session.flush()
    session.refresh(group)
    _audit(
        session,
        current,
        "MODIFIER_GROUP_CREATED",
        group.id,
        {"menu_item_id": str(item.id), "name": group.name},
    )

    result = ModifierGroupOut.model_validate(group)
    _remember(session, idempotency_key, endpoint, request_hash, result.model_dump_json())
    session.commit()
    return result


@router.patch("/modifiers/{group_id}", response_model=ModifierGroupOut)
def update_modifier_group(
    group_id: uuid.UUID,
    payload: ModifierGroupUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.MENU_WRITE)),
    session: Session = Depends(get_session),
) -> ModifierGroupOut:
    group = _group_or_404(session, group_id, current.outlet_id)
    changes = _changes(payload)
    _ensure_select_range(
        changes.get("min_select", group.min_select), changes.get("max_select", group.max_select)
    )
    name = changes.get("name")
    if name and any(g.name == name and g.id != group.id for g in group.menu_item.modifier_groups):
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"Nhóm '{name}' đã tồn tại")

    for field, value in changes.items():
        setattr(group, field, value)
    _audit(session, current, "MODIFIER_GROUP_UPDATED", group.id, changes)
    session.commit()
    session.refresh(group)
    return ModifierGroupOut.model_validate(group)


@router.post(
    "/modifiers/{group_id}/options",
    response_model=ModifierOptionOut,
    status_code=status.HTTP_201_CREATED,
)
def create_modifier_option(
    group_id: uuid.UUID,
    payload: ModifierOptionCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.MENU_WRITE)),
    session: Session = Depends(get_session),
) -> ModifierOptionOut:
    endpoint = f"POST /api/v1/menu/modifiers/{group_id}/options"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        return ModifierOptionOut.model_validate_json(existing.response_body)

    group = _group_or_404(session, group_id, current.outlet_id)
    if any(option.name == payload.name for option in group.options):
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail=f"Tùy chọn '{payload.name}' đã tồn tại"
        )
    option = ModifierOption(group_id=group.id, **payload.model_dump())
    session.add(option)
    session.flush()
    _audit(
        session,
        current,
        "MODIFIER_OPTION_CREATED",
        option.id,
        {"group_id": str(group.id), "name": option.name, "price_delta": option.price_delta},
    )

    result = ModifierOptionOut.model_validate(option)
    _remember(session, idempotency_key, endpoint, request_hash, result.model_dump_json())
    session.commit()
    return result


@router.patch("/modifier-options/{option_id}", response_model=ModifierOptionOut)
def update_modifier_option(
    option_id: uuid.UUID,
    payload: ModifierOptionUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.MENU_WRITE)),
    session: Session = Depends(get_session),
) -> ModifierOptionOut:
    option = session.get(ModifierOption, option_id)
    if option is None or option.group.menu_item.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy tùy chọn")
    changes = _changes(payload)
    name = changes.get("name")
    if name and any(o.name == name and o.id != option.id for o in option.group.options):
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"Tùy chọn '{name}' đã tồn tại")

    for field, value in changes.items():
        setattr(option, field, value)
    _audit(session, current, "MODIFIER_OPTION_UPDATED", option.id, changes)
    session.commit()
    session.refresh(option)
    return ModifierOptionOut.model_validate(option)
