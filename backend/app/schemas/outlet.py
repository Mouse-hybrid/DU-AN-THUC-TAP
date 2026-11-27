"""Cài đặt vận hành của cửa hàng."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

QrSendMode = Literal["DIRECT", "CONFIRM"]


class OutletSettingsOut(BaseModel):
    """`qr_send_mode`: DIRECT = món khách gọi qua QR vào bếp ngay; CONFIRM = chờ phục vụ xác
    nhận rồi mới gửi bếp. `vat_rate`, `service_charge_rate`: % (0 = tắt). `prices_include_vat`:
    giá thực đơn đã gồm VAT. Đổi thuế/phí chỉ áp cho đơn chưa yêu cầu thanh toán."""

    qr_send_mode: QrSendMode
    vat_rate: Decimal = Decimal("0")
    prices_include_vat: bool = False
    service_charge_rate: Decimal = Decimal("0")


class OutletSettingsUpdate(BaseModel):
    """Gửi trường nào đổi trường đó. Trần 20% và 30% chỉ để chặn gõ nhầm, không phải con số
    nghiệp vụ (specs/003-vat-hoa-don data-model)."""

    qr_send_mode: QrSendMode | None = None
    vat_rate: Decimal | None = Field(default=None, ge=0, le=20, decimal_places=2)
    prices_include_vat: bool | None = None
    service_charge_rate: Decimal | None = Field(default=None, ge=0, le=30, decimal_places=2)
