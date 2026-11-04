"""Pydantic schemas cho Rewards đợt 1: khách hàng, luật điểm, sổ điểm."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field


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
