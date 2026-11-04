"""Pydantic schemas cho Rewards đợt 1: khách hàng, luật điểm, sổ điểm."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, model_validator


def normalize_phone(value: str) -> str:
    """Đưa về dạng 0xxxxxxxxx để một người không thành hai khách vì khác cách gõ."""
    digits = re.sub(r"[\s.\-()]", "", value)
    if digits.startswith("+84"):
        digits = "0" + digits[3:]
    elif digits.startswith("84") and len(digits) == 11:
        digits = "0" + digits[2:]
    if not re.fullmatch(r"0\d{9}", digits):
        raise ValueError("Số điện thoại phải có dạng 0xxxxxxxxx")
    return digits


Phone = Annotated[str, AfterValidator(normalize_phone)]


class CustomerOut(BaseModel):
    id: uuid.UUID
    phone: str
    full_name: str | None
    member_code: str
    points_balance: int
    is_active: bool
    consent_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


class CustomerCreate(BaseModel):
    phone: Phone
    full_name: str | None = Field(default=None, max_length=255)
    # Thu ngân xác nhận khách đồng ý lưu số điện thoại; không có thì không tạo.
    consent: Literal[True]


class CustomerUpdate(BaseModel):
    full_name: str | None = Field(default=None, max_length=255)
    is_active: bool | None = None


class LoyaltyRuleOut(BaseModel):
    id: uuid.UUID
    version: int
    earn_amount_per_point: Decimal
    redeem_value_per_point: Decimal
    max_redeem_percent: int
    points_expire_days: int | None
    created_at: datetime

    model_config = {"from_attributes": True}


class LoyaltyRuleCreate(BaseModel):
    earn_amount_per_point: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    redeem_value_per_point: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    max_redeem_percent: int = Field(ge=1, le=100)
    points_expire_days: int | None = Field(default=None, ge=1, le=3650)


class PointsEntryOut(BaseModel):
    id: uuid.UUID
    entry_type: str
    points: int
    balance_after: int
    order_id: uuid.UUID | None
    rule_version: int | None
    reason: str | None
    expires_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class PointsAdjustRequest(BaseModel):
    points: int = Field(ge=-1_000_000, le=1_000_000)
    reason: str = Field(min_length=1, max_length=500)


class RewardOut(BaseModel):
    id: uuid.UUID
    name: str
    reward_type: Literal["PERCENT", "FIXED", "POINTS"]
    value: Decimal | None
    min_order_amount: Decimal
    max_discount: Decimal | None
    valid_from: datetime | None
    valid_to: datetime | None
    max_uses: int | None
    used_count: int
    is_active: bool

    model_config = {"from_attributes": True}


class RewardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    reward_type: Literal["PERCENT", "FIXED", "POINTS"]
    value: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    min_order_amount: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    max_discount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    max_uses: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _check_value(self) -> RewardCreate:
        if self.reward_type == "POINTS" and self.value is not None:
            raise ValueError("Ưu đãi đổi điểm lấy giá trị từ luật điểm, không truyền value")
        if self.reward_type != "POINTS" and self.value is None:
            raise ValueError("Cần value")
        if self.reward_type == "PERCENT" and self.value > 100:
            raise ValueError("Phần trăm không được quá 100")
        if self.valid_from and self.valid_to and self.valid_from >= self.valid_to:
            raise ValueError("valid_from phải trước valid_to")
        return self


class RewardUpdate(BaseModel):
    """Không đổi được reward_type. Đơn chưa thanh toán tính theo giá trị mới; đơn đã thanh
    toán giữ nguyên số đã chốt."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    value: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    min_order_amount: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    max_discount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    max_uses: int | None = Field(default=None, ge=1)
    is_active: bool | None = None


class EligibleRewardOut(BaseModel):
    reward_id: uuid.UUID
    name: str
    reward_type: str
    eligible: bool
    reason_code: str | None = None
    reason: str | None = None
    discount_amount: Decimal = Decimal("0")
    points: int = 0  # ưu đãi đổi điểm: số điểm dùng nếu áp mức cao nhất
    max_points: int = 0


class ApplyRewardRequest(BaseModel):
    """Không có trường số tiền: server tự tính (RW-020). `points` chỉ dùng cho ưu đãi đổi điểm.
    `override_reason`: chỉ Supervisor, bỏ qua thời hạn, đơn tối thiểu, số lượt."""

    reward_id: uuid.UUID
    points: int | None = Field(default=None, ge=1)
    override_reason: str | None = Field(default=None, min_length=1, max_length=500)

    model_config = {"extra": "forbid"}


class RewardUsageOut(BaseModel):
    id: uuid.UUID
    order_id: uuid.UUID
    reward_id: uuid.UUID
    reward_name: str
    reward_type: str
    discount_amount: Decimal
    points_used: int
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}
