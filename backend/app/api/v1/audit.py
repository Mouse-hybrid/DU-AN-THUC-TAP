"""Tra cứu và báo cáo nhật ký thao tác (audit_log), lịch sử phiên bản order — chỉ đọc,
chỉ Supervisor (BRD Supervisor: "Monitor all operations"; audit chứa thao tác của mọi nhân
viên nên không mở cho role khác).

GET /api/v1/audit-logs              — lọc theo order (gồm cả các món của order), entity,
                                      action, nhân viên, thời gian; header X-Total-Count.
GET /api/v1/audit-logs/summary      — báo cáo: đếm theo thao tác, nhân viên, ngày; tách riêng
                                      thao tác ngoại lệ (Rollout board "Audit Search/Report").
GET /api/v1/audit-logs/export       — tải CSV cùng bộ lọc với danh sách.
GET /api/v1/orders/{id}/versions    — các snapshot order_version kèm người tạo.

Dùng cho QA lấy bằng chứng (actor, thời điểm) mà không cần vào database staging.
"""

from __future__ import annotations

import csv
import io
import json
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.deps import CurrentStaff, require_permission
from app.core.permissions import Permission
from app.db.base import get_session
from app.db.models import AuditLog, Order, OrderItem, OrderVersion, Staff
from app.schemas.audit import (
    ActionCount,
    AuditLogOut,
    AuditSummaryOut,
    DayCount,
    OrderVersionOut,
    StaffCount,
)

router = APIRouter(tags=["audit"])

# Thao tác ngoại lệ: làm đổi tiền, đổi món đã vào bếp, hoặc đổi quyền. Báo cáo tách riêng để
# giám sát rà soát (BRD Supervisor: "Monitor all operations", "Override Actions").
EXCEPTION_ACTIONS = frozenset(
    {
        "ORDER_ITEM_VOIDED",
        "ORDER_ITEM_REFIRED",
        "ORDER_REWARD_OVERRIDDEN",
        "POINTS_ADJUSTED",
        "STAFF_LOCKED",
        "STAFF_PASSWORD_RESET",
        "STAFF_UPDATED",
        "MENU_ITEM_UPDATED",
        "LOYALTY_RULE_CREATED",
        "STAGING_DATA_RESET",
        "PAYMENT_CANCELLED",
        "PAYMENT_REFUNDED",
        "ROLE_PERMISSION_UPDATED",
        "ROLE_PERMISSIONS_RESET",
    }
)
VN_TZ = timezone(timedelta(hours=7))
SUMMARY_DEFAULT_DAYS = 7
SUMMARY_MAX_DAYS = 93
EXPORT_MAX_ROWS = 10_000


def _parse_json(raw: str | None):
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _as_utc(value: datetime) -> datetime:
    # SQLite (test) trả datetime không có múi giờ; giờ lưu là UTC.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _load_order_or_404(session: Session, order_id: uuid.UUID, outlet_id: uuid.UUID) -> Order:
    order = session.get(Order, order_id)
    if order is None or order.table_session.table.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy order")
    return order


@dataclass
class AuditFilters:
    order_id: uuid.UUID | None = None
    entity_id: list[str] | None = None
    entity_type: str | None = None
    action: list[str] | None = None
    staff_id: uuid.UUID | None = None
    created_from: datetime | None = None
    created_to: datetime | None = None


def audit_filters(
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
) -> AuditFilters:
    return AuditFilters(
        order_id, entity_id, entity_type, action, staff_id, created_from, created_to
    )


def _apply_filters(stmt, session: Session, current: CurrentStaff, filters: AuditFilters):
    stmt = stmt.where(AuditLog.outlet_id == current.outlet_id)
    entity_ids = set(filters.entity_id or ())
    if filters.order_id is not None:
        order = _load_order_or_404(session, filters.order_id, current.outlet_id)
        entity_ids.add(str(order.id))
        entity_ids.update(
            str(item_id)
            for item_id in session.scalars(
                select(OrderItem.id).where(OrderItem.order_id == order.id)
            )
        )
    if entity_ids:
        stmt = stmt.where(AuditLog.entity_id.in_(entity_ids))
    if filters.entity_type is not None:
        stmt = stmt.where(AuditLog.entity_type == filters.entity_type)
    if filters.action:
        stmt = stmt.where(AuditLog.action.in_(filters.action))
    if filters.staff_id is not None:
        stmt = stmt.where(AuditLog.staff_id == filters.staff_id)
    if filters.created_from is not None:
        stmt = stmt.where(AuditLog.created_at >= filters.created_from)
    if filters.created_to is not None:
        stmt = stmt.where(AuditLog.created_at < filters.created_to)
    return stmt


