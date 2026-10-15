"""Pydantic schemas cho tra cứu audit_log và lịch sử order_version (chỉ đọc)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel


class AuditLogOut(BaseModel):
    id: uuid.UUID
    action: str
    entity_type: str
    entity_id: str
    staff_id: uuid.UUID | None
    staff_username: str | None
    staff_role: str | None
    payload: Any | None
    created_at: datetime


class OrderVersionOut(BaseModel):
    version_number: int
    created_at: datetime
    created_by_staff_id: uuid.UUID | None
    created_by_username: str | None
    created_by_role: str | None
    snapshot: Any
