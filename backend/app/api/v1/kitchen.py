"""Màn hình bếp (KDS) — chỉ đọc.

GET /api/v1/kitchen/queue     — các món đang chờ/đang nấu, cũ nhất lên trước, kèm
                                sla_status (NORMAL/WARNING/DELAYED/CRITICAL).
                                ?delayed_only=true -> chỉ món DELAYED/CRITICAL (Figma
                                screen-33 "delayed orders queue").
GET /api/v1/kitchen/stations  — danh sách trạm bếp của outlet (để gán món vào trạm).

SLA theo BRD BR-KDS-SLA-001..003: timer bắt đầu khi món vào PREPARING (queue
IN_PROGRESS, started_at), dừng khi READY; giờ server là nguồn chuẩn (edge case
"kitchen changes system clock"). Ngưỡng phút cấu hình qua env KDS_SLA_* (mặc
định 8/12/15 theo test case QA DSG-QA-06, chờ PO xác nhận).

Các bước đổi trạng thái (start-cooking, mark-ready...) nằm ở orders.py (BE-S1-06).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import (
    KDS_SLA_CRITICAL_MINUTES,
    KDS_SLA_DELAYED_MINUTES,
    KDS_SLA_WARNING_MINUTES,
)
from app.core.deps import CurrentStaff, get_current_staff, require_role
from app.db.base import get_session
from app.db.models import (
    KITCHEN_QUEUE_STATUS,
    KitchenQueue,
    KitchenStation,
    MenuItem,
    Order,
    OrderItem,
    RestaurantTable,
    TableSession,
)
from app.schemas.kitchen import KitchenQueueEntryOut, KitchenStationOut

router = APIRouter(prefix="/kitchen", tags=["kitchen"])

# = "View KDS" trong Permission Matrix của BRD: Kitchen + Supervisor.
_VIEW_KDS_ROLES = ("KITCHEN", "SUPERVISOR")
_ACTIVE_QUEUE_STATUSES = ("QUEUED", "IN_PROGRESS")
_DELAYED_SLA_STATUSES = ("DELAYED", "CRITICAL")


def compute_sla(
    queue_status: str, started_at: datetime | None, now: datetime
) -> tuple[float | None, str]:
    """Trả (số phút đã nấu, sla_status). Chỉ món IN_PROGRESS mới chạy timer."""
    if queue_status != "IN_PROGRESS" or started_at is None:
        return None, "NORMAL"
    if started_at.tzinfo is None:  # SQLite trả datetime naive — DB luôn lưu UTC
        started_at = started_at.replace(tzinfo=timezone.utc)
    elapsed = max((now - started_at).total_seconds() / 60, 0.0)
    if elapsed >= KDS_SLA_CRITICAL_MINUTES:
        sla = "CRITICAL"
    elif elapsed >= KDS_SLA_DELAYED_MINUTES:
        sla = "DELAYED"
    elif elapsed >= KDS_SLA_WARNING_MINUTES:
        sla = "WARNING"
    else:
        sla = "NORMAL"
    return round(elapsed, 1), sla


@router.get("/queue", response_model=list[KitchenQueueEntryOut])
def kitchen_queue(
    station_id: uuid.UUID | None = Query(default=None, description="Chỉ lấy 1 trạm bếp"),
    queue_status: str | None = Query(
        default=None,
        alias="status",
        description="QUEUED | IN_PROGRESS | DONE | CANCELLED. Mặc định: QUEUED + IN_PROGRESS",
    ),
    delayed_only: bool = Query(
        default=False, description="Chỉ trả món đang nấu quá ngưỡng (DELAYED/CRITICAL)"
    ),
    current: CurrentStaff = Depends(require_role(*_VIEW_KDS_ROLES)),
    session: Session = Depends(get_session),
) -> list[KitchenQueueEntryOut]:
    if queue_status is not None and queue_status not in KITCHEN_QUEUE_STATUS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status phải là một trong {', '.join(KITCHEN_QUEUE_STATUS)}",
        )
    statuses = (queue_status,) if queue_status else _ACTIVE_QUEUE_STATUSES

    stmt = (
        select(KitchenQueue, OrderItem, MenuItem, Order, RestaurantTable)
        .join(OrderItem, KitchenQueue.order_item_id == OrderItem.id)
        .join(MenuItem, OrderItem.menu_item_id == MenuItem.id)
        .join(Order, OrderItem.order_id == Order.id)
        .join(TableSession, Order.table_session_id == TableSession.id)
        .join(RestaurantTable, TableSession.table_id == RestaurantTable.id)
        .where(RestaurantTable.outlet_id == current.outlet_id)
        .where(KitchenQueue.status.in_(statuses))
        .order_by(KitchenQueue.queued_at)
    )
    if station_id is not None:
        stmt = stmt.where(KitchenQueue.station_id == station_id)

    now = datetime.now(timezone.utc)
    entries: list[KitchenQueueEntryOut] = []
    for queue_entry, order_item, menu_item, order, table in session.execute(stmt).all():
        elapsed, sla_status = compute_sla(queue_entry.status, queue_entry.started_at, now)
        if delayed_only and sla_status not in _DELAYED_SLA_STATUSES:
            continue
        entries.append(
            KitchenQueueEntryOut(
                id=queue_entry.id,
                order_id=order.id,
                order_item_id=order_item.id,
                table_code=table.code,
                menu_item_name=menu_item.name,
                quantity=order_item.quantity,
                note=order_item.note,
                station_id=queue_entry.station_id,
                status=queue_entry.status,
                queued_at=queue_entry.queued_at,
                started_at=queue_entry.started_at,
                elapsed_minutes=elapsed,
                sla_status=sla_status,
            )
        )
    return entries


@router.get("/stations", response_model=list[KitchenStationOut])
def list_kitchen_stations(
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[KitchenStationOut]:
    stations = (
        session.execute(
            select(KitchenStation)
            .where(KitchenStation.outlet_id == current.outlet_id)
            .order_by(KitchenStation.name)
        )
        .scalars()
        .all()
    )
    return [KitchenStationOut.model_validate(station) for station in stations]
