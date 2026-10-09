"""Test vertical slice: Mở bàn (Waiter) → Tạo order (Cashier) → Thêm món
(Cashier) → Gửi bếp (Waiter).

Role theo quyết định PO 09/10/2026: Cashier, Waiter, Supervisor đều mở bàn,
tạo order, thêm món, gửi bếp được (1 nhân viên đi hết luồng); Kitchen thì
không. Xem chi tiết trong app/api/v1/orders.py.

Bao gồm cả các nhánh lỗi quan trọng (thiếu Idempotency-Key, sai role, gửi
bếp khi chưa có món, tính idempotent của API mở bàn) — không chỉ happy path.
"""

from __future__ import annotations

from app.db.models import RestaurantTable
from tests.conftest import login


def test_login_wrong_password_returns_401(client, seed):
    resp = client.post(
        "/api/v1/auth/login", json={"username": "cashier_test", "password": "sai-mat-khau"}
    )
    assert resp.status_code == 401


def test_login_success_returns_token_and_staff_info(client, seed):
    resp = client.post(
        "/api/v1/auth/login", json={"username": "waiter_test", "password": "password123"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"]
    assert body["staff"]["username"] == "waiter_test"
    assert body["staff"]["role"] == "WAITER"


def test_open_session_requires_idempotency_key_header(client, seed):
    headers = login(client, "waiter_test")
    table_id = seed["table_id"]
    resp = client.post(
        f"/api/v1/tables/{table_id}/open-session", json={"guest_count": 2}, headers=headers
    )
    assert resp.status_code == 400


def test_open_session_forbidden_for_kitchen_role(client, seed):
    headers = login(client, "kitchen_test")
    headers["Idempotency-Key"] = "open-forbidden"
    table_id = seed["table_id"]
    resp = client.post(
        f"/api/v1/tables/{table_id}/open-session", json={"guest_count": 2}, headers=headers
    )
    assert resp.status_code == 403


def _single_role_dine_in_flow(client, seed, username, prefix):
    """Một nhân viên tự mở bàn → tạo order → thêm món → gửi bếp."""
    headers = login(client, username)
    open_resp = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**headers, "Idempotency-Key": f"{prefix}-open"},
    )
    assert open_resp.status_code == 201, open_resp.text
    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": open_resp.json()["id"]},
        headers={**headers, "Idempotency-Key": f"{prefix}-order"},
    )
    assert order_resp.status_code == 201, order_resp.text
    order_id = order_resp.json()["id"]
    items_resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
        headers={**headers, "Idempotency-Key": f"{prefix}-items"},
    )
    assert items_resp.status_code == 201, items_resp.text
    send_resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**headers, "Idempotency-Key": f"{prefix}-send"},
    )
    assert send_resp.status_code == 200, send_resp.text
    assert send_resp.json()["order"]["status"] == "SENT"


def test_waiter_alone_can_run_dine_in_flow(client, seed):
    """PO chốt 09/10/2026: Waiter mở bàn xong tự gọi món và gửi bếp được."""
    _single_role_dine_in_flow(client, seed, "waiter_test", "solo-waiter")


def test_cashier_alone_can_run_dine_in_flow(client, seed):
    """PO chốt 09/10/2026 (khớp HLR UC-TABLE-002 "Waiter / Cashier")."""
    _single_role_dine_in_flow(client, seed, "cashier_test", "solo-cashier")


def test_kitchen_cannot_create_order_or_send(client, seed):
    waiter = login(client, "waiter_test")
    kitchen = login(client, "kitchen_test")
    open_resp = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, "Idempotency-Key": "kit-open"},
    )
    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": open_resp.json()["id"]},
        headers={**kitchen, "Idempotency-Key": "kit-order"},
    )
    assert order_resp.status_code == 403

    order_id = client.post(
        "/api/v1/orders",
        json={"table_session_id": open_resp.json()["id"]},
        headers={**waiter, "Idempotency-Key": "kit-order-waiter"},
    ).json()["id"]
    send_resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**kitchen, "Idempotency-Key": "kit-send"},
    )
    assert send_resp.status_code == 403


