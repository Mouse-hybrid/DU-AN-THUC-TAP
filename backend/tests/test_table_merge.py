"""Gộp bàn: một phiên, một đơn, một hóa đơn; món và phiếu bếp đi theo; bàn phụ MERGED rồi
được trả lại khi thanh toán; các trường hợp bị chặn; idempotency; audit."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.db.models import AuditLog, KitchenQueue, Order, RestaurantTable
from tests.conftest import login


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _add_table(db_session_factory, outlet_id, code, status="AVAILABLE"):
    session = db_session_factory()
    table = RestaurantTable(outlet_id=outlet_id, code=code, seats=4, status=status)
    session.add(table)
    session.commit()
    table_id = table.id
    session.close()
    return table_id


def _seat(client, seed, waiter, table_id, quantity=0, send=False, guests=2):
    session_id = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": guests},
        headers={**waiter, **_key()},
    ).json()["id"]
    if not quantity:
        return session_id, None
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**waiter, **_key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": quantity}]},
        headers={**waiter, **_key()},
    )
    if send:
        client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**waiter, **_key()})
    return session_id, order_id


@pytest.fixture()
def tables(client, seed, db_session_factory):
    waiter = login(client, "waiter_test")
    t2 = _add_table(db_session_factory, seed["outlet_id"], "T2")
    t3 = _add_table(db_session_factory, seed["outlet_id"], "T3")
    return {"waiter": waiter, "t1": seed["table_id"], "t2": t2, "t3": t3}


def _merge(client, tables, primary, others, headers=None, key=None):
    return client.post(
        f"/api/v1/tables/{primary}/merge",
        json={"table_ids": [str(t) for t in others]},
        headers={**(headers or tables["waiter"]), "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _statuses(client, headers):
    return {t["code"]: t for t in client.get("/api/v1/tables", headers=headers).json()}


def test_merge_into_one_order_and_one_bill(client, seed, tables, db_session_factory):
    waiter = tables["waiter"]
    primary_session, primary_order = _seat(client, seed, waiter, tables["t1"], 1, send=True)
    _, second_order = _seat(client, seed, waiter, tables["t2"], 2, send=True, guests=3)

    resp = _merge(client, tables, tables["t1"], [tables["t2"]])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["table_session_id"] == primary_session and body["order_id"] == primary_order
    assert body["merged_tables"][0]["status"] == "MERGED"
    assert body["merged_tables"][0]["merged_into_table_id"] == str(tables["t1"])

    detail = client.get(f"/api/v1/tables/{tables['t1']}", headers=waiter).json()
    assert detail["current_session"]["guest_count"] == 5
    assert [o["id"] for o in detail["orders"]] == [primary_order]
    order = detail["orders"][0]
    assert sum(i["quantity"] for i in order["items"]) == 3
    assert Decimal(order["total"]) == Decimal("150000")

    session = db_session_factory()
    assert session.get(Order, uuid.UUID(second_order)).status == "CLOSED"
    assert session.query(KitchenQueue).count() == 2
    session.close()
    queue = client.get("/api/v1/kitchen/queue", headers=login(client, "kitchen_test")).json()
    assert {entry["table_code"] for entry in queue} == {"T1"}

    states = _statuses(client, waiter)
    assert states["T2"]["status"] == "MERGED"
    assert states["T2"]["merged_into_table_id"] == str(tables["t1"])
    second = client.get(f"/api/v1/tables/{tables['t2']}", headers=waiter).json()
    assert second["current_session"] is None


def test_paying_primary_releases_merged_tables(client, seed, tables):
    waiter = tables["waiter"]
    _, order_id = _seat(client, seed, waiter, tables["t1"], 1, send=True)
    _seat(client, seed, waiter, tables["t2"], 1, send=True)
    _merge(client, tables, tables["t1"], [tables["t2"], tables["t3"]])

    client.post(f"/api/v1/orders/{order_id}/request-billing", headers={**waiter, **_key()})
    paid = client.post(
        f"/api/v1/orders/{order_id}/pay", headers={**login(client, "cashier_test"), **_key()}
    )
    assert paid.status_code == 200, paid.text
    states = _statuses(client, waiter)
    for code in ("T1", "T2", "T3"):
        assert states[code]["status"] == "CLEANING"
        assert states[code]["merged_into_table_id"] is None
    cleaned = client.post(f"/api/v1/tables/{tables['t3']}/mark-clean", headers={**waiter, **_key()})
    assert cleaned.status_code == 200


def test_empty_table_can_join(client, seed, tables):
    waiter = tables["waiter"]
    _, order_id = _seat(client, seed, waiter, tables["t1"], 1)
    resp = _merge(client, tables, tables["t1"], [tables["t3"]])
    assert resp.status_code == 200, resp.text
    assert resp.json()["order_id"] == order_id
    assert _statuses(client, waiter)["T3"]["status"] == "MERGED"
    reopen = client.post(
        f"/api/v1/tables/{tables['t3']}/open-session",
        json={"guest_count": 1},
        headers={**waiter, **_key()},
    )
    assert reopen.status_code == 409


def test_primary_without_order_takes_secondary_order(client, seed, tables):
    waiter = tables["waiter"]
    primary_session, _ = _seat(client, seed, waiter, tables["t1"])
    _, second_order = _seat(client, seed, waiter, tables["t2"], 2)
    body = _merge(client, tables, tables["t1"], [tables["t2"]]).json()
    assert body["order_id"] == second_order
    order = client.get(f"/api/v1/orders/{second_order}", headers=waiter).json()
    assert order["table_session_id"] == primary_session and order["table_code"] == "T1"
    assert order["status"] == "NEW"


def test_no_orders_anywhere(client, seed, tables):
    waiter = tables["waiter"]
    _seat(client, seed, waiter, tables["t1"])
    _seat(client, seed, waiter, tables["t2"])
    body = _merge(client, tables, tables["t1"], [tables["t2"]]).json()
    assert body["order_id"] is None


def test_new_primary_order_becomes_sent_when_kitchen_items_join(client, seed, tables):
    waiter = tables["waiter"]
    _, primary_order = _seat(client, seed, waiter, tables["t1"], 1)
    _seat(client, seed, waiter, tables["t2"], 1, send=True)
    _merge(client, tables, tables["t1"], [tables["t2"]])
    order = client.get(f"/api/v1/orders/{primary_order}", headers=waiter).json()
    assert order["status"] == "SENT"
    assert {i["status"] for i in order["items"]} == {"CREATED", "SENT"}


def test_qr_of_secondary_stops_and_primary_keeps(client, seed, tables):
    waiter = tables["waiter"]
    _seat(client, seed, waiter, tables["t1"], 1)
    _seat(client, seed, waiter, tables["t2"], 1)
    tokens = {}
    for name in ("t1", "t2"):
        tokens[name] = client.post(
            f"/api/v1/tables/{tables[name]}/qr-session", headers={**waiter, **_key()}
        ).json()["token"]
    _merge(client, tables, tables["t1"], [tables["t2"]])
    assert client.get(f"/api/v1/public/qr/{tokens['t2']}").status_code == 401
    seen = client.get(f"/api/v1/public/qr/{tokens['t1']}/order").json()
    assert len(seen["items"]) == 2


def test_customer_of_secondary_is_kept_when_primary_has_none(client, seed, tables):
    waiter = tables["waiter"]
    cashier = login(client, "cashier_test")
    _, primary_order = _seat(client, seed, waiter, tables["t1"], 1)
    _, second_order = _seat(client, seed, waiter, tables["t2"], 1)
    customer = client.post(
        "/api/v1/customers",
        json={"phone": "0901234567", "consent": True},
        headers={**cashier, **_key()},
    ).json()
    client.post(
        f"/api/v1/orders/{second_order}/customer",
        json={"customer_id": customer["id"]},
        headers={**cashier, **_key()},
    )
    _merge(client, tables, tables["t1"], [tables["t2"]])
    order = client.get(f"/api/v1/orders/{primary_order}", headers=waiter).json()
    assert order["customer_id"] == customer["id"]


def test_secondary_with_reward_must_remove_first(client, seed, tables):
    waiter = tables["waiter"]
    supervisor = login(client, "supervisor_test")
    _seat(client, seed, waiter, tables["t1"], 1)
    _, second_order = _seat(client, seed, waiter, tables["t2"], 1)
    reward = client.post(
        "/api/v1/rewards",
        json={"name": "Giam", "reward_type": "FIXED", "value": "1000"},
        headers={**supervisor, **_key()},
    ).json()
    applied = client.post(
        f"/api/v1/orders/{second_order}/rewards",
        json={"reward_id": reward["id"]},
        headers={**supervisor, **_key()},
    )
    assert applied.status_code == 201, applied.text
    resp = _merge(client, tables, tables["t1"], [tables["t2"]])
    assert resp.status_code == 409 and "ưu đãi" in resp.json()["detail"]
    assert _statuses(client, waiter)["T2"]["status"] == "OCCUPIED"


@pytest.mark.parametrize("secondary_status", ["BILLING", "CLEANING"])
def test_blocked_secondary_status(client, seed, tables, db_session_factory, secondary_status):
    waiter = tables["waiter"]
    _seat(client, seed, waiter, tables["t1"], 1)
    blocked = _add_table(db_session_factory, seed["outlet_id"], "T9", status=secondary_status)
    assert _merge(client, tables, tables["t1"], [blocked]).status_code == 409


def test_cannot_merge_into_free_or_already_merged_tables(client, seed, tables):
    waiter = tables["waiter"]
    assert _merge(client, tables, tables["t1"], [tables["t2"]]).status_code == 409  # T1 trống
    _seat(client, seed, waiter, tables["t1"], 1)
    _merge(client, tables, tables["t1"], [tables["t2"]])
    _seat(client, seed, waiter, tables["t3"], 1)
    # T2 đã gộp vào T1; T1 đang là bàn chính của nhóm khác.
    assert _merge(client, tables, tables["t3"], [tables["t2"]]).status_code == 409
    assert _merge(client, tables, tables["t3"], [tables["t1"]]).status_code == 409


def test_primary_with_merged_tables_cannot_be_transferred(client, seed, tables, db_session_factory):
    waiter = tables["waiter"]
    _seat(client, seed, waiter, tables["t1"], 1)
    _merge(client, tables, tables["t1"], [tables["t2"]])
    resp = client.post(
        f"/api/v1/tables/{tables['t1']}/transfer",
        json={"target_table_id": str(tables["t3"])},
        headers={**waiter, **_key()},
    )
    assert resp.status_code == 409


def test_validation_and_roles(client, seed, tables):
    waiter = tables["waiter"]
    _seat(client, seed, waiter, tables["t1"], 1)
    assert _merge(client, tables, tables["t1"], [tables["t1"]]).status_code == 422
    assert _merge(client, tables, tables["t1"], [tables["t2"], tables["t2"]]).status_code == 422
    empty = client.post(
        f"/api/v1/tables/{tables['t1']}/merge", json={"table_ids": []}, headers={**waiter, **_key()}
    )
    assert empty.status_code == 422
    assert _merge(client, tables, tables["t1"], [uuid.uuid4()]).status_code == 404
    cashier = login(client, "cashier_test")
    assert _merge(client, tables, tables["t1"], [tables["t2"]], headers=cashier).status_code == 403


def test_retry_and_audit(client, seed, tables, db_session_factory):
    waiter = tables["waiter"]
    _seat(client, seed, waiter, tables["t1"], 1)
    _seat(client, seed, waiter, tables["t2"], 1)
    first = _merge(client, tables, tables["t1"], [tables["t2"]], key="merge-1")
    again = _merge(client, tables, tables["t1"], [tables["t2"]], key="merge-1")
    assert first.status_code == again.status_code == 200
    assert again.json() == first.json()

    session = db_session_factory()
    actions = [log.action for log in session.query(AuditLog).all()]
    assert actions.count("TABLE_MERGED") == 1 and actions.count("ORDER_MERGED") == 1
    log = session.query(AuditLog).filter_by(action="TABLE_MERGED").one()
    assert '"merged_table_codes": ["T2"]' in log.payload
    session.close()
