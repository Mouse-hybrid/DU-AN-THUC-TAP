"""Test sửa/bỏ món TRƯỚC khi gửi bếp (BRD In Scope: "Order modification
(before kitchen send)").

PATCH  /api/v1/orders/{order_id}/items/{item_id} — sửa quantity/note món CREATED.
DELETE /api/v1/orders/{order_id}/items/{item_id} — bỏ món CREATED (-> VOIDED).
Món đã gửi bếp thì phải đi qua void/refire (Supervisor), không sửa trực tiếp.
"""

from __future__ import annotations

from sqlalchemy import select

from app.db.models import AuditLog, OrderVersion
from tests.conftest import login


def _open_order_with_item(client, table_id, menu_item_id, prefix):
    waiter_headers = login(client, "waiter_test")
    cashier_headers = login(client, "cashier_test")

    open_resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**waiter_headers, "Idempotency-Key": f"{prefix}-open"},
    )
    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": open_resp.json()["id"]},
        headers={**cashier_headers, "Idempotency-Key": f"{prefix}-order"},
    )
    order_id = order_resp.json()["id"]
    items_resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": 1, "note": "it cay"}]},
        headers={**cashier_headers, "Idempotency-Key": f"{prefix}-items"},
    )
    item_id = items_resp.json()["items"][0]["id"]
    return order_id, item_id, cashier_headers, waiter_headers


def test_cashier_updates_quantity_and_note_before_send(client, seed, db_session_factory):
    order_id, item_id, cashier, _ = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "upd"
    )

    resp = client.patch(
        f"/api/v1/orders/{order_id}/items/{item_id}",
        json={"quantity": 3, "note": "khong hanh"},
        headers={**cashier, "Idempotency-Key": "upd-patch"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    item = body["items"][0]
    assert item["quantity"] == 3
    assert item["note"] == "khong hanh"
    assert item["status"] == "CREATED"

    session = db_session_factory()
    versions = (
        session.execute(select(OrderVersion).where(OrderVersion.order_id == order_id))
        .scalars()
        .all()
    )
    assert [v.version_number for v in versions] == [body["current_version"]]
    actions = session.execute(select(AuditLog.action)).scalars().all()
    assert "ORDER_ITEM_UPDATED" in actions
    session.close()


def test_patch_only_note_keeps_quantity_and_null_clears_note(client, seed):
    order_id, item_id, cashier, _ = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "note"
    )

    resp = client.patch(
        f"/api/v1/orders/{order_id}/items/{item_id}",
        json={"note": None},
        headers={**cashier, "Idempotency-Key": "note-patch"},
    )
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["quantity"] == 1
    assert item["note"] is None


def test_patch_rejects_empty_body_and_null_quantity(client, seed):
    order_id, item_id, cashier, _ = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "empty"
    )
    url = f"/api/v1/orders/{order_id}/items/{item_id}"

    assert (
        client.patch(url, json={}, headers={**cashier, "Idempotency-Key": "e1"}).status_code == 422
    )
    assert (
        client.patch(
            url, json={"quantity": None}, headers={**cashier, "Idempotency-Key": "e2"}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            url, json={"quantity": 0}, headers={**cashier, "Idempotency-Key": "e3"}
        ).status_code
        == 422
    )


def test_patch_is_idempotent(client, seed):
    order_id, item_id, cashier, _ = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "idem"
    )
    url = f"/api/v1/orders/{order_id}/items/{item_id}"
    headers = {**cashier, "Idempotency-Key": "idem-patch"}

    first = client.patch(url, json={"quantity": 2}, headers=headers)
    second = client.patch(url, json={"quantity": 2}, headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()["current_version"] == second.json()["current_version"]


def test_cannot_edit_or_remove_item_after_send_to_kitchen(client, seed):
    order_id, item_id, cashier, waiter = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "sent"
    )
    client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": "sent-send"},
    )
    supervisor = login(client, "supervisor_test")
    url = f"/api/v1/orders/{order_id}/items/{item_id}"

    patch_resp = client.patch(
        url, json={"quantity": 2}, headers={**supervisor, "Idempotency-Key": "sent-patch"}
    )
    assert patch_resp.status_code == 409
    delete_resp = client.delete(url, headers={**supervisor, "Idempotency-Key": "sent-del"})
    assert delete_resp.status_code == 409


def test_waiter_can_edit_items_before_send(client, seed):
    """PO chốt 09/10/2026: Waiter sửa/bỏ món được khi chưa gửi bếp."""
    order_id, item_id, _, waiter = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "role"
    )
    resp = client.patch(
        f"/api/v1/orders/{order_id}/items/{item_id}",
        json={"quantity": 2},
        headers={**waiter, "Idempotency-Key": "role-patch"},
    )
    assert resp.status_code == 200, resp.text


def test_waiter_cannot_add_items_after_send(client, seed):
    """BRD Waiter: "Cannot modify orders after sent to kitchen" — giữ nguyên."""
    order_id, _, _, waiter = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "after"
    )
    client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": "after-send"},
    )
    resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
        headers={**waiter, "Idempotency-Key": "after-more-items"},
    )
    assert resp.status_code == 403


def test_kitchen_cannot_edit_items(client, seed):
    order_id, item_id, _, _ = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "kit"
    )
    kitchen = login(client, "kitchen_test")
    resp = client.patch(
        f"/api/v1/orders/{order_id}/items/{item_id}",
        json={"quantity": 2},
        headers={**kitchen, "Idempotency-Key": "kit-patch"},
    )
    assert resp.status_code == 403


def test_remove_item_before_send_marks_voided_and_is_not_sent(client, seed, db_session_factory):
    order_id, item_id, cashier, waiter = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "del"
    )

    resp = client.delete(
        f"/api/v1/orders/{order_id}/items/{item_id}",
        headers={**cashier, "Idempotency-Key": "del-del"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["status"] == "VOIDED"

    # Món đã bỏ không còn được gửi xuống bếp.
    send_resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": "del-send"},
    )
    assert send_resp.status_code == 409

    session = db_session_factory()
    actions = session.execute(select(AuditLog.action)).scalars().all()
    assert "ORDER_ITEM_REMOVED_BEFORE_SEND" in actions
    session.close()


def test_edit_requires_idempotency_key(client, seed):
    order_id, item_id, cashier, _ = _open_order_with_item(
        client, seed["table_id"], seed["menu_item_id"], "nokey"
    )
    resp = client.patch(
        f"/api/v1/orders/{order_id}/items/{item_id}", json={"quantity": 2}, headers=cashier
    )
    assert resp.status_code in (400, 422)
