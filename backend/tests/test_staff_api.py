"""Quản lý nhân viên (/api/v1/staff) và tài khoản của chính mình (/auth/me,
/auth/change-password): phạm vi outlet, chặn tự khóa, thu hồi token, audit."""

from __future__ import annotations

import pytest
from fastapi import WebSocketDisconnect

from app.core.security import hash_password
from app.db.models import AuditLog, Outlet, Staff
from tests.conftest import SEED_PASSWORD, login

NEW_PASSWORD = "matkhaumoi456"


def _create(client, headers, key="staff-1", **overrides):
    body = {
        "username": "nv_moi",
        "password": NEW_PASSWORD,
        "full_name": "Nhan Vien Moi",
        "role": "WAITER",
        **overrides,
    }
    return client.post("/api/v1/staff", json=body, headers={**headers, "Idempotency-Key": key})


def _audit_actions(db_session_factory, entity_id):
    session = db_session_factory()
    try:
        return [
            log.action for log in session.query(AuditLog).filter_by(entity_id=str(entity_id)).all()
        ]
    finally:
        session.close()


def test_create_staff_can_login_with_role_and_audited(client, seed, db_session_factory):
    resp = _create(client, login(client, "supervisor_test"))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["role"] == "WAITER" and body["is_active"] is True
    assert body["outlet_id"] == str(seed["outlet_id"])
    assert "password" not in resp.text

    me = client.get("/api/v1/auth/me", headers=login(client, "nv_moi", NEW_PASSWORD)).json()
    assert me["username"] == "nv_moi"
    assert "SERVE_FOOD" in me["permissions"] and "PROCESS_PAYMENT" not in me["permissions"]
    assert _audit_actions(db_session_factory, body["id"]) == ["STAFF_CREATED"]


def test_create_staff_is_idempotent(client, seed):
    supervisor = login(client, "supervisor_test")
    first = _create(client, supervisor, key="dup")
    second = _create(client, supervisor, key="dup")
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]


def test_create_staff_rejects_duplicate_username(client, seed):
    resp = _create(client, login(client, "supervisor_test"), username="waiter_test")
    assert resp.status_code == 409


@pytest.mark.parametrize(
    "overrides",
    [
        {"password": "ngan"},
        {"password": "ắ" * 25},  # 75 byte, bcrypt chỉ dùng 72 byte đầu
        {"username": "co dau cach"},
        {"username": "ab"},
        {"role": "ADMIN"},
        {"full_name": ""},
    ],
)
def test_create_staff_validation(client, seed, overrides):
    resp = _create(client, login(client, "supervisor_test"), **overrides)
    assert resp.status_code == 422


def test_password_of_exactly_72_bytes_accepted(client, seed):
    password = "ắ" * 24
    resp = _create(client, login(client, "supervisor_test"), password=password)
    assert resp.status_code == 201
    login(client, "nv_moi", password)


def test_list_filters_and_stays_in_outlet(client, seed, db_session_factory):
    session = db_session_factory()
    other = Outlet(name="Outlet Khac")
    session.add(other)
    session.flush()
    outsider = Staff(
        outlet_id=other.id,
        username="nguoi_ngoai",
        password_hash=hash_password(SEED_PASSWORD),
        full_name="Nguoi Ngoai",
        role="WAITER",
    )
    session.add(outsider)
    session.commit()
    outsider_id = outsider.id
    session.close()

    supervisor = login(client, "supervisor_test")
    usernames = {s["username"] for s in client.get("/api/v1/staff", headers=supervisor).json()}
    assert usernames == {"supervisor_test", "cashier_test", "waiter_test", "kitchen_test"}

    waiters = client.get("/api/v1/staff?role=WAITER", headers=supervisor).json()
    assert [s["username"] for s in waiters] == ["waiter_test"]

    assert client.get(f"/api/v1/staff/{outsider_id}", headers=supervisor).status_code == 404
    assert client.post(f"/api/v1/staff/{outsider_id}/lock", headers=supervisor).status_code == 404


def test_lock_revokes_immediately_and_unlock_needs_new_login(client, seed, db_session_factory):
    waiter_id = seed["staff_ids"]["WAITER"]
    supervisor = login(client, "supervisor_test")
    waiter = login(client, "waiter_test")
    assert client.get("/api/v1/tables", headers=waiter).status_code == 200

    locked = client.post(f"/api/v1/staff/{waiter_id}/lock", headers=supervisor)
    assert locked.status_code == 200 and locked.json()["is_active"] is False
    assert client.get("/api/v1/tables", headers=waiter).status_code == 401
    bad_login = client.post(
        "/api/v1/auth/login", json={"username": "waiter_test", "password": SEED_PASSWORD}
    )
    assert bad_login.status_code == 401

    client.post(f"/api/v1/staff/{waiter_id}/unlock", headers=supervisor)
    # Token từ trước khi khóa không sống lại sau khi mở khóa.
    assert client.get("/api/v1/tables", headers=waiter).status_code == 401
    assert client.get("/api/v1/tables", headers=login(client, "waiter_test")).status_code == 200
    assert _audit_actions(db_session_factory, waiter_id) == ["STAFF_LOCKED", "STAFF_UNLOCKED"]


