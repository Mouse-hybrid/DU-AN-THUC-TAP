"""Vertical slice bước 1: Mở bàn.

POST /api/v1/tables/{table_id}/open-session
  - Chỉ mở được khi bàn đang AVAILABLE hoặc RESERVED (BRD state machine).
  - Tạo table_session mới (status OPEN) + chuyển bàn sang OCCUPIED.
  - Bắt buộc header Idempotency-Key (NFR) — bấm "Mở bàn" 2 lần do mạng chậm
    không được tạo 2 table_session.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_role,
)
from app.db.base import get_session
from app.db.models import IdempotencyKey, RestaurantTable, TableSession
from app.schemas.tables import OpenSessionRequest, TableSessionOut

router = APIRouter(prefix="/tables", tags=["tables"])

_OPENABLE_STATUSES = ("AVAILABLE", "RESERVED")
# "Mở bàn" không phải action liệt kê trực tiếp trong Permission Matrix của BRD,
# nhưng gần nhất với "Merge/Split/Transfer Table" (Waiter + Supervisor) và khớp
# với "table lifecycle" trong Key Responsibilities của Waiter.
_OPEN_SESSION_ROLES = ("WAITER", "SUPERVISOR")


@router.post("/{table_id}/open-session", response_model=TableSessionOut, status_code=status.HTTP_201_CREATED)
def open_table_session(
    table_id: uuid.UUID,
    payload: OpenSessionRequest,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_role(*_OPEN_SESSION_ROLES)),
    session: Session = Depends(get_session),
) -> TableSessionOut:
    endpoint = f"POST /api/v1/tables/{table_id}/open-session"
    request_hash = hash_request_body(payload.model_dump(mode="json"))

    existing = get_idempotent_response(session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash)
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
    return result
