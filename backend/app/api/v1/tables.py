"""Quản lý bàn: mở bàn (vertical slice bước 1), dashboard bàn, xác nhận dọn bàn.

GET  /api/v1/tables                              — dashboard: mọi bàn của outlet + phiên đang mở.
GET  /api/v1/tables/{table_id}                   — chi tiết bàn: phiên đang mở + các order kèm món.
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

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.orders import build_order_detail
from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_current_staff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_role,
)
from app.core.realtime import manager
from app.db.base import get_session
from app.db.models import IdempotencyKey, Order, RestaurantTable, TableSession
from app.schemas.tables import (
    OpenSessionRequest,
    TableDashboardItem,
    TableDetailOut,
    TableOut,
    TableSessionOut,
)

router = APIRouter(prefix="/tables", tags=["tables"])

_OPENABLE_STATUSES = ("AVAILABLE", "RESERVED")
# "Mở bàn" không có trong Permission Matrix của BRD. HLR UC-TABLE-002 ghi actor
# "Waiter / Cashier"; PO chốt 09/10/2026: Cashier, Waiter, Supervisor.
_OPEN_SESSION_ROLES = ("CASHIER", "WAITER", "SUPERVISOR")
# "Xác nhận dọn bàn" cũng không có trong 11 action của Permission Matrix; BRD chỉ
# nói bàn "remains CLEANING until confirmed". Gán Waiter + Supervisor (nhóm
# quản lý bàn) — cần BA/PM xác nhận lại.
_MARK_CLEAN_ROLES = ("WAITER", "SUPERVISOR")


@router.post(
    "/{table_id}/open-session", response_model=TableSessionOut, status_code=status.HTTP_201_CREATED
)
def open_table_session(
    table_id: uuid.UUID,
    payload: OpenSessionRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_OPEN_SESSION_ROLES)),
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

    table = session.get(RestaurantTable, table_id)
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


@router.get("", response_model=list[TableDashboardItem])
def table_dashboard(
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[TableDashboardItem]:
    """Dashboard bàn: mọi bàn của outlet, kèm phiên OPEN hiện tại (nếu có).
    Mọi role đã đăng nhập đều xem được (xem trạng thái bàn không bị hạn chế
    trong Permission Matrix)."""
    tables = (
        session.execute(
            select(RestaurantTable)
            .where(RestaurantTable.outlet_id == current.outlet_id)
            .order_by(RestaurantTable.code)
        )
        .scalars()
        .all()
    )
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
        current_session=TableSessionOut.model_validate(open_session) if open_session else None,
        orders=[build_order_detail(session, order) for order in orders],
    )


@router.post("/{table_id}/mark-clean", response_model=TableOut)
def mark_table_clean(
    table_id: uuid.UUID,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_MARK_CLEAN_ROLES)),
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

    table = session.get(RestaurantTable, table_id)
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
