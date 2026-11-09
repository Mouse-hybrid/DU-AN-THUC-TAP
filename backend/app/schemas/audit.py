"""Pydantic schemas cho tra cứu, báo cáo audit_log và lịch sử order_version (chỉ đọc)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
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


class ActionCount(BaseModel):
    action: str
    count: int
    is_exception: bool  # thao tác ngoại lệ cần giám sát để ý (hủy món, bỏ qua điều kiện...)


class StaffCount(BaseModel):
    staff_id: uuid.UUID | None  # null = thao tác của khách QR hoặc của hệ thống
    username: str | None
    role: str | None
    count: int
    exception_count: int


class DayCount(BaseModel):
    date: date  # ngày theo giờ Việt Nam (UTC+7)
    count: int


class AuditSummaryOut(BaseModel):
    created_from: datetime
    created_to: datetime
    total: int
    exception_total: int
    by_action: list[ActionCount]
    by_staff: list[StaffCount]
    by_day: list[DayCount]
