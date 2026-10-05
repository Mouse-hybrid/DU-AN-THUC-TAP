"""Pydantic schemas cho Menu: GET /menu (BE-S1-08) + quản lý món (tạo/sửa)."""

from __future__ import annotations

import uuid
from decimal import Decimal

from pydantic import BaseModel, Field


class MenuItemOut(BaseModel):
    id: uuid.UUID
    name: str
    price: Decimal
    is_available: bool
    station_id: uuid.UUID | None

    model_config = {"from_attributes": True}


class MenuItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    price: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    station_id: uuid.UUID | None = None
    is_available: bool = True


class MenuItemUpdate(BaseModel):
    """PATCH: chỉ field nào gửi lên mới được đổi. `station_id: null` = bỏ gán
    trạm; không gửi `station_id` = giữ nguyên."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    price: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    station_id: uuid.UUID | None = None
    is_available: bool | None = None