def test_supervisor_cannot_lock_demote_or_reset_self(client, seed):
    supervisor_id = seed["staff_ids"]["SUPERVISOR"]
    headers = login(client, "supervisor_test")
    url = f"/api/v1/staff/{supervisor_id}"

    assert client.post(f"{url}/lock", headers=headers).status_code == 409
    assert client.patch(url, json={"role": "WAITER"}, headers=headers).status_code == 409
    reset = client.post(
        f"{url}/reset-password", json={"new_password": NEW_PASSWORD}, headers=headers
    )
    assert reset.status_code == 409
    # Tự đổi tên của mình thì được, token vẫn dùng tiếp.
    renamed = client.patch(url, json={"full_name": "Ten Moi"}, headers=headers)
    assert renamed.status_code == 200 and renamed.json()["full_name"] == "Ten Moi"
    assert client.get(url, headers=headers).status_code == 200


def test_role_change_applies_and_forces_relogin(client, seed):
    waiter_id = seed["staff_ids"]["WAITER"]
    supervisor = login(client, "supervisor_test")
    old_token = login(client, "waiter_test")

    resp = client.patch(f"/api/v1/staff/{waiter_id}", json={"role": "KITCHEN"}, headers=supervisor)
    assert resp.status_code == 200 and resp.json()["role"] == "KITCHEN"
    assert client.get("/api/v1/tables", headers=old_token).status_code == 401

    kitchen = login(client, "waiter_test")
    assert client.get("/api/v1/kitchen/queue", headers=kitchen).status_code == 200


def test_update_rejects_null(client, seed):
    resp = client.patch(
        f"/api/v1/staff/{seed['staff_ids']['WAITER']}",
        json={"role": None},
        headers=login(client, "supervisor_test"),
    )
    assert resp.status_code == 422


def test_reset_password_revokes_old_token_and_old_password(client, seed, db_session_factory):
    waiter_id = seed["staff_ids"]["WAITER"]
    supervisor = login(client, "supervisor_test")
    old_token = login(client, "waiter_test")

    resp = client.post(
        f"/api/v1/staff/{waiter_id}/reset-password",
        json={"new_password": NEW_PASSWORD},
        headers=supervisor,
    )
    assert resp.status_code == 200
    assert client.get("/api/v1/tables", headers=old_token).status_code == 401
    old_login = client.post(
        "/api/v1/auth/login", json={"username": "waiter_test", "password": SEED_PASSWORD}
    )
    assert old_login.status_code == 401
    login(client, "waiter_test", NEW_PASSWORD)

    session = db_session_factory()
    log = session.query(AuditLog).filter_by(action="STAFF_PASSWORD_RESET").one()
    assert NEW_PASSWORD not in (log.payload or "")
    session.close()


def test_change_password_returns_new_token_and_revokes_old(client, seed):
    old = login(client, "cashier_test")

    wrong = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "saimatkhau", "new_password": NEW_PASSWORD},
        headers=old,
    )
    assert wrong.status_code == 400
    same = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": SEED_PASSWORD, "new_password": SEED_PASSWORD},
        headers=old,
    )
    assert same.status_code == 400

    resp = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": SEED_PASSWORD, "new_password": NEW_PASSWORD},
        headers=old,
    )
    assert resp.status_code == 200, resp.text
    new = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    assert client.get("/api/v1/auth/me", headers=new).status_code == 200
    assert client.get("/api/v1/auth/me", headers=old).status_code == 401
    login(client, "cashier_test", NEW_PASSWORD)


def test_permission_matrix_endpoint(client, seed):
    rows = client.get("/api/v1/staff/permissions", headers=login(client, "supervisor_test")).json()
    pay = next(row for row in rows if row["permission"] == "PROCESS_PAYMENT")
    assert set(pay["roles"]) == {"CASHIER", "SUPERVISOR"}
    assert pay["description"]


def test_websocket_rejects_revoked_token(client, seed):
    waiter_id = seed["staff_ids"]["WAITER"]
    token = login(client, "waiter_test")["Authorization"].split()[1]
    client.post(f"/api/v1/staff/{waiter_id}/lock", headers=login(client, "supervisor_test"))
    client.post(f"/api/v1/staff/{waiter_id}/unlock", headers=login(client, "supervisor_test"))

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/v1/ws?token={token}&channel=tables"):
            pass
