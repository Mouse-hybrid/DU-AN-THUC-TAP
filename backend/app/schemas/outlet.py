"""Cài đặt vận hành của cửa hàng."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

QrSendMode = Literal["DIRECT", "CONFIRM"]


class OutletSettingsOut(BaseModel):
    """`qr_send_mode`: DIRECT = món khách gọi qua QR vào bếp ngay; CONFIRM = chờ phục vụ xác
    nhận rồi mới gửi bếp."""

    qr_send_mode: QrSendMode


class OutletSettingsUpdate(BaseModel):
    qr_send_mode: QrSendMode
