"""Pydantic schemas cho auth (POST /api/v1/auth/login, /me, /change-password)."""

from __future__ import annotations

import uuid
from typing import Annotated

from pydantic import AfterValidator, BaseModel

PASSWORD_MIN_CHARS = 8
# bcrypt chỉ dùng 72 byte đầu; dài hơn thì từ chối thay vì âm thầm cắt bớt.
PASSWORD_MAX_BYTES = 72


def _validate_new_password(value: str) -> str:
    if len(value) < PASSWORD_MIN_CHARS:
        raise ValueError(f"Mật khẩu phải có ít nhất {PASSWORD_MIN_CHARS} ký tự")
    if len(value.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise ValueError(f"Mật khẩu không được dài quá {PASSWORD_MAX_BYTES} byte")
    return value


NewPassword = Annotated[str, AfterValidator(_validate_new_password)]


class LoginRequest(BaseModel):
    username: str
    password: str


class StaffOut(BaseModel):
    id: uuid.UUID
    outlet_id: uuid.UUID
    username: str
    full_name: str
    role: str

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_minutes: int
    staff: StaffOut


class MeOut(StaffOut):
    """Nhân viên đang đăng nhập kèm danh sách quyền, để FE ẩn/hiện nút theo quyền."""

    permissions: list[str]


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: NewPassword
