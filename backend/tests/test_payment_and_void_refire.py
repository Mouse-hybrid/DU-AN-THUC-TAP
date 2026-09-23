"""Test vòng đời thanh toán (SENT/SERVED -> BILLING -> PAID -> CLOSED) và
void/refire món — nối tiếp vertical slice ở test_vertical_slice_open_order_kitchen.py.

Role dùng đúng theo Permission Matrix thật trong BRD: Cashier tạo order/thêm
món, Waiter mở bàn/gửi bếp, Supervisor duy nhất được void/refire (Override
Actions) và cùng Cashier xử lý Process Payment.
"""
from __future__ import annotations

from app.db.models import RestaurantTable, TableSession
from tests.conftest import login


def _open_order_and_send_to_kitchen(client, table_id, menu_item_id, prefix):
    waiter_headers = login(client, "waiter_test")
    cashier_headers = login(client, "cashier_test")

    open_resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**waiter_headers, "Idempotency-Key": f"{prefix}-open"},
    )
    table_session_id = open_resp.json()["id"]

    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": table_session_id},
        headers={**cashier_headers, "Idempotency-Key": f"{prefix}-order"},
    )
    order_id = order_resp.json()["id"]

    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": 1}]},
        headers={**cashier_headers, "Idempotency-Key": f"{prefix}-items"},
    )

    send_resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter_headers, "Idempotency-Key": f"{prefix}-send"},
    )
    assert send_resp.status_code == 200
    item_id = send_resp.json()["order"]["items"][0]["id"]

    return table_session_id, order_id, item_id


def test_payment_flow_billing_pay_close(client, seed):
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]
    _, order_id, _ = _open_order_and_send_to_kitchen(client, table_id, menu_item_id, "pay-flow")

    cashier_headers = login(client, "cashier_test")  # Process Payment: Cashier hoac Supervisor

    billing_resp = client.post(
        f"/api/v1/orders/{order_id}/request-billing",
        headers={**cashier_headers, "Idempotency-Key": "pay-flow-billing"},
    )
    assert billing_resp.status_code == 200
    assert billing_resp.json()["status"] == "BILLING"

    pay_resp = client.post(
        f"/api/v1/orders/{order_id}/pay",
        headers={**cashier_headers, "Idempotency-Key": "pay-flow-pay"},
    )
    assert pay_resp.status_code == 200
    assert pay_resp.json()["status"] == "PAID"

    close_resp = client.post(
        f"/api/v1/orders/{order_id}/close",
        headers={**cashier_headers, "Idempotency-Key": "pay-flow-close"},
    )
    assert close_resp.status_code == 200
    assert close_resp.json()["status"] == "CLOSED"


def test_waiter_can_request_billing_but_not_pay(client, seed):
    """Request Bill: Cashier+Waiter+Supervisor deu duoc. Process Payment: CHỈ
    Cashier+Supervisor — Waiter bị BRD cấm rõ ràng ("Cannot process payment")."""
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]
    _, order_id, _ = _open_order_and_send_to_kitchen(client, table_id, menu_item_id, "waiter-billing")

    waiter_headers = login(client, "waiter_test")
    billing_resp = client.post(
        f"/api/v1/orders/{order_id}/request-billing",
        headers={**waiter_headers, "Idempotency-Key": "waiter-billing-req"},
    )
    assert billing_resp.status_code == 200

    pay_resp = client.post(
        f"/api/v1/orders/{order_id}/pay",
        headers={**waiter_headers, "Idempotency-Key": "waiter-billing-pay"},
    )
    assert pay_resp.status_code == 403


def test_pay_closes_table_session_and_sets_table_cleaning(client, seed, db_session_factory):
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]
    table_session_id, order_id, _ = _open_order_and_send_to_kitchen(client, table_id, menu_item_id, "pay-side-effect")

    cashier_headers = login(client, "cashier_test")
    client.post(
        f"/api/v1/orders/{order_id}/request-billing",
        headers={**cashier_headers, "Idempotency-Key": "pay-side-effect-billing"},
    )
    client.post(
        f"/api/v1/orders/{order_id}/pay",
        headers={**cashier_headers, "Idempotency-Key": "pay-side-effect-pay"},
    )

    session = db_session_factory()
    table_session = session.get(TableSession, table_session_id)
    table = session.get(RestaurantTable, table_id)
    assert table_session.status == "CLOSED"
    assert table_session.closed_at is not None
    assert table.status == "CLEANING"
    session.close()


