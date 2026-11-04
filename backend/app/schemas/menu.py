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
    has_modifiers: bool = False  # true thì POS gọi GET /menu/{id}/modifiers để hiện tùy chọn

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


class ModifierOptionOut(BaseModel):
    id: uuid.UUID
    name: str
    price_delta: Decimal
    is_available: bool
    sort_order: int

    model_config = {"from_attributes": True}


class ModifierGroupOut(BaseModel):
    id: uuid.UUID
    name: str
    min_select: int
    max_select: int
    sort_order: int
    is_active: bool
    options: list[ModifierOptionOut] = []

    model_config = {"from_attributes": True}


class ModifierOptionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    price_delta: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    sort_order: int = Field(default=0, ge=0, le=10_000)
    is_available: bool = True


class ModifierOptionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    price_delta: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    sort_order: int | None = Field(default=None, ge=0, le=10_000)
    is_available: bool | None = None


class ModifierGroupCreate(BaseModel):
    """Nhóm bắt buộc chọn 1 (Size): min_select=1, max_select=1.
    Nhóm tùy ý (Topping): min_select=0, max_select=số tối đa."""

    name: str = Field(min_length=1, max_length=100)
    min_select: int = Field(default=0, ge=0, le=20)
    max_select: int = Field(default=1, ge=1, le=20)
    sort_order: int = Field(default=0, ge=0, le=10_000)
    options: list[ModifierOptionCreate] = Field(min_length=1, max_length=30)


class ModifierGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    min_select: int | None = Field(default=None, ge=0, le=20)
    max_select: int | None = Field(default=None, ge=1, le=20)
    sort_order: int | None = Field(default=None, ge=0, le=10_000)
    is_active: bool | None = None
