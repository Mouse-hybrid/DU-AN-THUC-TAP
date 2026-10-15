"""GET /api/v1/audit-logs và GET /api/v1/orders/{id}/versions — chỉ Supervisor,
dùng để QA lấy actor/thời điểm của từng thao tác (TC-012 start-cooking, TC-019
refire) mà không phải vào database staging."""

from __future__ import annotations

import uuid

from tests.conftest import login


def _sent_order(client, seed, prefix):
    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, "Idempotency-Key": f"{prefix}-open"},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders",
        json={"table_session_id": session_id},
        headers={**waiter, "Idempotency-Key": f"{prefix}-order"},
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
        headers={**waiter, "Idempotency-Key": f"{prefix}-items"},
    )
    sent = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": f"{prefix}-send"},
    ).json()
    return order_id, sent["order"]["items"][0]["id"], waiter


def _step(client, order_id, item_id, action, headers, key):
    resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/{action}",
        headers={**headers, "Idempotency-Key": key},
    )
    assert resp.status_code == 200, resp.text


def test_audit_shows_kitchen_actor_for_start_cooking(client, seed):
    order_id, item_id, _ = _sent_order(client, seed, "aud-cook")
    _step(client, order_id, item_id, "start-cooking", login(client, "kitchen_test"), "aud-cook-1")

    supervisor = login(client, "supervisor_test")
    logs = client.get(f"/api/v1/audit-logs?order_id={order_id}", headers=supervisor).json()
    # Thao tác trên order và trên món của nó đều có (SQLite chỉ lưu tới giây nên
    # không kiểm thứ tự các dòng cùng giây ở đây).
    assert {"ORDER_CREATED", "ORDER_SENT_TO_KITCHEN", "ORDER_ITEM_START_COOKING"} <= {
        log["action"] for log in logs
    }
    cooking = next(log for log in logs if log["action"] == "ORDER_ITEM_START_COOKING")
    assert cooking["entity_id"] == item_id
    assert cooking["staff_username"] == "kitchen_test"
    assert cooking["staff_role"] == "KITCHEN"
    assert cooking["created_at"]


def test_refire_audit_and_versions_show_supervisor(client, seed):
    order_id, item_id, waiter = _sent_order(client, seed, "aud-refire")
    kitchen = login(client, "kitchen_test")
    _step(client, order_id, item_id, "start-cooking", kitchen, "aud-r-1")
    _step(client, order_id, item_id, "mark-ready", kitchen, "aud-r-2")
    _step(client, order_id, item_id, "pickup", waiter, "aud-r-3")
    _step(client, order_id, item_id, "served", waiter, "aud-r-4")
    supervisor = login(client, "supervisor_test")
    _step(client, order_id, item_id, "refire", supervisor, "aud-r-5")

    logs = client.get(
        f"/api/v1/audit-logs?entity_id={item_id}&action=ORDER_ITEM_REFIRED", headers=supervisor
    ).json()
    assert [(log["staff_username"], log["staff_role"]) for log in logs] == [
        ("supervisor_test", "SUPERVISOR")
    ]
    assert logs[0]["payload"] is None

    versions = client.get(f"/api/v1/orders/{order_id}/versions", headers=supervisor).json()
    current = client.get(f"/api/v1/orders/{order_id}", headers=supervisor).json()
    latest = versions[-1]
    assert latest["version_number"] == current["current_version"]
    assert latest["created_by_username"] == "supervisor_test"
    assert latest["snapshot"]["items"][0]["status"] == "REFIRED"
    assert [v["version_number"] for v in versions] == sorted(v["version_number"] for v in versions)


def test_audit_and_versions_are_supervisor_only(client, seed):
    order_id, _, _ = _sent_order(client, seed, "aud-rbac")
    for username in ("cashier_test", "waiter_test", "kitchen_test"):
        headers = login(client, username)
        assert client.get("/api/v1/audit-logs", headers=headers).status_code == 403
        assert client.get(f"/api/v1/orders/{order_id}/versions", headers=headers).status_code == 403
    assert client.get("/api/v1/audit-logs").status_code == 401


def test_unknown_order_is_404(client, seed):
    supervisor = login(client, "supervisor_test")
    missing = uuid.uuid4()
    assert client.get(f"/api/v1/orders/{missing}/versions", headers=supervisor).status_code == 404
    assert (
        client.get(f"/api/v1/audit-logs?order_id={missing}", headers=supervisor).status_code == 404
    )
