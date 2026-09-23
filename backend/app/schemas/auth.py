"""Pydantic schemas cho auth (POST /api/v1/auth/login)."""

from __future__ import annotations

import uuid

from pydantic import BaseModel


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
