"""Che dữ liệu cá nhân theo vai trò (ADR 0004, P2-RFI-RWD).

Số điện thoại khách chỉ hiện đủ cho vai trò có quyền `LOYALTY_MANAGE` (mặc định Supervisor).
Vai trò khác, như Cashier, chỉ thấy dạng `090****567`: đủ để đối chiếu với khách trước mặt,
không đủ để chép ra danh sách số điện thoại.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.core.permissions import Permission
from app.core.rbac import role_has


def mask_phone(phone: str) -> str:
    return f"{phone[:3]}****{phone[-3:]}"


def can_see_full_phone(session: Session, outlet_id: uuid.UUID, role: str) -> bool:
    return role_has(session, outlet_id, role, Permission.LOYALTY_MANAGE)