def test_cannot_pay_before_billing(client, seed):
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]
    _, order_id, _ = _open_order_and_send_to_kitchen(client, table_id, menu_item_id, "pay-guard")

    cashier_headers = login(client, "cashier_test")
    resp = client.post(
        f"/api/v1/orders/{order_id}/pay",
        headers={**cashier_headers, "Idempotency-Key": "pay-guard-pay"},
    )
    assert resp.status_code == 409


def test_void_item_requires_supervisor(client, seed):
    """Void = "Override Actions" trong Permission Matrix -> chỉ Supervisor."""
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]
    waiter_headers = login(client, "waiter_test")
    cashier_headers = login(client, "cashier_test")

    open_resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**waiter_headers, "Idempotency-Key": "void-open"},
    )
    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": open_resp.json()["id"]},
        headers={**cashier_headers, "Idempotency-Key": "void-order"},
    )
    order_id = order_resp.json()["id"]
    items_resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": 1}]},
        headers={**cashier_headers, "Idempotency-Key": "void-items"},
    )
    item_id = items_resp.json()["items"][0]["id"]

    supervisor_headers = login(client, "supervisor_test")
    void_resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/void",
        json={"reason": "khach doi mon"},
        headers={**supervisor_headers, "Idempotency-Key": "void-void"},
    )
    assert void_resp.status_code == 200
    voided_item = next(i for i in void_resp.json()["items"] if i["id"] == item_id)
    assert voided_item["status"] == "VOIDED"


def test_void_forbidden_for_waiter_and_cashier(client, seed):
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]
    waiter_headers = login(client, "waiter_test")
    cashier_headers = login(client, "cashier_test")

    open_resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**waiter_headers, "Idempotency-Key": "void-forbidden-open"},
    )
    order_resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": open_resp.json()["id"]},
        headers={**cashier_headers, "Idempotency-Key": "void-forbidden-order"},
    )
    order_id = order_resp.json()["id"]
    items_resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": 1}]},
        headers={**cashier_headers, "Idempotency-Key": "void-forbidden-items"},
    )
    item_id = items_resp.json()["items"][0]["id"]

    for role_headers, key in ((waiter_headers, "void-forbidden-waiter"), (cashier_headers, "void-forbidden-cashier")):
        resp = client.post(
            f"/api/v1/orders/{order_id}/items/{item_id}/void",
            json={},
            headers={**role_headers, "Idempotency-Key": key},
        )
        assert resp.status_code == 403


def test_refire_served_item_requires_supervisor_and_creates_new_kitchen_queue_entry(client, seed, db_session_factory):
    table_id = seed["table_id"]
    menu_item_id = seed["menu_item_id"]
    _, order_id, item_id = _open_order_and_send_to_kitchen(client, table_id, menu_item_id, "refire-flow")

    # Danh dau mon la da SERVED truc tiep qua DB (chua co API rieng cho buoc nay).
    from app.db.models import OrderItem

    session = db_session_factory()
    item = session.get(OrderItem, item_id)
    item.status = "SERVED"
    session.commit()
    session.close()

    # Kitchen KHONG duoc refire (BRD: "Kitchen: Cannot modify orders").
    kitchen_headers = login(client, "kitchen_test")
    forbidden_resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/refire",
        headers={**kitchen_headers, "Idempotency-Key": "refire-flow-kitchen-forbidden"},
    )
    assert forbidden_resp.status_code == 403

    supervisor_headers = login(client, "supervisor_test")
    resp = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/refire",
        headers={**supervisor_headers, "Idempotency-Key": "refire-flow-refire"},
    )
    assert resp.status_code == 200
    refired_item = next(i for i in resp.json()["items"] if i["id"] == item_id)
    assert refired_item["status"] == "REFIRED"

    session = db_session_factory()
    from app.db.models import KitchenQueue

    entries = session.query(KitchenQueue).filter(KitchenQueue.order_item_id == item_id).all()
    assert len(entries) == 2  # 1 tu send-to-kitchen ban dau + 1 tu refire
    session.close()
