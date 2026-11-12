"""Pydantic schemas cho QR Ordering: nhân viên cấp mã, khách gọi món không đăng nhập.
Schema phía khách chỉ có dữ liệu cần hiển thị: không có nhân viên, trạm bếp, outlet."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.menu import ModifierGroupOut
from app.schemas.orders import OrderItemModifierOut
from app.schemas.rewards import Phone


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
    modifier_groups: list[ModifierGroupOut] = []  # chỉ nhóm đang hiển thị


class QrMenuOut(BaseModel):
    categories: list[QrCategoryOut]
    items: list[QrMenuItemOut]


class QrOrderLine(BaseModel):
    menu_item_id: uuid.UUID
    quantity: int = Field(default=1, ge=1, le=20)
    note: str | None = Field(default=None, max_length=200)
    modifier_option_ids: list[uuid.UUID] = Field(default_factory=list, max_length=30)


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
    modifiers: list[OrderItemModifierOut] = []


class QrOrderOut(BaseModel):
    """Toàn bộ món của phiên bàn: khách cùng bàn dùng chung một hóa đơn."""

    table_code: str
    items: list[QrOrderItemOut]
    subtotal: Decimal
    discount_total: Decimal = Decimal("0")  # ưu đãi do thu ngân áp
    total: Decimal


class QrMemberRequest(BaseModel):
    """Khách nhập số điện thoại để tích điểm (chỉ tích, không đổi điểm trên QR)."""

    model_config = ConfigDict(extra="forbid")

    phone: Phone


class QrMemberOut(BaseModel):
    """Giống nhau cho số đã là thành viên và số chưa là thành viên, để không dò được ai là
    thành viên. Chỉ trả số đã che."""

    status: str = "RECEIVED"
    phone_masked: str
