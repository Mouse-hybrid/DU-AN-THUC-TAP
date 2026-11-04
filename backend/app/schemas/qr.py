"""Pydantic schemas cho QR Ordering: nhân viên cấp mã, khách gọi món không đăng nhập.
Schema phía khách chỉ có dữ liệu cần hiển thị: không có nhân viên, trạm bếp, outlet."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class QrSessionOut(BaseModel):
    table_id: uuid.UUID
    table_session_id: uuid.UUID
    token: str
    expires_at: datetime
    path: str  # đường dẫn giao diện khách, FE ghép với domain rồi vẽ mã QR


class QrInfoOut(BaseModel):
    table_code: str
    area_name: str | None = None
    expires_at: datetime
    # true khi bàn đang chờ thanh toán: khách vẫn xem được nhưng không gọi thêm.
    ordering_locked: bool


class QrCategoryOut(BaseModel):
    id: uuid.UUID
    name: str
    sort_order: int

    model_config = {"from_attributes": True}


class QrMenuItemOut(BaseModel):
    id: uuid.UUID
    name: str
    price: Decimal
    category_id: uuid.UUID | None = None
    is_available: bool

    model_config = {"from_attributes": True}


class QrMenuOut(BaseModel):
    categories: list[QrCategoryOut]
    items: list[QrMenuItemOut]


class QrOrderLine(BaseModel):
    menu_item_id: uuid.UUID
    quantity: int = Field(default=1, ge=1, le=20)
    note: str | None = Field(default=None, max_length=200)


class QrSubmitRequest(BaseModel):
    items: list[QrOrderLine] = Field(min_length=1, max_length=20)


class QrOrderItemOut(BaseModel):
    id: uuid.UUID
    menu_item_name: str
    quantity: int
    unit_price: Decimal
    line_total: Decimal
    note: str | None
    status: str  # CREATED = chờ phục vụ xác nhận, VOIDED = đã hủy
    source: str


class QrOrderOut(BaseModel):
    """Toàn bộ món của phiên bàn: khách cùng bàn dùng chung một hóa đơn."""

    table_code: str
    items: list[QrOrderItemOut]
    subtotal: Decimal
