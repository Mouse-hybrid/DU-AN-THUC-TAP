"""Pydantic schemas cho vertical slice bước 2+3: Tạo order → Gửi bếp."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator


class CreateOrderRequest(BaseModel):
    table_session_id: uuid.UUID


class OrderItemCreate(BaseModel):
    menu_item_id: uuid.UUID
    quantity: int = Field(default=1, ge=1, le=50)
    note: str | None = None


class AddItemsRequest(BaseModel):
    items: list[OrderItemCreate] = Field(min_length=1)


class UpdateOrderItemRequest(BaseModel):
    """Sửa món chưa gửi bếp. Chỉ gửi field cần đổi; gửi `note: null` để xóa ghi chú."""

    quantity: int | None = Field(default=None, ge=1, le=50)
    note: str | None = None

    @model_validator(mode="after")
    def _at_least_one_field(self) -> UpdateOrderItemRequest:
        if not self.model_fields_set:
            raise ValueError("Cần ít nhất 1 trong 2 field: quantity, note")
        if "quantity" in self.model_fields_set and self.quantity is None:
            raise ValueError("quantity không được null")
        return self


class OrderItemOut(BaseModel):
    id: uuid.UUID
    menu_item_id: uuid.UUID
    status: str
    quantity: int
    unit_price: Decimal
    note: str | None

    model_config = {"from_attributes": True}


class OrderOut(BaseModel):
    id: uuid.UUID
    table_session_id: uuid.UUID
    status: str
    current_version: int
    created_at: datetime
    items: list[OrderItemOut] = []

    model_config = {"from_attributes": True}


class SendToKitchenResponse(BaseModel):
    order: OrderOut
    kitchen_queue_entries_created: int


class VoidItemRequest(BaseModel):
    reason: str | None = None
