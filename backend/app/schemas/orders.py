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
    modifier_option_ids: list[uuid.UUID] = Field(default_factory=list, max_length=30)


class AttachCustomerRequest(BaseModel):
    """`customer_id` bắt buộc gửi; null = bỏ khách khỏi đơn."""

    customer_id: uuid.UUID | None


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


class OrderItemModifierOut(BaseModel):
    group_name: str
    option_name: str
    price_delta: Decimal

    model_config = {"from_attributes": True}


class OrderItemOut(BaseModel):
    id: uuid.UUID
    menu_item_id: uuid.UUID
    status: str
    quantity: int
    unit_price: Decimal  # đã gồm giá cộng thêm của các tùy chọn
    note: str | None
    source: str = "POS"
    modifiers: list[OrderItemModifierOut] = []

    model_config = {"from_attributes": True}


class OrderOut(BaseModel):
    id: uuid.UUID
    table_session_id: uuid.UUID
    status: str
    current_version: int
    created_at: datetime
    customer_id: uuid.UUID | None = None
    items: list[OrderItemOut] = []

    model_config = {"from_attributes": True}


class OrderItemDetailOut(OrderItemOut):
    """Dòng món kèm tên món và thành tiền — đủ để FE vẽ màn order mà không phải
    gọi thêm GET /menu."""

    menu_item_name: str
    line_total: Decimal


class AppliedRewardOut(BaseModel):
    """Ưu đãi đang áp vào đơn. `invalid_reason` có giá trị khi hóa đơn đổi làm ưu đãi không
    còn dùng được: tiền giảm về 0 và phải gỡ ưu đãi mới thanh toán được."""

    id: uuid.UUID
    reward_id: uuid.UUID
    reward_name: str
    reward_type: str
    status: str
    discount_amount: Decimal
    points_used: int
    invalid_reason: str | None = None


class OrderDetailOut(BaseModel):
    """Chi tiết 1 order cho màn POS ordering / order summary / table detail.
    `subtotal` = tổng các món chưa bị VOIDED (chưa có thuế). `total` = số tiền phải trả."""

    id: uuid.UUID
    table_session_id: uuid.UUID
    table_id: uuid.UUID
    table_code: str
    status: str
    current_version: int
    created_at: datetime
    customer_id: uuid.UUID | None = None
    items: list[OrderItemDetailOut] = []
    subtotal: Decimal
    discount_total: Decimal = Decimal("0")
    total: Decimal
    applied_reward: AppliedRewardOut | None = None
    # Đã thu qua các lần thanh toán (không tính lần đã hủy) và số còn phải thu.
    amount_paid: Decimal = Decimal("0")
    amount_due: Decimal = Decimal("0")
    # Khách đã nhập số điện thoại trên QR, chờ thu ngân xử lý (số ở GET .../pending-member).
    has_pending_member: bool = False


class PendingMemberOut(BaseModel):
    """`phone`: số khách nhập trên QR (null nếu không có). `member_customer_id`: thành viên
    đang hoạt động có số đó, nếu có (chưa gắn được vì đơn đã có khách khác hoặc bàn chưa có đơn).
    """

    phone: str | None = None
    member_customer_id: uuid.UUID | None = None


class OrderSummaryOut(BaseModel):
    """1 dòng trong danh sách order (GET /orders) — đủ để chọn order rồi gọi
    GET /orders/{id} lấy chi tiết. `item_count`/`subtotal` không tính món VOIDED."""

    id: uuid.UUID
    table_session_id: uuid.UUID
    table_id: uuid.UUID
    table_code: str
    status: str
    current_version: int
    created_at: datetime
    item_count: int
    subtotal: Decimal


class SendToKitchenResponse(BaseModel):
    order: OrderOut
    kitchen_queue_entries_created: int


class SplitLine(BaseModel):
    order_item_id: uuid.UUID
    quantity: int = Field(ge=1, le=50)


class SplitOrderRequest(BaseModel):
    items: list[SplitLine] = Field(min_length=1, max_length=50)


class SplitOrderOut(BaseModel):
    order: OrderDetailOut  # đơn cũ sau khi tách
    new_order: OrderDetailOut


class VoidItemRequest(BaseModel):
    reason: str | None = None