def test_open_session_rejects_table_not_available(client, seed, db_session_factory):
    headers = login(client, "waiter_test")
    table_id = seed["table_id"]

    session = db_session_factory()
    table = session.get(RestaurantTable, table_id)
    table.status = "CLEANING"
    session.commit()
    session.close()

    resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**headers, "Idempotency-Key": "open-cleaning"},
    )
    assert resp.status_code == 409


def test_open_session_is_idempotent_same_key_same_body(client, seed):
    headers = login(client, "waiter_test")
    headers["Idempotency-Key"] = "open-idem-1"
    table_id = seed["table_id"]

    first = client.post(
        f"/api/v1/tables/{table_id}/open-session", json={"guest_count": 2}, headers=headers
    )
    second = client.post(
        f"/api/v1/tables/{table_id}/open-session", json={"guest_count": 2}, headers=headers
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert (
        first.json()["id"] == second.json()["id"]
    ), "Cùng Idempotency-Key phải trả về đúng 1 table_session, không tạo mới lần 2"


def test_idempotency_key_reused_with_different_body_is_conflict(client, seed):
    headers = login(client, "waiter_test")
    headers["Idempotency-Key"] = "open-conflict"
    table_id = seed["table_id"]

    first = client.post(
        f"/api/v1/tables/{table_id}/open-session", json={"guest_count": 2}, headers=headers
    )
    assert first.status_code == 201

    second = client.post(
        f"/api/v1/tables/{table_id}/open-session", json={"guest_count": 5}, headers=headers
    )
    assert second.status_code == 409


def test_send_to_kitchen_fails_without_pending_items(client, seed):
    waiter_headers = login(client, "waiter_test")
    cashier_headers = login(client, "cashier_test")
    table_id = seed["table_id"]

    open_resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**waiter_headers, "Idempotency-Key": "open-empty"},
    )
    table_session_id = open_resp.json()["id"]

    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": table_session_id},
        headers={**cashier_headers, "Idempotency-Key": "order-empty"},
    )
    order_id = order_resp.json()["id"]

    send_resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter_headers, "Idempotency-Key": "send-empty"},
    )
    assert send_resp.status_code == 409


def test_full_flow_open_table_create_order_send_to_kitchen(client, seed, db_session_factory):
    waiter_headers = login(client, "waiter_test")
    cashier_headers = login(client, "cashier_test")
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]

    open_resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 4},
        headers={**waiter_headers, "Idempotency-Key": "open-full"},
    )
    assert open_resp.status_code == 201
    table_session_id = open_resp.json()["id"]
    assert open_resp.json()["status"] == "OPEN"

    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": table_session_id},
        headers={**cashier_headers, "Idempotency-Key": "order-full"},
    )
    assert order_resp.status_code == 201
    order_id = order_resp.json()["id"]
    assert order_resp.json()["status"] == "NEW"

    items_resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": 2, "note": "it cay"}]},
        headers={**cashier_headers, "Idempotency-Key": "items-full"},
    )
    assert items_resp.status_code == 201
    assert len(items_resp.json()["items"]) == 1
    assert items_resp.json()["items"][0]["status"] == "CREATED"

    send_resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter_headers, "Idempotency-Key": "send-full"},
    )
    assert send_resp.status_code == 200
    body = send_resp.json()
    assert body["kitchen_queue_entries_created"] == 1
    assert body["order"]["status"] == "SENT"
    assert body["order"]["items"][0]["status"] == "SENT"

    # Sau khi gui bep (status != NEW), Cashier KHONG con duoc them mon nua —
    # chi Supervisor moi override duoc (xem app/api/v1/orders.py).
    blocked_resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": 1}]},
        headers={**cashier_headers, "Idempotency-Key": "items-after-send-blocked"},
    )
    assert blocked_resp.status_code == 403

    # Ban phai chuyen AVAILABLE -> OCCUPIED ngay khi mo phien
    session = db_session_factory()
    table = session.get(RestaurantTable, table_id)
    assert table.status == "OCCUPIED"
    session.close()
