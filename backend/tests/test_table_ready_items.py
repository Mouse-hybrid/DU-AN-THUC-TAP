"""Sơ đồ bàn (GET /tables) đếm số phần món bếp đã xong, đang chờ phục vụ mang ra."""

from __future__ import annotations

import uuid

from tests.conftest import login


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _ready_items(client, headers, table_id):
    tables = client.get("/api/v1/tables", headers=headers).json()
    return next(t for t in tables if t["id"] == str(table_id))["ready_items"]


def test_ready_items_count_follows_kitchen_and_pickup(client, seed):
    waiter = login(client, "waiter_test")
    kitchen = login(client, "kitchen_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, **_key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**waiter, **_key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 3}]},
        headers={**waiter, **_key()},
    )
    client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**waiter, **_key()})
    item_id = client.get(f"/api/v1/orders/{order_id}", headers=waiter).json()["items"][0]["id"]
    assert _ready_items(client, waiter, seed["table_id"]) == 0

    base = f"/api/v1/orders/{order_id}/items/{item_id}"
    assert client.post(f"{base}/start-cooking", headers={**kitchen, **_key()}).status_code == 200
    assert _ready_items(client, waiter, seed["table_id"]) == 0
    assert client.post(f"{base}/mark-ready", headers={**kitchen, **_key()}).status_code == 200
    assert _ready_items(client, waiter, seed["table_id"]) == 3

    assert client.post(f"{base}/pickup", headers={**waiter, **_key()}).status_code == 200
    assert _ready_items(client, waiter, seed["table_id"]) == 0


def test_empty_tables_have_zero_ready_items(client, seed):
    waiter = login(client, "waiter_test")
    tables = client.get("/api/v1/tables", headers=waiter).json()
    assert all(t["ready_items"] == 0 for t in tables)
