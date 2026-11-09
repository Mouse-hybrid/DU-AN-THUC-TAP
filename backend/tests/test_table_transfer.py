"""Chuyển bàn: phiên, đơn, phiếu bếp, ưu đãi, mã QR đi theo; trạng thái hai bàn; các trường
hợp bị chặn; idempotency; audit; cách ly outlet."""

from __future__ import annotations

import uuid

import pytest

from app.core.security import hash_password
from app.db.models import AuditLog, Outlet, RestaurantTable, Staff
from tests.conftest import SEED_PASSWORD, login


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


@pytest.fixture()
def busy(client, seed, db_session_factory):
    """Bàn T1 có khách, đơn đã gửi bếp 1 món; bàn T2 trống."""
    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 3},
        headers={**waiter, **_key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**waiter, **_key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 2}]},
        headers={**waiter, **_key()},
    )
    client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**waiter, **_key()})
    target = _add_table(db_session_factory, seed["outlet_id"], "T2")
    return {"waiter": waiter, "session_id": session_id, "order_id": order_id, "target": target}


def _transfer(client, seed, busy, target=None, headers=None, key=None, source=None):
    return client.post(
        f"/api/v1/tables/{source or seed['table_id']}/transfer",
        json={"target_table_id": str(target or busy["target"])},
        headers={**(headers or busy["waiter"]), "Idempotency-Key": key or str(uuid.uuid4())},
    )


def test_session_orders_and_kitchen_follow_to_new_table(client, seed, busy):
    resp = _transfer(client, seed, busy)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["table_session_id"] == busy["session_id"]
    assert body["from_table"]["status"] == "CLEANING"
    assert body["to_table"]["status"] == "OCCUPIED" and body["to_table"]["code"] == "T2"

    waiter = busy["waiter"]
    new_table = client.get(f"/api/v1/tables/{busy['target']}", headers=waiter).json()
    assert new_table["current_session"]["id"] == busy["session_id"]
    assert new_table["current_session"]["guest_count"] == 3
    assert [o["id"] for o in new_table["orders"]] == [busy["order_id"]]
    old_table = client.get(f"/api/v1/tables/{seed['table_id']}", headers=waiter).json()
    assert old_table["current_session"] is None and old_table["orders"] == []

    order = client.get(f"/api/v1/orders/{busy['order_id']}", headers=waiter).json()
    assert order["table_code"] == "T2"
    queue = client.get("/api/v1/kitchen/queue", headers=login(client, "kitchen_test")).json()
    assert {entry["table_code"] for entry in queue} == {"T2"}


def test_old_table_needs_cleaning_then_reopens(client, seed, busy):
    _transfer(client, seed, busy)
    waiter = busy["waiter"]
    reopen = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 1},
        headers={**waiter, **_key()},
    )
    assert reopen.status_code == 409
    cleaned = client.post(
        f"/api/v1/tables/{seed['table_id']}/mark-clean", headers={**waiter, **_key()}
    )
    assert cleaned.status_code == 200, cleaned.text


def test_order_flow_continues_and_pays_on_new_table(client, seed, busy):
    _transfer(client, seed, busy)
    waiter = busy["waiter"]
    order_id = busy["order_id"]
    added = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
        headers={**waiter, **_key()},
    )
    assert added.status_code == 201, added.text
    for step in ("send-to-kitchen", "request-billing"):
        resp = client.post(f"/api/v1/orders/{order_id}/{step}", headers={**waiter, **_key()})
        assert resp.status_code == 200, resp.text
    paid = client.post(
        f"/api/v1/orders/{order_id}/pay", headers={**login(client, "cashier_test"), **_key()}
    )
    assert paid.status_code == 200, paid.text
    statuses = {t["code"]: t["status"] for t in client.get("/api/v1/tables", headers=waiter).json()}
    assert statuses == {"T1": "CLEANING", "T2": "CLEANING"}


def test_qr_code_follows_session(client, seed, busy):
    token = client.post(
        f"/api/v1/tables/{seed['table_id']}/qr-session", headers={**busy["waiter"], **_key()}
    ).json()["token"]
    _transfer(client, seed, busy)
    assert client.get(f"/api/v1/public/qr/{token}").json()["table_code"] == "T2"


def test_reserved_target_is_allowed(client, seed, busy, db_session_factory):
    reserved = _add_table(db_session_factory, seed["outlet_id"], "T3", status="RESERVED")
    assert _transfer(client, seed, busy, target=reserved).status_code == 200


@pytest.mark.parametrize("target_status", ["OCCUPIED", "BILLING", "CLEANING"])
def test_target_must_be_free(client, seed, busy, db_session_factory, target_status):
    taken = _add_table(db_session_factory, seed["outlet_id"], "T3", status=target_status)
    resp = _transfer(client, seed, busy, target=taken)
    assert resp.status_code == 409
    statuses = {
        t["code"]: t["status"]
        for t in client.get("/api/v1/tables", headers=busy["waiter"]).json()
    }
    assert statuses["T1"] == "OCCUPIED"


def test_billing_table_cannot_move(client, seed, busy):
    billed = client.post(
        f"/api/v1/orders/{busy['order_id']}/request-billing",
        headers={**busy["waiter"], **_key()},
    )
    assert billed.status_code == 200, billed.text
    assert _transfer(client, seed, busy).status_code == 409


def test_empty_source_and_same_table_rejected(client, seed, busy, db_session_factory):
    empty = _add_table(db_session_factory, seed["outlet_id"], "T3")
    assert _transfer(client, seed, busy, source=empty).status_code == 409
    same = _transfer(client, seed, busy, target=seed["table_id"])
    assert same.status_code == 422
    unknown = _transfer(client, seed, busy, target=uuid.uuid4())
    assert unknown.status_code == 404


def test_retry_same_key_returns_same_result(client, seed, busy):
    first = _transfer(client, seed, busy, key="move-1")
    again = _transfer(client, seed, busy, key="move-1")
    assert first.status_code == again.status_code == 200
    assert again.json() == first.json()
    # Khác key: T1 đã thành CLEANING nên không chuyển lại được.
    assert _transfer(client, seed, busy).status_code == 409


def test_roles_and_audit(client, seed, busy, db_session_factory):
    cashier = login(client, "cashier_test")
    assert _transfer(client, seed, busy, headers=cashier).status_code == 403
    supervisor = login(client, "supervisor_test")
    assert _transfer(client, seed, busy, headers=supervisor).status_code == 200

    session = db_session_factory()
    log = session.query(AuditLog).filter_by(action="TABLE_TRANSFERRED").one()
    assert log.entity_id == busy["session_id"]
    assert '"from_table_code": "T1"' in log.payload and '"to_table_code": "T2"' in log.payload
    session.close()


def test_cannot_move_to_table_of_other_outlet(client, seed, busy, db_session_factory):
    session = db_session_factory()
    outlet = Outlet(name="Outlet Khac")
    session.add(outlet)
    session.flush()
    session.add(
        Staff(
            outlet_id=outlet.id,
            username="waiter_khac",
            password_hash=hash_password(SEED_PASSWORD),
            full_name="Waiter Khac",
            role="WAITER",
        )
    )
    session.commit()
    outlet_id = outlet.id
    session.close()
    foreign = _add_table(db_session_factory, outlet_id, "X1")

    assert _transfer(client, seed, busy, target=foreign).status_code == 404
    outsider = login(client, "waiter_khac")
    assert _transfer(client, seed, busy, headers=outsider).status_code == 404
