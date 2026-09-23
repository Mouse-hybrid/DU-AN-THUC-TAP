"""POST /api/v1/auth/login — staff đăng nhập bằng username/password, nhận JWT.

Khách quét QR KHÔNG dùng endpoint này (theo BRD: không cần login) — session
token cho QR được cấp riêng khi mở table_session, xem app/api/v1/tables.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import JWT_ACCESS_TOKEN_EXPIRE_MINUTES
from app.core.security import create_access_token, verify_password
from app.db.base import get_session
from app.db.models import Staff
from app.schemas.auth import LoginRequest, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, session: Session = Depends(get_session)) -> TokenResponse:
    staff = session.execute(select(Staff).where(Staff.username == payload.username)).scalar_one_or_none()

    # Cố tình không phân biệt "sai username" vs "sai password" trong message,
    # tránh lộ thông tin username nào tồn tại (user enumeration).
    invalid_credentials = HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Sai tên đăng nhập hoặc mật khẩu")

    if staff is None or not staff.is_active:
        raise invalid_credentials
    if not verify_password(payload.password, staff.password_hash):
        raise invalid_credentials

    token = create_access_token(staff_id=staff.id, outlet_id=staff.outlet_id, role=staff.role)
    return TokenResponse(
        access_token=token,
        expires_in_minutes=JWT_ACCESS_TOKEN_EXPIRE_MINUTES,
        staff=staff,
    )
