"""Test GET /tables (dashboard) và POST /tables/{id}/mark-clean."""

from __future__ import annotations

from app.db.models import RestaurantTable
from tests.conftest import login


def _set_table_status(db_session_factory, table_id, new_status):
    session = db_session_factory()
    table = session.get(RestaurantTable, table_id)
    table.status = new_status
    session.commit()
    session.close()


def test_dashboard_requires_auth(client, seed):
    assert client.get("/api/v1/tables").status_code == 401


def test_dashboard_lists_table_without_session(client, seed):
    headers = login(client, "waiter_test")
    resp = client.get("/api/v1/tables", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["code"] == "T1"
    assert body[0]["status"] == "AVAILABLE"
    assert body[0]["current_session_id"] is None


def test_dashboard_shows_open_session(client, seed):
    headers = login(client, "waiter_test")
    open_resp = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 3},
        headers={**headers, "Idempotency-Key": "dash-open"},
    )
    assert open_resp.status_code == 201
    body = client.get("/api/v1/tables", headers=headers).json()
    assert body[0]["status"] == "OCCUPIED"
    assert body[0]["current_session_id"] == open_resp.json()["id"]
    assert body[0]["guest_count"] == 3


def test_mark_clean_requires_idempotency_key(client, seed, db_session_factory):
    _set_table_status(db_session_factory, seed["table_id"], "CLEANING")
    headers = login(client, "waiter_test")
    resp = client.post(f"/api/v1/tables/{seed['table_id']}/mark-clean", headers=headers)
    assert resp.status_code == 400


def test_mark_clean_forbidden_for_cashier(client, seed, db_session_factory):
    _set_table_status(db_session_factory, seed["table_id"], "CLEANING")
    headers = login(client, "cashier_test")
    resp = client.post(
        f"/api/v1/tables/{seed['table_id']}/mark-clean",
        headers={**headers, "Idempotency-Key": "clean-403"},
    )
    assert resp.status_code == 403


def test_mark_clean_conflict_when_not_cleaning(client, seed):
    headers = login(client, "waiter_test")
    resp = client.post(
        f"/api/v1/tables/{seed['table_id']}/mark-clean",
        headers={**headers, "Idempotency-Key": "clean-409"},
    )
    assert resp.status_code == 409


def test_mark_clean_success_and_replay(client, seed, db_session_factory):
    _set_table_status(db_session_factory, seed["table_id"], "CLEANING")
    headers = {**login(client, "waiter_test"), "Idempotency-Key": "clean-ok"}
    url = f"/api/v1/tables/{seed['table_id']}/mark-clean"

    first = client.post(url, headers=headers)
    assert first.status_code == 200
    assert first.json()["status"] == "AVAILABLE"

    replay = client.post(url, headers=headers)
    assert replay.status_code == 200
    assert replay.json() == first.json()
