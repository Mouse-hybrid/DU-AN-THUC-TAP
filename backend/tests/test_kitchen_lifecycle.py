"""Test vòng đời món ở bếp: Start Cooking -> Mark Ready -> Pickup -> Served
(BE-S1-06). Tiếp nối vertical slice có sẵn (mở bàn -> tạo order -> gửi bếp,
xem tests/test_vertical_slice_open_order_kitchen.py)."""

from __future__ import annotations

from tests.conftest import login


def _send_one_item_to_kitchen(client, seed):
    waiter_headers = login(client, "waiter_test")
    cashier_headers = login(client, "cashier_test")
    kitchen_headers = login(client, "kitchen_test")
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]

    open_resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**waiter_headers, "Idempotency-Key": "kl-open"},
    )
    table_session_id = open_resp.json()["id"]

    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": table_session_id},
        headers={**cashier_headers, "Idempotency-Key": "kl-order"},
    )
    order_id = order_resp.json()["id"]

    items_resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": 1}]},
        headers={**cashier_headers, "Idempotency-Key": "kl-items"},
    )
    item_id = items_resp.json()["items"][0]["id"]

    client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter_headers, "Idempotency-Key": "kl-send"},
    )

    return order_id, item_id, waiter_headers, kitchen_headers


def test_start_cooking_forbidden_for_waiter(client, seed):
    order_id, item_id, waiter_headers, _kitchen_headers = _send_one_item_to_kitchen(client, seed)
    resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/start-cooking",
        headers={**waiter_headers, "Idempotency-Key": "kl-start-forbidden"},
    )
    assert resp.status_code == 403


def test_mark_ready_rejected_when_item_not_preparing(client, seed):
    order_id, item_id, _waiter_headers, kitchen_headers = _send_one_item_to_kitchen(client, seed)

    resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/mark-ready",
        headers={**kitchen_headers, "Idempotency-Key": "kl-ready-early"},
    )
    assert resp.status_code == 409


def test_full_kitchen_lifecycle_marks_order_served(client, seed):
    order_id, item_id, waiter_headers, kitchen_headers = _send_one_item_to_kitchen(client, seed)

    start_resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/start-cooking",
        headers={**kitchen_headers, "Idempotency-Key": "kl-start"},
    )
    assert start_resp.status_code == 200
    assert start_resp.json()["items"][0]["status"] == "PREPARING"

    ready_resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/mark-ready",
        headers={**kitchen_headers, "Idempotency-Key": "kl-ready"},
    )
    assert ready_resp.status_code == 200
    assert ready_resp.json()["items"][0]["status"] == "READY"

    pickup_resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/pickup",
        headers={**waiter_headers, "Idempotency-Key": "kl-pickup"},
    )
    assert pickup_resp.status_code == 200
    assert pickup_resp.json()["items"][0]["status"] == "PICKED_UP"

    served_resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/served",
        headers={**waiter_headers, "Idempotency-Key": "kl-served"},
    )
    assert served_resp.status_code == 200
    body = served_resp.json()
    assert body["items"][0]["status"] == "SERVED"
    assert body["status"] == "SERVED", "Tất cả món đã SERVED -> order tự chuyển SENT -> SERVED"


def test_start_cooking_is_idempotent_same_key(client, seed):
    order_id, item_id, _waiter_headers, kitchen_headers = _send_one_item_to_kitchen(client, seed)
    headers = {**kitchen_headers, "Idempotency-Key": "kl-start-idem"}

    first = client.post(f"/api/v1/orders/{order_id}/items/{item_id}/start-cooking", headers=headers)
    second = client.post(f"/api/v1/orders/{order_id}/items/{item_id}/start-cooking", headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
