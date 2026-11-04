"""Pydantic schemas cho tầng/khu của nhà hàng (/api/v1/areas)."""

from __future__ import annotations

import uuid

from pydantic import BaseModel, Field


class AreaOut(BaseModel):
    """1 tầng/khu kèm số bàn theo trạng thái, cho màn 03 Tổng quan khu vực."""

    id: uuid.UUID
    name: str
    sort_order: int
    is_active: bool
    table_count: int = 0
    status_counts: dict[str, int] = {}


class AreaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    sort_order: int = Field(default=0, ge=0, le=10000)


class AreaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    sort_order: int | None = Field(default=None, ge=0, le=10000)
    is_active: bool | None = None
