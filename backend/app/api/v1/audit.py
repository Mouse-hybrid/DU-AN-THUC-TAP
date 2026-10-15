"""Tra cứu nhật ký thao tác (audit_log) và lịch sử phiên bản order — chỉ đọc,
chỉ Supervisor (BRD Supervisor: "Monitor all operations"; audit chứa thao tác
của mọi nhân viên nên không mở cho role khác).

GET /api/v1/audit-logs              — lọc theo order (gồm cả các món của order),
                                      entity, action, nhân viên, thời gian.
GET /api/v1/orders/{id}/versions    — các snapshot order_version kèm người tạo.

Dùng cho QA lấy bằng chứng (actor, thời điểm) mà không cần vào database staging.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import CurrentStaff, require_role
from app.db.base import get_session
from app.db.models import AuditLog, Order, OrderItem, OrderVersion, Staff
from app.schemas.audit import AuditLogOut, OrderVersionOut

router = APIRouter(tags=["audit"])

_AUDIT_READ_ROLES = ("SUPERVISOR",)


def _parse_json(raw: str | None):
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _load_order_or_404(session: Session, order_id: uuid.UUID, outlet_id: uuid.UUID) -> Order:
    order = session.get(Order, order_id)
    if order is None or order.table_session.table.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy order")
    return order


@router.get("/audit-logs", response_model=list[AuditLogOut])
def list_audit_logs(
    order_id: uuid.UUID | None = Query(
        default=None, description="Thao tác trên order này và trên mọi món của nó"
    ),
    entity_id: list[str] | None = Query(default=None, description="Lặp lại được"),
    entity_type: str | None = Query(default=None, description="vd order, order_item, table"),
    action: list[str] | None = Query(
        default=None, description="Lặp lại được, vd ORDER_ITEM_REFIRED"
    ),
    staff_id: uuid.UUID | None = Query(default=None),
    created_from: datetime | None = Query(default=None, description="created_at >= (ISO 8601)"),
    created_to: datetime | None = Query(default=None, description="created_at < (ISO 8601)"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    current: CurrentStaff = Depends(require_role(*_AUDIT_READ_ROLES)),
    session: Session = Depends(get_session),
) -> list[AuditLogOut]:
    """Nhật ký thao tác của outlet, cũ nhất trước (đọc theo đúng trình tự xảy ra)."""
    stmt = (
        select(AuditLog, Staff)
        .outerjoin(Staff, Staff.id == AuditLog.staff_id)
        .where(AuditLog.outlet_id == current.outlet_id)
        .order_by(AuditLog.created_at, AuditLog.id)
        .limit(limit)
        .offset(offset)
    )
    entity_ids = set(entity_id or ())
    if order_id is not None:
        order = _load_order_or_404(session, order_id, current.outlet_id)
        entity_ids.add(str(order.id))
        entity_ids.update(
            str(item_id)
            for item_id in session.scalars(
                select(OrderItem.id).where(OrderItem.order_id == order.id)
            )
        )
    if entity_ids:
        stmt = stmt.where(AuditLog.entity_id.in_(entity_ids))
    if entity_type is not None:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if action:
        stmt = stmt.where(AuditLog.action.in_(action))
    if staff_id is not None:
        stmt = stmt.where(AuditLog.staff_id == staff_id)
    if created_from is not None:
        stmt = stmt.where(AuditLog.created_at >= created_from)
    if created_to is not None:
        stmt = stmt.where(AuditLog.created_at < created_to)

    return [
        AuditLogOut(
            id=log.id,
            action=log.action,
            entity_type=log.entity_type,
            entity_id=log.entity_id,
            staff_id=log.staff_id,
            staff_username=staff.username if staff else None,
            staff_role=staff.role if staff else None,
            payload=_parse_json(log.payload),
            created_at=log.created_at,
        )
        for log, staff in session.execute(stmt).all()
    ]


@router.get("/orders/{order_id}/versions", response_model=list[OrderVersionOut])
def list_order_versions(
    order_id: uuid.UUID,
    current: CurrentStaff = Depends(require_role(*_AUDIT_READ_ROLES)),
    session: Session = Depends(get_session),
) -> list[OrderVersionOut]:
    """Các snapshot order_version đã lưu, kèm nhân viên tạo ra từng version. Không
    phải số version nào cũng có snapshot: thêm món chỉ tăng current_version, còn gửi
    bếp, sửa/bỏ món, void, refire mới lưu snapshot."""
    order = _load_order_or_404(session, order_id, current.outlet_id)
    rows = session.execute(
        select(OrderVersion, Staff)
        .outerjoin(Staff, Staff.id == OrderVersion.created_by_staff_id)
        .where(OrderVersion.order_id == order.id)
        .order_by(OrderVersion.version_number)
    ).all()
    return [
        OrderVersionOut(
            version_number=version.version_number,
            created_at=version.created_at,
            created_by_staff_id=version.created_by_staff_id,
            created_by_username=staff.username if staff else None,
            created_by_role=staff.role if staff else None,
            snapshot=_parse_json(version.snapshot),
        )
        for version, staff in rows
    ]
