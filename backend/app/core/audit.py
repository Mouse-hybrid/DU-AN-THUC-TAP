"""Helper ghi audit_log — append-only, gọi ngay trong cùng transaction với
thao tác nghiệp vụ (chưa commit) để audit log và data chính luôn nhất quán:
nếu transaction rollback thì log cũng rollback theo, không có log "ma".
"""

from __future__ import annotations

import json
import uuid

from sqlalchemy.orm import Session

from app.db.models import AuditLog


def write_audit_log(
    session: Session,
    *,
    outlet_id: uuid.UUID | None,
    staff_id: uuid.UUID | None,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | str,
    payload: dict | None = None,
) -> None:
    session.add(
        AuditLog(
            outlet_id=outlet_id,
            staff_id=staff_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            payload=json.dumps(payload, default=str) if payload is not None else None,
        )
    )
