"""GET /api/v1/orders — danh sách order của outlet (lọc status/bàn/thời gian),
và GET /version — commit của bản đang chạy."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.core.security import hash_password
from app.db.models import MenuItem, Order, Outlet, RestaurantTable, Staff
from tests.conftest import SEED_PASSWORD, login


def _add_table(db_session_factory, outlet_id, code):
    session = db_session_factory()
    table = RestaurantTable(outlet_id=outlet_id, code=code, seats=4, status="AVAILABLE")
    session.add(table)
    session.commit()
    table_id = table.id
    session.close()
    return table_id


def _order_on_table(client, table_id, menu_item_id, prefix, quantity=1, send=False):
    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{table_id}/open-session",
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
        json={"items": [{"menu_item_id": str(menu_item_id), "quantity": quantity}]},
        headers={**waiter, "Idempotency-Key": f"{prefix}-items"},
    )
    if send:
        client.post(
            f"/api/v1/orders/{order_id}/send-to-kitchen",
            headers={**waiter, "Idempotency-Key": f"{prefix}-send"},
        )
    return order_id


def _backdate(db_session_factory, order_id, minutes):
    """Lùi created_at để thứ tự ổn định (SQLite chỉ lưu thời gian tới giây)."""
    session = db_session_factory()
    order = session.get(Order, uuid.UUID(order_id))
    order.created_at = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    session.commit()
    session.close()


def test_list_orders_returns_summary_newest_first(client, seed, db_session_factory):
    t2 = _add_table(db_session_factory, seed["outlet_id"], "T2")
    first = _order_on_table(client, seed["table_id"], seed["menu_item_id"], "l1", quantity=2)
    second = _order_on_table(client, t2, seed["menu_item_id"], "l2", send=True)
    _backdate(db_session_factory, first, 10)

    resp = client.get("/api/v1/orders", headers=login(client, "cashier_test"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [o["id"] for o in body] == [second, first]
    row = body[1]
    assert row["table_code"] == "T1"
    assert row["status"] == "NEW"
    assert row["item_count"] == 1
    assert Decimal(row["subtotal"]) == Decimal("100000.00")


def test_list_orders_filters_by_status_table_and_time(client, seed, db_session_factory):
    t2 = _add_table(db_session_factory, seed["outlet_id"], "T2")
    new_order = _order_on_table(client, seed["table_id"], seed["menu_item_id"], "f1")
    sent_order = _order_on_table(client, t2, seed["menu_item_id"], "f2", send=True)
    _backdate(db_session_factory, new_order, 10)
    headers = login(client, "supervisor_test")

    by_status = client.get("/api/v1/orders?status=SENT&status=SERVED", headers=headers).json()
    assert [o["id"] for o in by_status] == [sent_order]

    by_table = client.get(f"/api/v1/orders?table_id={seed['table_id']}", headers=headers).json()
    assert [o["id"] for o in by_table] == [new_order]

    future = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    assert client.get(f"/api/v1/orders?created_from={future}", headers=headers).json() == []

    page = client.get("/api/v1/orders?limit=1&offset=1", headers=headers).json()
    assert [o["id"] for o in page] == [new_order]


def test_list_orders_excludes_voided_items_from_totals(client, seed):
    order_id = _order_on_table(client, seed["table_id"], seed["menu_item_id"], "v1")
    waiter = login(client, "waiter_test")
    item_id = client.get(f"/api/v1/orders/{order_id}", headers=waiter).json()["items"][0]["id"]
    client.delete(
        f"/api/v1/orders/{order_id}/items/{item_id}",
        headers={**waiter, "Idempotency-Key": "v1-del"},
    )

    row = client.get("/api/v1/orders", headers=waiter).json()[0]
    assert row["item_count"] == 0
    assert Decimal(row["subtotal"]) == Decimal("0")


def test_list_orders_rejects_unknown_status(client, seed):
    resp = client.get("/api/v1/orders?status=DONE", headers=login(client, "cashier_test"))
    assert resp.status_code == 422


def test_list_orders_requires_auth(client, seed):
    assert client.get("/api/v1/orders").status_code == 401


def test_list_orders_hides_other_outlets(client, seed, db_session_factory):
    _order_on_table(client, seed["table_id"], seed["menu_item_id"], "o1")

    session = db_session_factory()
    other = Outlet(name="Outlet Khac")
    session.add(other)
    session.flush()
    session.add(
        Staff(
            outlet_id=other.id,
            username="cashier_other",
            password_hash=hash_password(SEED_PASSWORD),
            full_name="Other",
            role="CASHIER",
        )
    )
    session.add(MenuItem(outlet_id=other.id, name="Khac", price=Decimal("1000")))
    session.commit()
    session.close()

    assert client.get("/api/v1/orders", headers=login(client, "cashier_other")).json() == []
    assert len(client.get("/api/v1/orders", headers=login(client, "cashier_test")).json()) == 1


def test_version_reports_commit(client, monkeypatch):
    import app.main as main

    monkeypatch.setattr(main, "GIT_COMMIT", "0123456789abcdef")
    monkeypatch.setattr(main, "BUILT_AT", "2026-10-12T00:00:00Z")
    body = client.get("/version").json()
    assert body["commit"] == "0123456789abcdef"
    assert body["short_commit"] == "0123456"
    assert body["built_at"] == "2026-10-12T00:00:00Z"
    assert body["environment"]
