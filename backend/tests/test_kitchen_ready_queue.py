"""GET /kitchen/queue?item_status=READY — màn 34 "chờ phục vụ lấy": chỉ món bếp
đã xong mà chưa ai lấy. Lọc theo phiếu (status=DONE) còn lẫn món đã lấy/phục vụ."""

from __future__ import annotations

from tests.conftest import login


def _post(client, url, headers, key, body=None):
    resp = client.post(url, json=body, headers={**headers, "Idempotency-Key": key})
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def _two_items_sent(client, seed, prefix):
    waiter = login(client, "waiter_test")
    session = _post(
        client,
        f"/api/v1/tables/{seed['table_id']}/open-session",
        waiter,
        f"{prefix}-open",
        {"guest_count": 2},
    )
    order_id = _post(
        client, "/api/v1/orders", waiter, f"{prefix}-order", {"table_session_id": session["id"]}
    )["id"]
    line = {"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}
    _post(
        client,
        f"/api/v1/orders/{order_id}/items",
        waiter,
        f"{prefix}-items",
        {"items": [line, line]},
    )
    sent = _post(client, f"/api/v1/orders/{order_id}/send-to-kitchen", waiter, f"{prefix}-send")
    return order_id, [i["id"] for i in sent["order"]["items"]], waiter


def _cook_until_ready(client, order_id, item_id, kitchen, key):
    base = f"/api/v1/orders/{order_id}/items/{item_id}"
    _post(client, f"{base}/start-cooking", kitchen, f"{key}-start")
    _post(client, f"{base}/mark-ready", kitchen, f"{key}-ready")


def test_ready_filter_excludes_items_already_picked_up(client, seed):
    order_id, (waiting, picked), waiter = _two_items_sent(client, seed, "rq")
    kitchen = login(client, "kitchen_test")
    _cook_until_ready(client, order_id, waiting, kitchen, "rq-a")
    _cook_until_ready(client, order_id, picked, kitchen, "rq-b")
    _post(client, f"/api/v1/orders/{order_id}/items/{picked}/pickup", waiter, "rq-b-pickup")

    done = client.get("/api/v1/kitchen/queue?status=DONE", headers=kitchen).json()
    assert {e["order_item_id"] for e in done} == {waiting, picked}  # vấn đề FE gặp

    ready = client.get("/api/v1/kitchen/queue?item_status=READY", headers=kitchen).json()
    assert [e["order_item_id"] for e in ready] == [waiting]
    assert ready[0]["item_status"] == "READY"
    assert ready[0]["status"] == "DONE"
    assert ready[0]["done_at"]


def test_refired_item_shows_once_when_ready_again(client, seed):
    order_id, (item_id, _), waiter = _two_items_sent(client, seed, "rr")
    kitchen = login(client, "kitchen_test")
    supervisor = login(client, "supervisor_test")
    _cook_until_ready(client, order_id, item_id, kitchen, "rr-1")
    base = f"/api/v1/orders/{order_id}/items/{item_id}"
    _post(client, f"{base}/pickup", waiter, "rr-pickup")
    _post(client, f"{base}/served", waiter, "rr-served")
    _post(client, f"{base}/refire", supervisor, "rr-refire")
    _cook_until_ready(client, order_id, item_id, kitchen, "rr-2")

    ready = client.get("/api/v1/kitchen/queue?item_status=READY", headers=kitchen).json()
    assert [e["order_item_id"] for e in ready] == [item_id]  # 2 phiếu DONE, chỉ hiện 1


def test_default_queue_unchanged_and_shows_item_status(client, seed):
    order_id, item_ids, _ = _two_items_sent(client, seed, "rd")
    kitchen = login(client, "kitchen_test")
    queue = client.get("/api/v1/kitchen/queue", headers=kitchen).json()
    assert {e["order_item_id"] for e in queue} == set(item_ids)
    assert {e["item_status"] for e in queue} == {"SENT"}
    assert all(e["done_at"] is None for e in queue)


def test_invalid_item_status_is_422(client, seed):
    kitchen = login(client, "kitchen_test")
    resp = client.get("/api/v1/kitchen/queue?item_status=COOKED", headers=kitchen)
    assert resp.status_code == 422
