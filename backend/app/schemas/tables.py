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
    area_id: uuid.UUID | None = None
    area_name: str | None = None
    merged_into_table_id: uuid.UUID | None = None  # bàn đang gộp vào bàn nào (status MERGED)

    model_config = {"from_attributes": True}


class TableAreaAssign(BaseModel):
    """`area_id` bắt buộc gửi; null = bỏ bàn ra khỏi khu."""

    area_id: uuid.UUID | None


class TableTransferRequest(BaseModel):
    target_table_id: uuid.UUID


class TableTransferOut(BaseModel):
    table_session_id: uuid.UUID
    from_table: TableOut
    to_table: TableOut


class TableMergeRequest(BaseModel):
    """Các bàn gộp vào bàn trong URL (bàn chính)."""

    table_ids: list[uuid.UUID] = Field(min_length=1, max_length=10)


class TableMergeOut(BaseModel):
    table_session_id: uuid.UUID
    table: TableOut
    merged_tables: list[TableOut]
    order_id: uuid.UUID | None  # đơn chung sau khi gộp, null nếu chưa bàn nào có đơn


class TableDashboardItem(BaseModel):
    """1 dòng của dashboard bàn: trạng thái bàn + phiên đang mở (nếu có)."""

    id: uuid.UUID
    code: str
    seats: int
    status: str
    area_id: uuid.UUID | None = None
    area_name: str | None = None
    merged_into_table_id: uuid.UUID | None = None
    current_session_id: uuid.UUID | None = None
    guest_count: int | None = None
    opened_at: datetime | None = None


class TableDetailOut(TableOut):
    """Chi tiết 1 bàn (Figma screen-05): phiên đang mở + mọi order của phiên đó."""

    current_session: TableSessionOut | None = None
    orders: list[OrderDetailOut] = []
