"""Supervisor sửa ma trận quyền trên màn Vai trò: có hiệu lực ngay, theo outlet, ghi audit,
không bỏ được quyền Quản lý nhân viên của Supervisor, khôi phục được mặc định."""

from __future__ import annotations

import uuid

import pytest

from app.core.security import hash_password
from app.db.models import AuditLog, Outlet, RolePermissionOverride, Staff
from tests.conftest import SEED_PASSWORD, login


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def ctx(client, seed):
    return {
        "supervisor": login(client, "supervisor_test"),
        "cashier": login(client, "cashier_test"),
        "waiter": login(client, "waiter_test"),
    }


def _rows(client, headers):
    resp = client.get("/api/v1/staff/permissions", headers=headers)
    assert resp.status_code == 200, resp.text
    return {row["permission"]: row for row in resp.json()}


def _set(client, headers, permission, roles, key=None):
    return client.put(
        f"/api/v1/staff/permissions/{permission}",
        json={"roles": roles},
        headers={**headers, "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _me_permissions(client, headers):
    return client.get("/api/v1/auth/me", headers=headers).json()["permissions"]


def test_list_shows_defaults_and_locked_cells(client, ctx):
    rows = _rows(client, ctx["supervisor"])
    pay = rows["PROCESS_PAYMENT"]
    assert pay["roles"] == ["CASHIER", "SUPERVISOR"]
    assert pay["default_roles"] == ["CASHIER", "SUPERVISOR"]
    assert pay["customized"] is False
    assert rows["STAFF_MANAGE"]["locked_roles"] == ["SUPERVISOR"]
    assert rows["MENU_WRITE"]["locked_roles"] == []


def test_grant_takes_effect_immediately_without_relogin(client, ctx, db_session_factory):
    assert client.get("/api/v1/audit-logs", headers=ctx["cashier"]).status_code == 403
    assert "AUDIT_READ" not in _me_permissions(client, ctx["cashier"])

    resp = _set(client, ctx["supervisor"], "AUDIT_READ", ["CASHIER", "SUPERVISOR"])
    assert resp.status_code == 200, resp.text
    row = {r["permission"]: r for r in resp.json()}["AUDIT_READ"]
    assert row["roles"] == ["CASHIER", "SUPERVISOR"] and row["customized"] is True

    # Cùng token cũ của cashier, không đăng nhập lại.
    assert client.get("/api/v1/audit-logs", headers=ctx["cashier"]).status_code == 200
    assert "AUDIT_READ" in _me_permissions(client, ctx["cashier"])

    session = db_session_factory()
    audit = session.query(AuditLog).filter_by(action="ROLE_PERMISSION_UPDATED").one()
    assert '"added": ["CASHIER"]' in audit.payload
    session.close()


def test_revoke_default_permission(client, ctx):
    resp = _set(client, ctx["supervisor"], "TABLE_OPEN", ["CASHIER", "SUPERVISOR"])
    assert resp.status_code == 200
    assert "TABLE_OPEN" not in _me_permissions(client, ctx["waiter"])
    resp = client.post(
        "/api/v1/tables/00000000-0000-0000-0000-000000000000/open-session",
        json={"guest_count": 1},
        headers={**ctx["waiter"], **_key()},
    )
    assert resp.status_code == 403


def test_back_to_default_removes_override_rows(client, ctx, db_session_factory):
    _set(client, ctx["supervisor"], "MENU_WRITE", ["CASHIER", "SUPERVISOR"])
    resp = _set(client, ctx["supervisor"], "MENU_WRITE", ["SUPERVISOR"])
    row = {r["permission"]: r for r in resp.json()}["MENU_WRITE"]
    assert row["customized"] is False
    session = db_session_factory()
    assert session.query(RolePermissionOverride).count() == 0
    session.close()


def test_cannot_remove_staff_manage_from_supervisor(client, ctx):
    resp = _set(client, ctx["supervisor"], "STAFF_MANAGE", [])
    assert resp.status_code == 409
    assert "SUPERVISOR" in resp.json()["detail"]
    # Thêm vai trò khác vẫn được, miễn còn Supervisor.
    resp = _set(client, ctx["supervisor"], "STAFF_MANAGE", ["SUPERVISOR", "CASHIER"])
    assert resp.status_code == 200


def test_reset_restores_defaults(client, ctx, db_session_factory):
    _set(client, ctx["supervisor"], "AUDIT_READ", ["CASHIER", "SUPERVISOR"])
    _set(client, ctx["supervisor"], "SERVE_FOOD", ["SUPERVISOR"])
    resp = client.post("/api/v1/staff/permissions/reset", headers={**ctx["supervisor"], **_key()})
    assert resp.status_code == 200, resp.text
    assert not any(row["customized"] for row in resp.json())
    assert client.get("/api/v1/audit-logs", headers=ctx["cashier"]).status_code == 403
    session = db_session_factory()
    assert session.query(AuditLog).filter_by(action="ROLE_PERMISSIONS_RESET").count() == 1
    session.close()


def test_only_staff_manage_can_edit_and_input_is_validated(client, ctx):
    assert _set(client, ctx["cashier"], "AUDIT_READ", ["CASHIER"]).status_code == 403
    assert _set(client, ctx["supervisor"], "KHONG_CO", ["CASHIER"]).status_code == 422
    assert _set(client, ctx["supervisor"], "AUDIT_READ", ["ADMIN"]).status_code == 422
    resp = client.put(
        "/api/v1/staff/permissions/AUDIT_READ",
        json={"roles": ["SUPERVISOR"]},
        headers=ctx["supervisor"],
    )
    assert resp.status_code == 400  # thiếu Idempotency-Key


def test_same_idempotency_key_replays(client, ctx, db_session_factory):
    key = str(uuid.uuid4())
    first = _set(client, ctx["supervisor"], "AUDIT_READ", ["CASHIER", "SUPERVISOR"], key=key)
    again = _set(client, ctx["supervisor"], "AUDIT_READ", ["CASHIER", "SUPERVISOR"], key=key)
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    session = db_session_factory()
    assert session.query(AuditLog).filter_by(action="ROLE_PERMISSION_UPDATED").count() == 1
    session.close()


def test_overrides_are_per_outlet(client, ctx, db_session_factory):
    session = db_session_factory()
    other = Outlet(name="Outlet khac")
    session.add(other)
    session.flush()
    session.add(
        Staff(
            outlet_id=other.id,
            username="cashier_other",
            password_hash=hash_password(SEED_PASSWORD),
            full_name="Cashier khac",
            role="CASHIER",
        )
    )
    session.commit()
    session.close()

    _set(client, ctx["supervisor"], "AUDIT_READ", ["CASHIER", "SUPERVISOR"])
    other_cashier = login(client, "cashier_other")
    assert client.get("/api/v1/audit-logs", headers=other_cashier).status_code == 403
    assert client.get("/api/v1/audit-logs", headers=ctx["cashier"]).status_code == 200
