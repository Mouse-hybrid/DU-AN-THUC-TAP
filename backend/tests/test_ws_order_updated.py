"""Event ORDER_UPDATED trên kênh `tables`: mọi thao tác ghi vào order đều báo
cho màn POS / chi tiết bàn, kể cả bước bếp (ITEM_READY để phục vụ ra lấy món)."""

from __future__ import annotations

from app.core.realtime import manager
from tests.conftest import login


def _record_events(monkeypatch):
    events: list[tuple[str, str, dict]] = []

    def fake_publish(outlet_id, channel, event_type, data=None):
        events.append((channel, event_type, data or {}))

    monkeypatch.setattr(manager, "publish", fake_publish)
    return events


def _post(client, url, headers, key, body=None):
    resp = client.post(url, json=body, headers={**headers, "Idempotency-Key": key})
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def test_every_order_write_publishes_order_updated(client, seed, monkeypatch):
    events = _record_events(monkeypatch)
    waiter = login(client, "waiter_test")
    kitchen = login(client, "kitchen_test")
    cashier = login(client, "cashier_test")

    session = _post(
        client,
        f"/api/v1/tables/{seed['table_id']}/open-session",
        waiter,
        "ou-open",
        {"guest_count": 2},
    )
    order_id = _post(
        client, "/api/v1/orders", waiter, "ou-order", {"table_session_id": session["id"]}
    )["id"]
    item_id = _post(
        client,
        f"/api/v1/orders/{order_id}/items",
        waiter,
        "ou-items",
        {"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
    )["items"][0]["id"]
    _post(client, f"/api/v1/orders/{order_id}/send-to-kitchen", waiter, "ou-send")
    base = f"/api/v1/orders/{order_id}/items/{item_id}"
    _post(client, f"{base}/start-cooking", kitchen, "ou-start")
    _post(client, f"{base}/mark-ready", kitchen, "ou-ready")
    _post(client, f"{base}/pickup", waiter, "ou-pickup")
    _post(client, f"{base}/served", waiter, "ou-served")
    _post(client, f"/api/v1/orders/{order_id}/request-billing", cashier, "ou-billing")
    _post(client, f"/api/v1/orders/{order_id}/pay", cashier, "ou-pay")

    updates = [data for channel, kind, data in events if kind == "ORDER_UPDATED"]
    assert all(channel == "tables" for channel, kind, _ in events if kind == "ORDER_UPDATED")
    assert [u["reason"] for u in updates] == [
        "ORDER_CREATED",
        "ITEMS_ADDED",
        "SENT_TO_KITCHEN",
        "ITEM_STARTED",
        "ITEM_READY",
        "ITEM_PICKED_UP",
        "ITEM_SERVED",
        "BILLING_REQUESTED",
        "ORDER_PAID",
    ]
    ready = updates[4]
    assert ready["item_id"] == item_id
    assert ready["order_id"] == order_id
    assert ready["table_id"] == str(seed["table_id"])
    assert updates[-1]["status"] == "PAID"
    assert updates[1]["item_id"] is None


def test_idempotent_replay_does_not_publish_again(client, seed, monkeypatch):
    waiter = login(client, "waiter_test")
    session = _post(
        client,
        f"/api/v1/tables/{seed['table_id']}/open-session",
        waiter,
        "ou-r-open",
        {"guest_count": 2},
    )
    body = {"table_session_id": session["id"]}
    _post(client, "/api/v1/orders", waiter, "ou-r-order", body)

    events = _record_events(monkeypatch)
    _post(client, "/api/v1/orders", waiter, "ou-r-order", body)  # gửi lại cùng key
    assert [kind for _, kind, _ in events] == []


def test_tables_channel_receives_order_updated_over_websocket(client, seed):
    waiter = login(client, "waiter_test")
    token = waiter["Authorization"].split()[1]
    session = _post(
        client,
        f"/api/v1/tables/{seed['table_id']}/open-session",
        waiter,
        "ou-ws-open",
        {"guest_count": 2},
    )
    with client.websocket_connect(f"/api/v1/ws?token={token}&channel=tables") as ws:
        _post(client, "/api/v1/orders", waiter, "ou-ws-order", {"table_session_id": session["id"]})
        ws.send_text("ping")
        received = []
        while True:
            message = ws.receive_json()
            if message.get("type") == "pong":
                break
            received.append(message)

    order_events = [m for m in received if m["type"] == "ORDER_UPDATED"]
    assert order_events and order_events[0]["data"]["reason"] == "ORDER_CREATED"
    assert order_events[0]["channel"] == "tables"
