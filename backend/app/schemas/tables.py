"""Pydantic schemas cho bàn: mở bàn (vertical slice bước 1), dashboard bàn, dọn bàn."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.orders import OrderDetailOut


class OpenSessionRequest(BaseModel):
    guest_count: int = Field(default=1, ge=1, le=100)


class TableSessionOut(BaseModel):
    id: uuid.UUID
    table_id: uuid.UUID
    status: str
    guest_count: int
    opened_at: datetime

    model_config = {"from_attributes": True}


class TableOut(BaseModel):
    id: uuid.UUID
    code: str
    seats: int
    status: str

    model_config = {"from_attributes": True}


class TableDashboardItem(BaseModel):
    """1 dòng của dashboard bàn: trạng thái bàn + phiên đang mở (nếu có)."""

    id: uuid.UUID
    code: str
    seats: int
    status: str
    current_session_id: uuid.UUID | None = None
    guest_count: int | None = None
    opened_at: datetime | None = None


class TableDetailOut(TableOut):
    """Chi tiết 1 bàn (Figma screen-05): phiên đang mở + mọi order của phiên đó."""

    current_session: TableSessionOut | None = None
    orders: list[OrderDetailOut] = []
