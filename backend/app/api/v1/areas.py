"""Tầng/khu của nhà hàng (BE-S3-01, Figma màn 03 Tổng quan khu vực).

GET   /api/v1/areas       — danh sách khu kèm số bàn theo trạng thái (mọi role đã đăng nhập).
POST  /api/v1/areas       — thêm khu.
PATCH /api/v1/areas/{id}  — đổi tên, thứ tự; ẩn khu bằng `is_active: false`.

Không có API xóa, giống nhóm món. Khu còn bàn thì không ẩn được: chuyển bàn đi trước
(PATCH /api/v1/tables/{id}), tránh bàn nằm trong một khu không còn hiển thị.
"""

from __future__ import annotations

import uuid
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
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
from app.db.models import IdempotencyKey, RestaurantTable, TableArea
from app.schemas.areas import AreaCreate, AreaOut, AreaUpdate

router = APIRouter(prefix="/areas", tags=["areas"])


def _status_counts(
    session: Session, outlet_id: uuid.UUID
) -> dict[uuid.UUID, dict[str, int]]:
    rows = session.execute(
        select(RestaurantTable.area_id, RestaurantTable.status, func.count())
        .where(RestaurantTable.outlet_id == outlet_id, RestaurantTable.area_id.is_not(None))
        .group_by(RestaurantTable.area_id, RestaurantTable.status)
    ).all()
    counts: dict[uuid.UUID, dict[str, int]] = defaultdict(dict)
    for area_id, table_status, count in rows:
        counts[area_id][table_status] = count
    return counts


def _area_out(area: TableArea, counts: dict[str, int] | None = None) -> AreaOut:
    counts = counts or {}
    return AreaOut(
        id=area.id,
        name=area.name,
        sort_order=area.sort_order,
        is_active=area.is_active,
        table_count=sum(counts.values()),
        status_counts=counts,
    )


def _ensure_area_name_free(
    session: Session, name: str, outlet_id: uuid.UUID, exclude_id: uuid.UUID | None = None
) -> None:
    stmt = select(TableArea.id).where(TableArea.outlet_id == outlet_id, TableArea.name == name)
    if exclude_id is not None:
        stmt = stmt.where(TableArea.id != exclude_id)
    if session.execute(stmt).first() is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"Khu '{name}' đã tồn tại")


@router.get("", response_model=list[AreaOut])
def list_areas(
    active_only: bool = Query(default=False, description="Chỉ trả khu đang is_active=True"),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[AreaOut]:
    stmt = select(TableArea).where(TableArea.outlet_id == current.outlet_id)
    if active_only:
        stmt = stmt.where(TableArea.is_active.is_(True))
    stmt = stmt.order_by(TableArea.sort_order, TableArea.name)
    counts = _status_counts(session, current.outlet_id)
    return [_area_out(area, counts.get(area.id)) for area in session.scalars(stmt).all()]


@router.post("", response_model=AreaOut, status_code=status.HTTP_201_CREATED)
def create_area(
    payload: AreaCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_LAYOUT_MANAGE)),
    session: Session = Depends(get_session),
) -> AreaOut:
    endpoint = "POST /api/v1/areas"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return AreaOut.model_validate_json(existing.response_body)

    _ensure_area_name_free(session, payload.name, current.outlet_id)
    area = TableArea(
        outlet_id=current.outlet_id,
        name=payload.name,
        sort_order=payload.sort_order,
        is_active=True,
    )
    session.add(area)
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="TABLE_AREA_CREATED",
        entity_type="table_area",
        entity_id=area.id,
        payload={"name": area.name},
    )

    result = _area_out(area)
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


@router.patch("/{area_id}", response_model=AreaOut)
def update_area(
    area_id: uuid.UUID,
    payload: AreaUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_LAYOUT_MANAGE)),
    session: Session = Depends(get_session),
) -> AreaOut:
    area = session.get(TableArea, area_id)
    if area is None or area.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy khu")

    changes = payload.model_dump(exclude_unset=True)
    if not changes or None in changes.values():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Cần ít nhất 1 trường; name/sort_order/is_active không được null",
        )

    counts = _status_counts(session, current.outlet_id).get(area.id)
    if "name" in changes:
        _ensure_area_name_free(session, changes["name"], current.outlet_id, exclude_id=area.id)
    if changes.get("is_active") is False and counts:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Khu vẫn còn bàn, hãy chuyển bàn sang khu khác trước khi ẩn",
        )

    for field, value in changes.items():
        setattr(area, field, value)
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="TABLE_AREA_UPDATED",
        entity_type="table_area",
        entity_id=area.id,
        payload=changes,
    )
    session.commit()
    return _area_out(area, counts)
