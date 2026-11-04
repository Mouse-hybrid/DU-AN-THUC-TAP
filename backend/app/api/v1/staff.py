"""Quản lý tài khoản nhân viên (Rollout board Pha 2 "Role Management", Figma màn
93 Tài khoản nhân viên, 94 Vai trò & quyền) — chỉ người có quyền STAFF_MANAGE,
chỉ trong outlet của mình.

Không có API xóa: nhân viên nghỉ thì khóa, để audit_log và đơn cũ vẫn tra được.

Không được đổi role, khóa hay đặt lại mật khẩu của chính mình: tránh việc Supervisor
cuối cùng tự khóa làm nhà hàng mất quyền quản trị (mỗi lần khóa/hạ quyền đều do 1
Supervisor khác đang hoạt động thực hiện, nên luôn còn ít nhất 1 Supervisor).
Tự đổi mật khẩu đi qua POST /auth/change-password, phải nhập mật khẩu hiện tại.

Đổi role, khóa, đặt lại mật khẩu đều tăng token_version: người đó phải đăng nhập lại.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.deps import (
    CurrentStaff,
    get_idempotent_response,
    hash_request_body,
    require_idempotency_key,
    require_permission,
)
from app.core.permissions import PERMISSION_MATRIX, Permission
from app.core.security import hash_password
from app.db.base import get_session
from app.db.models import IdempotencyKey, Staff
from app.schemas.staff import (
    PermissionRuleOut,
    StaffCreate,
    StaffDetailOut,
    StaffResetPassword,
    StaffRole,
    StaffUpdate,
)

router = APIRouter(prefix="/staff", tags=["staff"])


def _load_staff_or_404(session: Session, staff_id: uuid.UUID, outlet_id: uuid.UUID) -> Staff:
    staff = session.get(Staff, staff_id)
    if staff is None or staff.outlet_id != outlet_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Không tìm thấy nhân viên")
    return staff


def _reject_self(staff: Staff, current: CurrentStaff, detail: str) -> None:
    if staff.id == current.id:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=detail)


@router.get("/permissions", response_model=list[PermissionRuleOut])
def list_permissions(
    _current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
) -> list[PermissionRuleOut]:
    """Ma trận quyền hiện hành (chỉ đọc), cho màn 94 Vai trò & quyền."""
    return [
        PermissionRuleOut(permission=perm.value, description=rule.description, roles=rule.roles)
        for perm, rule in PERMISSION_MATRIX.items()
    ]


@router.get("", response_model=list[StaffDetailOut])
def list_staff(
    role: StaffRole | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
    session: Session = Depends(get_session),
) -> list[StaffDetailOut]:
    stmt = select(Staff).where(Staff.outlet_id == current.outlet_id).order_by(Staff.username)
    if role is not None:
        stmt = stmt.where(Staff.role == role)
    if is_active is not None:
        stmt = stmt.where(Staff.is_active.is_(is_active))
    return [StaffDetailOut.model_validate(s) for s in session.execute(stmt).scalars().all()]


@router.post("", response_model=StaffDetailOut, status_code=status.HTTP_201_CREATED)
def create_staff(
    payload: StaffCreate,
    idempotency_key: str = Depends(require_idempotency_key),
    current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
    session: Session = Depends(get_session),
) -> StaffDetailOut:
    endpoint = "POST /api/v1/staff"
    # Không đưa mật khẩu vào hash lưu ở bảng idempotency_key.
    request_hash = hash_request_body(payload.model_dump(mode="json", exclude={"password"}))

    existing = get_idempotent_response(
        session, key=idempotency_key, endpoint=endpoint, request_hash=request_hash
    )
    if existing is not None:
        if existing.response_status != status.HTTP_201_CREATED:
            raise HTTPException(existing.response_status, detail=existing.response_body)
        return StaffDetailOut.model_validate_json(existing.response_body)

    username_taken = HTTPException(
        status.HTTP_409_CONFLICT, detail=f"Tên đăng nhập '{payload.username}' đã tồn tại"
    )
    if session.execute(select(Staff.id).where(Staff.username == payload.username)).first():
        raise username_taken

    staff = Staff(
        outlet_id=current.outlet_id,
        username=payload.username,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name,
        role=payload.role,
    )
    session.add(staff)
    try:
        session.flush()
    except IntegrityError:
        # 2 request cùng tạo 1 username đồng thời: unique constraint chặn request sau.
        session.rollback()
        raise username_taken
    session.refresh(staff)

    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="STAFF_CREATED",
        entity_type="staff",
        entity_id=staff.id,
        payload={"username": staff.username, "role": staff.role},
    )

    result = StaffDetailOut.model_validate(staff)
    session.add(
        IdempotencyKey(
            key=idempotency_key,
            endpoint=endpoint,
            request_hash=request_hash,
            response_status=status.HTTP_201_CREATED,
            response_body=result.model_dump_json(),
        )
    )
    session.commit()
    return result


@router.get("/{staff_id}", response_model=StaffDetailOut)
def get_staff(
    staff_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
    session: Session = Depends(get_session),
) -> StaffDetailOut:
    return StaffDetailOut.model_validate(_load_staff_or_404(session, staff_id, current.outlet_id))


@router.patch("/{staff_id}", response_model=StaffDetailOut)
def update_staff(
    staff_id: uuid.UUID,
    payload: StaffUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
    session: Session = Depends(get_session),
) -> StaffDetailOut:
    staff = _load_staff_or_404(session, staff_id, current.outlet_id)

    changes = payload.model_dump(exclude_unset=True)
    if None in changes.values():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="full_name/role không được null"
        )

    audit_payload = {}
    if "full_name" in changes and changes["full_name"] != staff.full_name:
        audit_payload["full_name"] = {"from": staff.full_name, "to": changes["full_name"]}
        staff.full_name = changes["full_name"]
    if "role" in changes and changes["role"] != staff.role:
        _reject_self(staff, current, "Không thể tự đổi role của chính mình")
        audit_payload["role"] = {"from": staff.role, "to": changes["role"]}
        staff.role = changes["role"]
        staff.token_version += 1

    if audit_payload:
        write_audit_log(
            session,
            outlet_id=current.outlet_id,
            staff_id=current.id,
            action="STAFF_UPDATED",
            entity_type="staff",
            entity_id=staff.id,
            payload=audit_payload,
        )
        session.commit()
        session.refresh(staff)
    return StaffDetailOut.model_validate(staff)


def _set_active(
    session: Session, staff_id: uuid.UUID, current: CurrentStaff, *, is_active: bool
) -> StaffDetailOut:
    staff = _load_staff_or_404(session, staff_id, current.outlet_id)
    _reject_self(staff, current, "Không thể tự khóa hoặc mở khóa tài khoản của chính mình")

    if staff.is_active != is_active:
        staff.is_active = is_active
        staff.token_version += 1
        write_audit_log(
            session,
            outlet_id=current.outlet_id,
            staff_id=current.id,
            action="STAFF_UNLOCKED" if is_active else "STAFF_LOCKED",
            entity_type="staff",
            entity_id=staff.id,
            payload={"username": staff.username},
        )
        session.commit()
        session.refresh(staff)
    return StaffDetailOut.model_validate(staff)


@router.post("/{staff_id}/lock", response_model=StaffDetailOut)
def lock_staff(
    staff_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
    session: Session = Depends(get_session),
) -> StaffDetailOut:
    """Khóa ngay: không đăng nhập được, token đang dùng bị từ chối từ request kế tiếp."""
    return _set_active(session, staff_id, current, is_active=False)


@router.post("/{staff_id}/unlock", response_model=StaffDetailOut)
def unlock_staff(
    staff_id: uuid.UUID,
    current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
    session: Session = Depends(get_session),
) -> StaffDetailOut:
    return _set_active(session, staff_id, current, is_active=True)


@router.post("/{staff_id}/reset-password", response_model=StaffDetailOut)
def reset_staff_password(
    staff_id: uuid.UUID,
    payload: StaffResetPassword,
    current: CurrentStaff = Depends(require_permission(Permission.STAFF_MANAGE)),
    session: Session = Depends(get_session),
) -> StaffDetailOut:
    staff = _load_staff_or_404(session, staff_id, current.outlet_id)
    _reject_self(staff, current, "Tự đổi mật khẩu qua POST /auth/change-password")

    staff.password_hash = hash_password(payload.new_password)
    staff.token_version += 1
    write_audit_log(
        session,
        outlet_id=current.outlet_id,
        staff_id=current.id,
        action="STAFF_PASSWORD_RESET",
        entity_type="staff",
        entity_id=staff.id,
        payload={"username": staff.username},
    )
    session.commit()
    session.refresh(staff)
    return StaffDetailOut.model_validate(staff)
