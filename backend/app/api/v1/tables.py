"""Quản lý bàn: mở bàn (vertical slice bước 1), dashboard bàn, xác nhận dọn bàn.

GET  /api/v1/tables?area_id=                     — dashboard: mọi bàn của outlet + phiên đang mở.
GET  /api/v1/tables/{table_id}                   — chi tiết bàn: phiên đang mở + các order kèm món.
PATCH /api/v1/tables/{table_id}                  — gán bàn vào tầng/khu (xem areas.py).
POST /api/v1/tables/{table_id}/transfer          — chuyển khách sang bàn khác.
POST /api/v1/tables/{table_id}/merge             — gộp bàn khác vào bàn này: một phiên, một đơn.
POST /api/v1/tables/{table_id}/mark-clean        — CLEANING -> AVAILABLE (xác nhận đã dọn xong).
                                                    (Bàn vào CLEANING khi order được pay, xem
                                                    orders.py — pay đóng luôn table_session.)

POST /api/v1/tables/{table_id}/open-session
  - Chỉ mở được khi bàn đang AVAILABLE hoặc RESERVED (BRD state machine).
  - Tạo table_session mới (status OPEN) + chuyển bàn sang OCCUPIED.
  - Bắt buộc header Idempotency-Key (NFR) — bấm "Mở bàn" 2 lần do mạng chậm
    không được tạo 2 table_session.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.v1.orders import _snapshot_order, build_order_detail
from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_current_staff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.loyalty import active_order_reward
from app.core.permissions import Permission
from app.core.realtime import manager
from app.db.base import get_session
from app.db.models import (
    IdempotencyKey,
    Order,
    OrderVersion,
    RestaurantTable,
    TableArea,
    TableSession,
)
from app.schemas.tables import (
    OpenSessionRequest,
    TableAreaAssign,
    TableDashboardItem,
    TableDetailOut,
    TableMergeOut,
    TableMergeRequest,
    TableOut,
    TableSessionOut,
    TableTransferOut,
    TableTransferRequest,
)

router = APIRouter(prefix="/tables", tags=["tables"])

_OPENABLE_STATUSES = ("AVAILABLE", "RESERVED")


def _lock_table(session: Session, table_id: uuid.UUID) -> RestaurantTable | None:
    """Khóa dòng bàn tới hết transaction: 2 lần mở cùng 1 bàn đồng thời (khác
    Idempotency-Key) không được tạo 2 phiên — request sau thấy bàn đã OCCUPIED -> 409."""
    return session.execute(
        select(RestaurantTable).where(RestaurantTable.id == table_id).with_for_update()
    ).scalar_one_or_none()


@router.post(
    "/{table_id}/open-session", response_model=TableSessionOut, status_code=status.HTTP_201_CREATED
)
def open_table_session(
    table_id: uuid.UUID,
    payload: OpenSessionRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_OPEN)),
    session: Session = Depends(get_session),
) -> TableSessionOut:
    endpoint = f"POST /api/v1/tables/{table_id}/open-session"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return TableSessionOut.model_validate_json(existing.response_body)

    table = _lock_table(session, table_id)
    if table is None or table.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn")
    if table.status not in _OPENABLE_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Bàn đang ở trạng thái '{table.status}', không thể mở phiên mới",
        )

    table_session = TableSession(
        table_id=table.id,
        status="OPEN",
        guest_count=payload.guest_count,
        opened_by_staff_id=current.id,
    )
    session.add(table_session)
    table.status = "OCCUPIED"

    session.flush()  # để có table_session.id trước khi ghi audit log

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="TABLE_SESSION_OPENED",
        entity_type="table_session",
        entity_id=table_session.id,
        payload={"table_id": str(table.id), "guest_count": payload.guest_count},
    )

    result = TableSessionOut.model_validate(table_session)

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
        current.outlet_id,
        "tables",
        "TABLE_SESSION_OPENED",
        {
            "table_id": str(table.id),
            "status": table.status,
            "table_session_id": str(table_session.id),
        },
    )
    return result


def _table_sort_key(table: RestaurantTable) -> list[tuple[int, int, str]]:
    """Sắp theo số trong mã bàn: B2 đứng trước B10 (ORDER BY code sẽ cho B10 trước B2)."""
    return [
        (0, int(part), "") if part.isdigit() else (1, 0, part)
        for part in re.split(r"(\d+)", table.code)
        if part
    ]


@router.get("", response_model=list[TableDashboardItem])
def table_dashboard(
    area_id: uuid.UUID | None = Query(default=None, description="Chỉ lấy bàn của khu này"),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[TableDashboardItem]:
    """Dashboard bàn: mọi bàn của outlet, kèm phiên OPEN hiện tại (nếu có).
    Mọi role đã đăng nhập đều xem được (xem trạng thái bàn không bị hạn chế
    trong Permission Matrix)."""
    stmt = (
        select(RestaurantTable)
        .options(selectinload(RestaurantTable.area))
        .where(RestaurantTable.outlet_id == current.outlet_id)
    )
    if area_id is not None:
        stmt = stmt.where(RestaurantTable.area_id == area_id)
    tables = sorted(session.scalars(stmt).all(), key=_table_sort_key)
    open_sessions: dict[uuid.UUID, TableSession] = {}
    if tables:
        rows = (
            session.execute(
                select(TableSession)
                .where(TableSession.status == "OPEN")
                .where(TableSession.table_id.in_([t.id for t in tables]))
                .order_by(TableSession.opened_at)
            )
            .scalars()
            .all()
        )
        open_sessions = {row.table_id: row for row in rows}

    items: list[TableDashboardItem] = []
    for table in tables:
        current_session = open_sessions.get(table.id)
        items.append(
            TableDashboardItem(
                id=table.id,
                code=table.code,
                seats=table.seats,
                status=table.status,
                area_id=table.area_id,
                area_name=table.area_name,
                merged_into_table_id=table.merged_into_table_id,
                current_session_id=current_session.id if current_session else None,
                guest_count=current_session.guest_count if current_session else None,
                opened_at=current_session.opened_at if current_session else None,
            )
        )
    return items


@router.get("/{table_id}", response_model=TableDetailOut)
def table_detail(
    table_id: uuid.UUID,
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> TableDetailOut:
    """Chi tiết bàn: phiên OPEN hiện tại (nếu có) + toàn bộ order của phiên đó,
    kèm tên món/thành tiền. Bàn không có phiên mở -> current_session=null, orders=[]."""
    table = session.get(RestaurantTable, table_id)
    if table is None or table.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn")

    open_session = (
        session.execute(
            select(TableSession)
            .where(TableSession.table_id == table.id, TableSession.status == "OPEN")
            .order_by(TableSession.opened_at.desc())
        )
        .scalars()
        .first()
    )
    orders: list[Order] = []
    if open_session is not None:
        orders = (
            session.execute(
                select(Order)
                .where(Order.table_session_id == open_session.id)
                .order_by(Order.created_at)
            )
            .scalars()
            .all()
        )

    return TableDetailOut(
        id=table.id,
        code=table.code,
        seats=table.seats,
        status=table.status,
        area_id=table.area_id,
        area_name=table.area_name,
        merged_into_table_id=table.merged_into_table_id,
        current_session=TableSessionOut.model_validate(open_session) if open_session else None,
        orders=[build_order_detail(session, order) for order in orders],
    )


@router.patch("/{table_id}", response_model=TableOut)
def assign_table_area(
    table_id: uuid.UUID,
    payload: TableAreaAssign,
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_LAYOUT_MANAGE)),
    session: Session = Depends(get_session),
) -> TableOut:
    """Gán bàn vào khu, hoặc bỏ ra khỏi khu với `area_id: null`. Không đụng trạng thái
    bàn nên đổi được cả khi bàn đang có khách."""
    table = session.get(RestaurantTable, table_id)
    if table is None or table.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn")

    if payload.area_id is not None:
        area = session.get(TableArea, payload.area_id)
        if area is None or area.outlet_id != current.outlet_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy khu")
        if not area.is_active:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="Khu đang bị ẩn")

    if table.area_id != payload.area_id:
        write_audit_log(
            session,
            outlet_id=current.outlet_id,
            staff_id=current.id,
            action="TABLE_AREA_CHANGED",
            entity_type="table",
            entity_id=table.id,
            payload={"from": table.area_id, "to": payload.area_id},
        )
        table.area_id = payload.area_id
        session.commit()
        session.refresh(table)
    return TableOut.model_validate(table)


@router.post("/{table_id}/transfer", response_model=TableTransferOut)
def transfer_table(
    table_id: uuid.UUID,
    payload: TableTransferRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_TRANSFER)),
    session: Session = Depends(get_session),
) -> TableTransferOut:
    """Chuyển khách sang bàn khác: cả phiên bàn đi theo, gồm mọi đơn, món, phiếu bếp, ưu đãi
    và mã QR (đều gắn với phiên nên không phải sửa từng thứ). Bàn đích phải trống hoặc đặt
    trước; bàn cũ sang CLEANING vì khách vừa ngồi. Bàn đang chờ thanh toán thì không chuyển,
    tránh lệch hóa đơn đã in."""
    endpoint = f"POST /api/v1/tables/{table_id}/transfer"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return TableTransferOut.model_validate_json(existing.response_body)

    if payload.target_table_id == table_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Bàn đích phải khác bàn hiện tại"
        )
    # Khóa theo thứ tự id: hai lần chuyển chéo nhau đồng thời không khóa chờ nhau mãi.
    locked = {}
    for locked_id in sorted((table_id, payload.target_table_id), key=str):
        locked[locked_id] = _lock_table(session, locked_id)
    source, target = locked[table_id], locked[payload.target_table_id]
    if source is None or source.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn")
    if target is None or target.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn đích")
    if source.status != "OCCUPIED":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Bàn đang ở trạng thái '{source.status}', chỉ chuyển được bàn đang có khách",
        )
    if target.status not in _OPENABLE_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Bàn đích đang ở trạng thái '{target.status}', phải là bàn trống",
        )
    if _merged_tables(session, source.id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="Bàn đang có bàn khác gộp vào, không chuyển được"
        )
    table_session = session.execute(
        select(TableSession)
        .where(TableSession.table_id == source.id, TableSession.status == "OPEN")
        .with_for_update()
    ).scalar_one_or_none()
    if table_session is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Bàn không có phiên đang mở")

    table_session.table_id = target.id
    target.status = "OCCUPIED"
    source.status = "CLEANING"
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="TABLE_TRANSFERRED",
        entity_type="table_session",
        entity_id=table_session.id,
        payload={
            "from_table_id": str(source.id),
            "from_table_code": source.code,
            "to_table_id": str(target.id),
            "to_table_code": target.code,
        },
    )
    result = TableTransferOut(
        table_session_id=table_session.id,
        from_table=TableOut.model_validate(source),
        to_table=TableOut.model_validate(target),
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
        "tables",
        "TABLE_TRANSFERRED",
        {
            "table_session_id": str(table_session.id),
            "from_table_id": str(source.id),
            "to_table_id": str(target.id),
        },
    )
    for table in (source, target):
        manager.publish(
            current.outlet_id,
            "tables",
            "TABLE_STATUS_CHANGED",
            {"table_id": str(table.id), "status": table.status},
        )
    # Màn bếp hiện mã bàn trên phiếu: báo tải lại (màn bếp chỉ nghe các event có sẵn).
    manager.publish(
        current.outlet_id,
        "kitchen",
        "KITCHEN_QUEUE_UPDATED",
        {"order_id": None, "items_sent": 0, "reason": "TABLE_TRANSFERRED"},
    )
    return result


def _merged_tables(session: Session, primary_id: uuid.UUID) -> list[RestaurantTable]:
    return list(
        session.scalars(
            select(RestaurantTable).where(RestaurantTable.merged_into_table_id == primary_id)
        )
    )


def _open_session(session: Session, table_id: uuid.UUID) -> TableSession | None:
    return session.execute(
        select(TableSession)
        .where(TableSession.table_id == table_id, TableSession.status == "OPEN")
        .with_for_update()
    ).scalar_one_or_none()


def _open_orders(session: Session, table_session_id: uuid.UUID) -> list[Order]:
    return list(
        session.scalars(
            select(Order)
            .where(
                Order.table_session_id == table_session_id,
                Order.status.in_(_MERGEABLE_ORDER_STATUSES),
            )
            .order_by(Order.created_at, Order.id)
            .with_for_update()
        )
    )


_MERGEABLE_ORDER_STATUSES = ("NEW", "SENT", "SERVED")
_IN_KITCHEN_ITEM_STATUSES = ("SENT", "ACCEPTED", "PREPARING", "READY", "PICKED_UP", "REFIRED")


@router.post("/{table_id}/merge", response_model=TableMergeOut)
def merge_tables(
    table_id: uuid.UUID,
    payload: TableMergeRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_TRANSFER)),
    session: Session = Depends(get_session),
) -> TableMergeOut:
    """Gộp các bàn trong `table_ids` vào bàn chính (bàn trong URL): một phiên, một đơn, một
    hóa đơn. Món của bàn phụ chuyển sang đơn của bàn chính (phiếu bếp đi theo món), phiên
    bàn phụ đóng, mã QR của bàn phụ hết dùng. Bàn phụ sang MERGED, trỏ về bàn chính; khi bàn
    chính thanh toán thì bàn phụ cùng sang CLEANING.

    Bàn phụ có thể đang có khách hoặc đang trống (kê thêm bàn). Bàn đang chờ thanh toán,
    đang dọn hoặc đã gộp thì không gộp được. Đơn bàn phụ đang áp ưu đãi thì phải gỡ trước,
    vì điều kiện ưu đãi tính trên hóa đơn mới sẽ khác."""
    endpoint = f"POST /api/v1/tables/{table_id}/merge"
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return TableMergeOut.model_validate_json(existing.response_body)

    secondary_ids = payload.table_ids
    if len(set(secondary_ids)) != len(secondary_ids) or table_id in secondary_ids:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Danh sách bàn bị trùng hoặc có chính bàn đang gộp vào",
        )
    # Khóa theo thứ tự id như chuyển bàn, để các thao tác chéo nhau không khóa chờ nhau.
    locked = {}
    for locked_id in sorted((table_id, *secondary_ids), key=str):
        locked[locked_id] = _lock_table(session, locked_id)
    primary = locked[table_id]
    if primary is None or primary.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn")
    if primary.status != "OCCUPIED":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Bàn chính đang ở trạng thái '{primary.status}', phải đang có khách",
        )
    primary_session = _open_session(session, primary.id)
    if primary_session is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Bàn chính không có phiên đang mở")

    secondaries = []
    for secondary_id in secondary_ids:
        table = locked[secondary_id]
        if table is None or table.outlet_id != current.outlet_id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, detail=f"Không tìm thấy bàn {secondary_id}"
            )
        if table.status not in ("OCCUPIED", *_OPENABLE_STATUSES):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"Bàn {table.code} đang ở trạng thái '{table.status}', không gộp được",
            )
        if _merged_tables(session, table.id):
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail=f"Bàn {table.code} đang có bàn khác gộp vào"
            )
        secondaries.append(table)

    orders = _open_orders(session, primary_session.id)
    target = orders[0] if orders else None
    moving: list[Order] = []
    closing_sessions: list[TableSession] = []
    for table in secondaries:
        table_session = _open_session(session, table.id) if table.status == "OCCUPIED" else None
        if table_session is None:
            continue
        for order in _open_orders(session, table_session.id):
            if active_order_reward(session, order.id) is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail=f"Đơn của bàn {table.code} đang áp ưu đãi, hãy gỡ trước khi gộp",
                )
            moving.append(order)
        closing_sessions.append(table_session)

    if target is None and moving:
        # Bàn chính chưa có đơn: lấy luôn đơn đầu tiên của bàn phụ làm đơn chung.
        target = moving.pop(0)
        target.table_session_id = primary_session.id
    for order in moving:
        for item in list(order.items):
            item.order_id = target.id
        order.status = "CLOSED"
        write_audit_log(
            session,
            outlet_id=current.outlet_id,
            staff_id=current.id,
            action="ORDER_MERGED",
            entity_type="order",
            entity_id=order.id,
            payload={"into_order_id": str(target.id)},
        )
        if target.customer_id is None and order.customer_id is not None:
            target.customer_id = order.customer_id

    now = datetime.now(timezone.utc)
    for table_session in closing_sessions:
        primary_session.guest_count += table_session.guest_count
        table_session.status = "CLOSED"
        table_session.closed_at = now
        table_session.qr_session_token = None
        table_session.qr_expires_at = None
    for table in secondaries:
        table.status = "MERGED"
        table.merged_into_table_id = primary.id
    session.flush()

    if target is not None and (moving or target.table_session_id == primary_session.id):
        session.expire(target, ["items"])
        live = [item for item in target.items if item.status != "VOIDED"]
        if target.status in ("NEW", "SERVED") and any(
            item.status in _IN_KITCHEN_ITEM_STATUSES for item in live
        ):
            target.status = "SENT"
        target.current_version += 1
        session.flush()
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
        action="TABLE_MERGED",
        entity_type="table_session",
        entity_id=primary_session.id,
        payload={
            "table_id": str(primary.id),
            "table_code": primary.code,
            "merged_table_codes": [table.code for table in secondaries],
            "order_id": str(target.id) if target else None,
        },
    )
    result = TableMergeOut(
        table_session_id=primary_session.id,
        table=TableOut.model_validate(primary),
        merged_tables=[TableOut.model_validate(table) for table in secondaries],
        order_id=target.id if target else None,
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
        "tables",
        "TABLE_MERGED",
        {
            "table_id": str(primary.id),
            "table_session_id": str(primary_session.id),
            "merged_table_ids": [str(table.id) for table in secondaries],
        },
    )
    for table in secondaries:
        manager.publish(
            current.outlet_id,
            "tables",
            "TABLE_STATUS_CHANGED",
            {"table_id": str(table.id), "status": table.status},
        )
    if target is not None:
        manager.publish(
            current.outlet_id,
            "tables",
            "ORDER_UPDATED",
            {
                "order_id": str(target.id),
                "table_id": str(primary.id),
                "table_session_id": str(primary_session.id),
                "status": target.status,
                "current_version": target.current_version,
                "reason": "TABLES_MERGED",
                "item_id": None,
            },
        )
        manager.publish(
            current.outlet_id,
            "kitchen",
            "KITCHEN_QUEUE_UPDATED",
            {"order_id": str(target.id), "items_sent": 0, "reason": "TABLES_MERGED"},
        )
    return result


@router.post("/{table_id}/mark-clean", response_model=TableOut)
def mark_table_clean(
    table_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.TABLE_MARK_CLEAN)),
    session: Session = Depends(get_session),
) -> TableOut:
    """CLEANING -> AVAILABLE. Chỉ bàn đang CLEANING mới xác nhận dọn xong được."""
    endpoint = f"POST /api/v1/tables/{table_id}/mark-clean"
    request_hash = hash_request_body({"table_id": str(table_id)})

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_200_OK:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return TableOut.model_validate_json(existing.response_body)

    table = _lock_table(session, table_id)
    if table is None or table.outlet_id != current.outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy bàn")
    if table.status != "CLEANING":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"Bàn đang ở trạng thái '{table.status}', phải ở CLEANING mới xác nhận dọn xong",
        )

    table.status = "AVAILABLE"
    session.flush()

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="TABLE_CLEANED",
        entity_type="restaurant_table",
        entity_id=table.id,
    )

    result = TableOut.model_validate(table)
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
        {"table_id": str(table.id), "status": "AVAILABLE"},
    )
    return result
