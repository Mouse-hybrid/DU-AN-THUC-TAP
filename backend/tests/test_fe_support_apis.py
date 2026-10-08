"""Test các API phục vụ 15 màn hình FE Pha 1 (Figma NOVA POS):

- CORS cho FE chạy ở domain/cổng khác API.
- GET /api/v1/orders/{id}   — screen-09 POS ordering / screen-19 order summary.
- GET /api/v1/tables/{id}   — screen-05 table detail.
- Nhóm món + ?q= / ?category_id= cho GET /menu — screen-12 item search, screen-102.
- sla_status + ?delayed_only= cho GET /kitchen/queue — screen-33 delayed queue.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.api.v1.kitchen import compute_sla
from app.core.config import parse_cors_origins
from app.db.models import KitchenQueue
from tests.conftest import login


def _open_order_with_item(client, seed, prefix, quantity=2):
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
    items = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": quantity}]},
        headers={**cashier, "Idempotency-Key": f"{prefix}-items"},
    ).json()["items"]
    return session_id, order_id, items[0]["id"], cashier, waiter


# --- CORS -----------------------------------------------------------------


def test_cors_preflight_allows_dev_frontend_with_custom_headers(client):
    resp = client.options(
        "/api/v1/menu",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,idempotency-key,content-type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "http://localhost:5173"
    allowed = resp.headers["access-control-allow-headers"].lower()
    assert "idempotency-key" in allowed and "authorization" in allowed


def test_cors_does_not_allow_unknown_origin(client):
    resp = client.get("/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in resp.headers


def test_cors_config_rejects_wildcard_and_trims_values():
    assert parse_cors_origins(" http://a.test/ , ,http://b.test") == [
        "http://a.test",
        "http://b.test",
    ]
    with pytest.raises(RuntimeError):
        parse_cors_origins("http://a.test,*")


# --- GET /orders/{id} --------------------------------------------------------


def test_get_order_returns_names_line_totals_and_subtotal(client, seed):
    _, order_id, item_id, cashier, _ = _open_order_with_item(client, seed, "detail", quantity=2)

    resp = client.get(f"/api/v1/orders/{order_id}", headers=cashier)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["table_code"] == "T1"
    assert body["items"][0]["menu_item_name"] == "Mon Test"
    assert body["items"][0]["line_total"] == "100000.00"
    assert body["subtotal"] == "100000.00"

    # Món đã bỏ (VOIDED) vẫn hiện trong lịch sử nhưng không cộng vào subtotal.
    client.delete(
        f"/api/v1/orders/{order_id}/items/{item_id}",
        headers={**cashier, "Idempotency-Key": "detail-del"},
    )
    body = client.get(f"/api/v1/orders/{order_id}", headers=cashier).json()
    assert body["items"][0]["status"] == "VOIDED"
    assert body["subtotal"] == "0"


def test_get_order_unknown_returns_404(client, seed):
    cashier = login(client, "cashier_test")
    resp = client.get("/api/v1/orders/00000000-0000-0000-0000-000000000000", headers=cashier)
    assert resp.status_code == 404


# --- GET /tables/{id} --------------------------------------------------------


def test_table_detail_without_session(client, seed):
    waiter = login(client, "waiter_test")
    resp = client.get(f"/api/v1/tables/{seed['table_id']}", headers=waiter)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "AVAILABLE"
    assert body["current_session"] is None
    assert body["orders"] == []


def test_table_detail_with_open_session_and_order(client, seed):
    session_id, order_id, _, _, waiter = _open_order_with_item(client, seed, "tbl")

    body = client.get(f"/api/v1/tables/{seed['table_id']}", headers=waiter).json()
    assert body["status"] == "OCCUPIED"
    assert body["current_session"]["id"] == session_id
    assert [o["id"] for o in body["orders"]] == [order_id]
    assert body["orders"][0]["items"][0]["menu_item_name"] == "Mon Test"


# --- Menu categories + search --------------------------------------------------


def test_category_crud_and_filter_menu(client, seed):
    supervisor = login(client, "supervisor_test")

    created = client.post(
        "/api/v1/menu/categories",
        json={"name": "Do uong", "sort_order": 2},
        headers={**supervisor, "Idempotency-Key": "cat-1"},
    )
    assert created.status_code == 201, created.text
    category_id = created.json()["id"]

    dup = client.post(
        "/api/v1/menu/categories",
        json={"name": "Do uong"},
        headers={**supervisor, "Idempotency-Key": "cat-dup"},
    )
    assert dup.status_code == 409

    item = client.post(
        "/api/v1/menu",
        json={"name": "Tra Dao", "price": "35000", "category_id": category_id},
        headers={**supervisor, "Idempotency-Key": "menu-tra-dao"},
    )
    assert item.status_code == 201, item.text
    assert item.json()["category_id"] == category_id

    by_category = client.get(f"/api/v1/menu?category_id={category_id}", headers=supervisor)
    assert [m["name"] for m in by_category.json()] == ["Tra Dao"]

    by_name = client.get("/api/v1/menu?q=tra", headers=supervisor)
    assert [m["name"] for m in by_name.json()] == ["Tra Dao"]

    hidden = client.patch(
        f"/api/v1/menu/categories/{category_id}",
        json={"is_active": False},
        headers=supervisor,
    )
    assert hidden.status_code == 200
    active = client.get("/api/v1/menu/categories?active_only=true", headers=supervisor).json()
    assert active == []


def test_menu_search_treats_percent_literally(client, seed):
    cashier = login(client, "cashier_test")
    resp = client.get("/api/v1/menu?q=%25", headers=cashier)  # q="%"
    assert resp.status_code == 200
    assert resp.json() == []


def test_only_supervisor_manages_categories(client, seed):
    waiter = login(client, "waiter_test")
    resp = client.post(
        "/api/v1/menu/categories",
        json={"name": "Mon chinh"},
        headers={**waiter, "Idempotency-Key": "cat-waiter"},
    )
    assert resp.status_code == 403


def test_menu_item_rejects_category_of_unknown_id(client, seed):
    supervisor = login(client, "supervisor_test")
    resp = client.post(
        "/api/v1/menu",
        json={
            "name": "Mon la",
            "price": "10000",
            "category_id": "00000000-0000-0000-0000-000000000000",
        },
        headers={**supervisor, "Idempotency-Key": "menu-bad-cat"},
    )
    assert resp.status_code == 404


# --- Kitchen SLA ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("minutes", "expected"),
    [(0, "NORMAL"), (7.9, "NORMAL"), (8, "WARNING"), (12, "DELAYED"), (15, "CRITICAL")],
)
def test_compute_sla_thresholds(minutes, expected):
    now = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
    _, sla = compute_sla("IN_PROGRESS", now - timedelta(minutes=minutes), now)
    assert sla == expected


def test_compute_sla_not_started_is_normal():
    now = datetime.now(timezone.utc)
    assert compute_sla("QUEUED", None, now) == (None, "NORMAL")


def test_kitchen_queue_delayed_only(client, seed, db_session_factory):
    _, order_id, _, _, waiter = _open_order_with_item(client, seed, "sla")
    client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": "sla-send"},
    )

    session = db_session_factory()
    entry = session.execute(select(KitchenQueue)).scalars().one()
    entry.status = "IN_PROGRESS"
    entry.started_at = datetime.now(timezone.utc) - timedelta(minutes=13)
    session.commit()
    session.close()

    kitchen = login(client, "kitchen_test")
    all_items = client.get("/api/v1/kitchen/queue", headers=kitchen).json()
    assert all_items[0]["sla_status"] == "DELAYED"
    assert all_items[0]["elapsed_minutes"] >= 13

    delayed = client.get("/api/v1/kitchen/queue?delayed_only=true", headers=kitchen).json()
    assert len(delayed) == 1