def _log_out(log: AuditLog, staff: Staff | None) -> AuditLogOut:
    return AuditLogOut(
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


@router.get("/audit-logs", response_model=list[AuditLogOut])
def list_audit_logs(
    response: Response,
    filters: AuditFilters = Depends(audit_filters),
    sort: Literal["asc", "desc"] = Query(
        default="asc", description="asc: cũ nhất trước (mặc định); desc: mới nhất trước"
    ),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    current: CurrentStaff = Depends(require_permission(Permission.AUDIT_READ)),
    session: Session = Depends(get_session),
) -> list[AuditLogOut]:
    """Nhật ký thao tác của outlet. Thứ tự luôn xác định: created_at rồi id, cùng chiều."""
    base = _apply_filters(select(AuditLog, Staff), session, current, filters)
    total = session.scalar(
        _apply_filters(select(func.count()).select_from(AuditLog), session, current, filters)
    )
    response.headers["X-Total-Count"] = str(total)
    order_by = (
        (AuditLog.created_at, AuditLog.id)
        if sort == "asc"
        else (AuditLog.created_at.desc(), AuditLog.id.desc())
    )
    stmt = (
        base.outerjoin(Staff, Staff.id == AuditLog.staff_id)
        .order_by(*order_by)
        .limit(limit)
        .offset(offset)
    )
    return [_log_out(log, staff) for log, staff in session.execute(stmt).all()]


@router.get("/audit-logs/summary", response_model=AuditSummaryOut)
def audit_summary(
    filters: AuditFilters = Depends(audit_filters),
    current: CurrentStaff = Depends(require_permission(Permission.AUDIT_READ)),
    session: Session = Depends(get_session),
) -> AuditSummaryOut:
    """Báo cáo trong một khoảng thời gian (mặc định 7 ngày gần nhất, tối đa 93 ngày): tổng số
    thao tác, theo loại thao tác, theo nhân viên, theo ngày (giờ Việt Nam), và số thao tác
    ngoại lệ. Nhận cùng bộ lọc với danh sách."""
    now = datetime.now(timezone.utc)
    created_to = _as_utc(filters.created_to) if filters.created_to else now
    created_from = (
        _as_utc(filters.created_from)
        if filters.created_from
        else created_to - timedelta(days=SUMMARY_DEFAULT_DAYS)
    )
    if created_from >= created_to:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="created_from phải trước created_to"
        )
    if created_to - created_from > timedelta(days=SUMMARY_MAX_DAYS):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Khoảng thời gian tối đa {SUMMARY_MAX_DAYS} ngày",
        )
    filters.created_from, filters.created_to = created_from, created_to

    rows = session.execute(
        _apply_filters(
            select(AuditLog.action, AuditLog.staff_id, AuditLog.created_at),
            session,
            current,
            filters,
        )
    ).all()

    by_action = Counter(action for action, _staff, _at in rows)
    by_day = Counter(_as_utc(at).astimezone(VN_TZ).date() for _action, _staff, at in rows)
    per_staff: dict[uuid.UUID | None, list[int]] = defaultdict(lambda: [0, 0])
    for action, staff_id, _at in rows:
        per_staff[staff_id][0] += 1
        per_staff[staff_id][1] += action in EXCEPTION_ACTIONS

    staff_ids = [staff_id for staff_id in per_staff if staff_id is not None]
    staff_by_id = (
        {s.id: s for s in session.scalars(select(Staff).where(Staff.id.in_(staff_ids)))}
        if staff_ids
        else {}
    )
    by_staff = [
        StaffCount(
            staff_id=staff_id,
            username=staff_by_id[staff_id].username if staff_id in staff_by_id else None,
            role=staff_by_id[staff_id].role if staff_id in staff_by_id else None,
            count=count,
            exception_count=exceptions,
        )
        for staff_id, (count, exceptions) in per_staff.items()
    ]
    by_staff.sort(key=lambda row: (-row.count, row.username or ""))

    return AuditSummaryOut(
        created_from=created_from,
        created_to=created_to,
        total=len(rows),
        exception_total=sum(by_action[action] for action in EXCEPTION_ACTIONS),
        by_action=[
            ActionCount(action=action, count=count, is_exception=action in EXCEPTION_ACTIONS)
            for action, count in sorted(by_action.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        by_staff=by_staff,
        by_day=[DayCount(date=day, count=count) for day, count in sorted(by_day.items())],
    )


def _csv_cell(value) -> str:
    """Chặn công thức khi mở bằng Excel: ô bắt đầu bằng = + - @ bị coi là công thức."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


@router.get("/audit-logs/export")
def export_audit_logs(
    filters: AuditFilters = Depends(audit_filters),
    current: CurrentStaff = Depends(require_permission(Permission.AUDIT_READ)),
    session: Session = Depends(get_session),
) -> Response:
    """CSV (UTF-8 có BOM để Excel đọc đúng tiếng Việt), cũ nhất trước, giờ Việt Nam. Tối đa
    10.000 dòng; vượt thì header X-Truncated: true, hãy thu hẹp bộ lọc."""
    stmt = (
        _apply_filters(select(AuditLog, Staff), session, current, filters)
        .outerjoin(Staff, Staff.id == AuditLog.staff_id)
        .order_by(AuditLog.created_at, AuditLog.id)
        .limit(EXPORT_MAX_ROWS + 1)
    )
    rows = session.execute(stmt).all()
    truncated = len(rows) > EXPORT_MAX_ROWS
    rows = rows[:EXPORT_MAX_ROWS]

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "created_at",
            "action",
            "exception",
            "entity_type",
            "entity_id",
            "staff_username",
            "staff_role",
            "payload",
        ]
    )
    for log, staff in rows:
        writer.writerow(
            [
                _as_utc(log.created_at).astimezone(VN_TZ).isoformat(),
                log.action,
                "x" if log.action in EXCEPTION_ACTIONS else "",
                log.entity_type,
                log.entity_id,
                _csv_cell(staff.username if staff else None),
                staff.role if staff else "",
                _csv_cell(log.payload),
            ]
        )
    filename = f"audit-log-{datetime.now(VN_TZ):%Y%m%d-%H%M}.csv"
    return Response(
        content="﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Truncated": "true" if truncated else "false",
        },
    )


@router.get("/orders/{order_id}/versions", response_model=list[OrderVersionOut])
def list_order_versions(
    order_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.AUDIT_READ)),
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
