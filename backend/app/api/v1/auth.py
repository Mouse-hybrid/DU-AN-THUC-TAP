"""Đăng nhập và tài khoản của chính mình.

POST /api/v1/auth/login            — username/password, nhận JWT.
GET  /api/v1/auth/me               — thông tin + danh sách quyền của người đang đăng nhập.
POST /api/v1/auth/change-password  — tự đổi mật khẩu; các phiên cũ hết hiệu lực, trả token mới.

Khách quét QR KHÔNG dùng các endpoint này (theo BRD: không cần login) — session
token cho QR được cấp riêng khi mở table_session, xem app/api/v1/tables.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.config import JWT_ACCESS_TOKEN_EXPIRE_MINUTES
from app.core.deps import CurrentStaff, get_current_staff
from app.core.rbac import permissions_for
from app.core.security import create_access_token, hash_password, verify_password
from app.db.base import get_session
from app.db.models import Staff
from app.schemas.auth import ChangePasswordRequest, LoginRequest, MeOut, StaffOut, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])


def _token_response(staff: Staff) -> TokenResponse:
    token = create_access_token(
        staff_id=staff.id,
        outlet_id=staff.outlet_id,
        role=staff.role,
        token_version=staff.token_version,
    )
    return TokenResponse(
        access_token=token,
        expires_in_minutes=JWT_ACCESS_TOKEN_EXPIRE_MINUTES,
        staff=staff,
    )


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, session: Session = Depends(get_session)) -> TokenResponse:
    staff = session.execute(
        select(Staff).where(Staff.username == payload.username)
    ).scalar_one_or_none()

    # Cố tình không phân biệt "sai username" vs "sai password" trong message,
    # tránh lộ thông tin username nào tồn tại (user enumeration).
    invalid_credentials = HTTPException(
        status.HTTP_401_UNAUTHORIZED, detail="Sai tên đăng nhập hoặc mật khẩu"
    )

    if staff is None or not staff.is_active:
        raise invalid_credentials
    if not verify_password(payload.password, staff.password_hash):
        raise invalid_credentials

    return _token_response(staff)


@router.get("/me", response_model=MeOut)
def get_me(
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> MeOut:
    staff = session.get(Staff, current.id)
    return MeOut(
        **StaffOut.model_validate(staff).model_dump(),
        permissions=permissions_for(session, staff.outlet_id, staff.role),
    )


@router.post("/change-password", response_model=TokenResponse)
def change_password(
    payload: ChangePasswordRequest,
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> TokenResponse:
    staff = session.get(Staff, current.id)
    if not verify_password(payload.current_password, staff.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Mật khẩu hiện tại không đúng")
    if payload.new_password == payload.current_password:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="Mật khẩu mới phải khác mật khẩu hiện tại"
        )

    staff.password_hash = hash_password(payload.new_password)
    staff.token_version += 1
    write_audit_log(
        session,
        outlet_id=staff.outlet_id,
        staff_id=staff.id,
        action="STAFF_PASSWORD_CHANGED",
        entity_type="staff",
        entity_id=staff.id,
    )
    session.commit()
    return _token_response(staff)
