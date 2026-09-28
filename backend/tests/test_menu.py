"""Test GET /menu (BE-S1-08)."""

from __future__ import annotations

from app.db.models import MenuItem
from tests.conftest import login


def test_list_menu_requires_auth(client, seed):
    resp = client.get("/api/v1/menu")
    assert resp.status_code == 401


def test_list_menu_returns_seeded_item(client, seed):
    headers = login(client, "waiter_test")
    resp = client.get("/api/v1/menu", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == str(seed["menu_item_id"])
    assert body[0]["name"] == "Mon Test"
    assert body[0]["is_available"] is True


def test_list_menu_available_only_filter(client, seed, db_session_factory):
    session = db_session_factory()
    item = session.get(MenuItem, seed["menu_item_id"])
    item.is_available = False
    session.commit()
    session.close()

    headers = login(client, "kitchen_test")
    resp = client.get("/api/v1/menu?available_only=true", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == []
