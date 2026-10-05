"""Test GET /kitchen/queue và GET /kitchen/stations."""

from __future__ import annotations

from tests.conftest import login


def _send_one_item(client, seed, prefix="kq"):
    waiter = login(client, "waiter_test")
    cashier = login(client, "cashier_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, "Idempotency-Key": f"{prefix}-open"},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders",
        json={"table_session_id": session_id},
        headers={**cashier, "Idempotency-Key": f"{prefix}-order"},
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 2}]},
        headers={**cashier, "Idempotency-Key": f"{prefix}-items"},
    )
    send = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": f"{prefix}-send"},
    )
    assert send.status_code == 200
    return order_id


def test_queue_requires_auth(client, seed):
    assert client.get("/api/v1/kitchen/queue").status_code == 401


def test_queue_forbidden_for_waiter(client, seed):
    headers = login(client, "waiter_test")
    assert client.get("/api/v1/kitchen/queue", headers=headers).status_code == 403


def test_queue_empty_before_send(client, seed):
    headers = login(client, "kitchen_test")
    resp = client.get("/api/v1/kitchen/queue", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_queue_lists_sent_item(client, seed):
    order_id = _send_one_item(client, seed)
    headers = login(client, "kitchen_test")
    body = client.get("/api/v1/kitchen/queue", headers=headers).json()
    assert len(body) == 1
    assert body[0]["order_id"] == order_id
    assert body[0]["table_code"] == "T1"
    assert body[0]["menu_item_name"] == "Mon Test"
    assert body[0]["quantity"] == 2
    assert body[0]["status"] == "QUEUED"


def test_queue_filter_by_station_and_status(client, seed):
    _send_one_item(client, seed)
    headers = login(client, "supervisor_test")
    by_station = client.get(
        f"/api/v1/kitchen/queue?station_id={seed['station_id']}", headers=headers
    )
    assert len(by_station.json()) == 1
    done = client.get("/api/v1/kitchen/queue?status=DONE", headers=headers)
    assert done.json() == []
    bad = client.get("/api/v1/kitchen/queue?status=NOPE", headers=headers)
    assert bad.status_code == 422


def test_stations_list(client, seed):
    headers = login(client, "waiter_test")
    body = client.get("/api/v1/kitchen/stations", headers=headers).json()
    assert [s["name"] for s in body] == ["Station Test"]
