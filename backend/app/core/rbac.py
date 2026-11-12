"""Quyền thực tế = ma trận mặc định (app/core/permissions.py) + các ô Supervisor đã sửa trên
màn Vai trò (bảng role_permission_override, theo outlet).

Đọc DB ở mỗi request (bảng rất nhỏ, có khóa duy nhất theo outlet), nên sửa quyền có hiệu lực
ngay ở request kế tiếp, không cần đăng nhập lại và không cần cache dùng chung giữa tiến trình.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import PERMISSION_MATRIX, Permission
from app.db.models import STAFF_ROLE, RolePermissionOverride

# Ô không sửa được: bỏ quyền Quản lý nhân viên của Supervisor thì không ai vào lại được màn
# Nhân viên / Vai trò để sửa lại.
LOCKED_GRANTS: frozenset[tuple[Permission, str]] = frozenset(
    {(Permission.STAFF_MANAGE, "SUPERVISOR")}
)


def default_roles(permission: Permission) -> frozenset[str]:
    return frozenset(PERMISSION_MATRIX[permission].roles)


def locked_roles(permission: Permission) -> frozenset[str]:
    return frozenset(role for perm, role in LOCKED_GRANTS if perm == permission)


def _overrides(session: Session, outlet_id: uuid.UUID, permission: Permission | None = None):
    stmt = select(RolePermissionOverride).where(RolePermissionOverride.outlet_id == outlet_id)
    if permission is not None:
        stmt = stmt.where(RolePermissionOverride.permission == permission.value)
    return list(session.scalars(stmt))


def _apply(base: frozenset[str], rows) -> frozenset[str]:
    roles = set(base)
    for row in rows:
        if row.allowed:
            roles.add(row.role)
        else:
            roles.discard(row.role)
    return frozenset(roles)


def effective_roles(
    session: Session, outlet_id: uuid.UUID, permission: Permission
) -> frozenset[str]:
    return _apply(default_roles(permission), _overrides(session, outlet_id, permission))


def effective_matrix(session: Session, outlet_id: uuid.UUID) -> dict[Permission, frozenset[str]]:
    rows_by_perm: dict[str, list] = {}
    for row in _overrides(session, outlet_id):
        rows_by_perm.setdefault(row.permission, []).append(row)
    return {
        perm: _apply(default_roles(perm), rows_by_perm.get(perm.value, []))
        for perm in PERMISSION_MATRIX
    }


def role_has(session: Session, outlet_id: uuid.UUID, role: str, permission: Permission) -> bool:
    return role in effective_roles(session, outlet_id, permission)


def permissions_for(session: Session, outlet_id: uuid.UUID, role: str) -> list[str]:
    return [
        perm.value for perm, roles in effective_matrix(session, outlet_id).items() if role in roles
    ]


def set_roles(
    session: Session,
    outlet_id: uuid.UUID,
    permission: Permission,
    roles: set[str],
    staff_id: uuid.UUID,
) -> tuple[set[str], set[str]]:
    """Đặt danh sách role có `permission`; lưu phần khác mặc định. Trả (thêm, bớt) so với trước."""
    unknown = roles - set(STAFF_ROLE)
    if unknown:
        raise ValueError(f"Vai trò không hợp lệ: {', '.join(sorted(unknown))}")
    missing_locked = locked_roles(permission) - roles
    if missing_locked:
        raise PermissionError(
            f"Không thể bỏ quyền này của {', '.join(sorted(missing_locked))}"
        )
    before = effective_roles(session, outlet_id, permission)
    base = default_roles(permission)
    existing = {row.role: row for row in _overrides(session, outlet_id, permission)}
    for role in STAFF_ROLE:
        wanted = role in roles
        row = existing.get(role)
        if wanted == (role in base):
            if row is not None:
                session.delete(row)
        elif row is None:
            session.add(
                RolePermissionOverride(
                    outlet_id=outlet_id,
                    permission=permission.value,
                    role=role,
                    allowed=wanted,
                    updated_by_staff_id=staff_id,
                )
            )
        else:
            row.allowed = wanted
            row.updated_by_staff_id = staff_id
    session.flush()
    return roles - before, before - roles


def reset_to_default(session: Session, outlet_id: uuid.UUID) -> int:
    rows = _overrides(session, outlet_id)
    for row in rows:
        session.delete(row)
    session.flush()
    return len(rows)
