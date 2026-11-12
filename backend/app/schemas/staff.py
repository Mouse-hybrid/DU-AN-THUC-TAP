"""Pydantic schemas cho quản lý nhân viên (/api/v1/staff)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.auth import NewPassword

StaffRole = Literal["CASHIER", "WAITER", "KITCHEN", "SUPERVISOR"]


class StaffDetailOut(BaseModel):
    id: uuid.UUID
    outlet_id: uuid.UUID
    username: str
    full_name: str
    role: StaffRole
    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class StaffCreate(BaseModel):
    username: str = Field(min_length=3, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")
    password: NewPassword
    full_name: str = Field(min_length=1, max_length=255)
    role: StaffRole


class StaffUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    role: StaffRole | None = None


class StaffResetPassword(BaseModel):
    new_password: NewPassword


class PermissionRuleOut(BaseModel):
    """`roles` = vai trò đang có quyền (đã tính các ô Supervisor sửa). `default_roles` = theo
    mặc định của hệ thống. `locked_roles` = ô không bỏ được. `customized` = khác mặc định."""

    permission: str
    description: str
    roles: list[StaffRole]
    default_roles: list[StaffRole] = []
    locked_roles: list[StaffRole] = []
    customized: bool = False


class UpdatePermissionRolesRequest(BaseModel):
    """Danh sách đầy đủ vai trò được có quyền này sau khi sửa (không phải phần thêm/bớt)."""

    model_config = ConfigDict(extra="forbid")

    roles: list[StaffRole] = Field(max_length=4)
