"""Pydantic schemas cho Menu: GET /menu (BE-S1-08) + quản lý món (tạo/sửa) + nhóm món."""

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
    category_id: uuid.UUID | None

    model_config = {"from_attributes": True}


class MenuItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    price: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    station_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    is_available: bool = True


class MenuItemUpdate(BaseModel):
    """PATCH: chỉ field nào gửi lên mới được đổi. `station_id: null` /
    `category_id: null` = bỏ gán; không gửi field = giữ nguyên."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    price: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    station_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    is_available: bool | None = None


class MenuCategoryOut(BaseModel):
    id: uuid.UUID
    name: str
    sort_order: int
    is_active: bool

    model_config = {"from_attributes": True}


class MenuCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    sort_order: int = Field(default=0, ge=0, le=10_000)
    is_active: bool = True


class MenuCategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    sort_order: int | None = Field(default=None, ge=0, le=10_000)
    is_active: bool | None = None
