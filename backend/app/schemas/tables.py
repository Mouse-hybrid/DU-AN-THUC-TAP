"""Pydantic schemas cho vertical slice bước 1: Mở bàn."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class OpenSessionRequest(BaseModel):
    guest_count: int = Field(default=1, ge=1, le=100)


class TableSessionOut(BaseModel):
    id: uuid.UUID
    table_id: uuid.UUID
    status: str
    guest_count: int
    opened_at: datetime

    model_config = {"from_attributes": True}
