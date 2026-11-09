"""Tách đơn: tách nguyên dòng và theo số lượng, tùy chọn món đi theo, trạng thái hai đơn,
mỗi hóa đơn thanh toán riêng và phiên chỉ đóng khi trả đơn cuối, các trường hợp bị chặn."""

from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from app.db.models import AuditLog, KitchenQueue, MenuItem, Order
from tests.conftest import login


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def ctx(client, seed, db_session_factory):
    """Bàn T1 có 1 đơn: dòng A (3 phần, đã gửi bếp), dòng B (2 phần, chưa gửi bếp)."""
    session = db_session_factory()
    second = MenuItem(
        outlet_id=seed["outlet_id"], station_id=seed["station_id"], name="Mon B", price="20000"
    )
    session.add(second)
    session.commit()
    second_id = second.id
    session.close()

    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 4},
        headers={**waiter, **_key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**waiter, **_key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 3}]},
        headers={**waiter, **_key()},
    )
    client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**waiter, **_key()})
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(second_id), "quantity": 2}]},
        headers={**waiter, **_key()},
    )
    items = client.get(f"/api/v1/orders/{order_id}", headers=waiter).json()["items"]
    sent = next(i for i in items if i["status"] == "SENT")
    created = next(i for i in items if i["status"] == "CREATED")
    return {
        "waiter": waiter,
        "cashier": login(client, "cashier_test"),
        "order_id": order_id,
        "sent": sent["id"],
        "created": created["id"],
    }


def _split(client, ctx, lines, key=None, headers=None, order_id=None):
    return client.post(
        f"/api/v1/orders/{order_id or ctx['order_id']}/split",
        json={"items": [{"order_item_id": i, "quantity": q} for i, q in lines]},
        headers={**(headers or ctx["waiter"]), "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _bill(client, ctx, order_id):
    return client.post(
        f"/api/v1/orders/{order_id}/request-billing", headers={**ctx["waiter"], **_key()}
    )


def _pay(client, ctx, order_id):
    return client.post(f"/api/v1/orders/{order_id}/pay", headers={**ctx["cashier"], **_key()})


def _table(client, ctx, seed):
    return client.get(f"/api/v1/tables/{seed['table_id']}", headers=ctx["waiter"]).json()


def test_split_whole_line_moves_kitchen_ticket(client, seed, ctx, db_session_factory):
    resp = _split(client, ctx, [(ctx["sent"], 3)])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    new_id = body["new_order"]["id"]
    assert [i["id"] for i in body["new_order"]["items"]] == [ctx["sent"]]
    assert body["new_order"]["status"] == "SENT"
    assert body["order"]["status"] == "NEW"  # còn mỗi món chưa gửi bếp
    assert Decimal(body["order"]["total"]) == Decimal("40000")
    assert Decimal(body["new_order"]["total"]) == Decimal("150000")

    queue = client.get("/api/v1/kitchen/queue", headers=login(client, "kitchen_test")).json()
    assert queue[0]["order_id"] == new_id and queue[0]["quantity"] == 3
    started = client.post(
        f"/api/v1/orders/{new_id}/items/{ctx['sent']}/start-cooking",
        headers={**login(client, "kitchen_test"), **_key()},
    )
    assert started.status_code == 200, started.text

    detail = _table(client, ctx, seed)
    assert {o["id"] for o in detail["orders"]} == {ctx["order_id"], new_id}


def test_split_part_of_unsent_line_with_modifiers(client, seed, ctx, db_session_factory):
    supervisor = login(client, "supervisor_test")
    group = client.post(
        f"/api/v1/menu/{seed['menu_item_id']}/modifiers",
        json={"name": "Size", "options": [{"name": "Lon", "price_delta": "5000"}]},
        headers={**supervisor, **_key()},
    ).json()
    added = client.post(
        f"/api/v1/orders/{ctx['order_id']}/items",
        json={
            "items": [
                {
                    "menu_item_id": str(seed["menu_item_id"]),
                    "quantity": 4,
                    "note": "it cay",
                    "modifier_option_ids": [group["options"][0]["id"]],
                }
            ]
        },
        headers={**ctx["waiter"], **_key()},
    ).json()
    line = added["items"][-1]["id"]

    body = _split(client, ctx, [(line, 1)]).json()
    new_line = body["new_order"]["items"][0]
    assert new_line["quantity"] == 1 and new_line["note"] == "it cay"
    assert Decimal(new_line["unit_price"]) == Decimal("55000")
    assert new_line["modifiers"][0]["option_name"] == "Lon"
    old_line = next(i for i in body["order"]["items"] if i["id"] == line)
    assert old_line["quantity"] == 3
    assert body["new_order"]["status"] == "NEW"


def test_cannot_split_part_of_line_in_kitchen(client, seed, ctx):
    resp = _split(client, ctx, [(ctx["sent"], 1)])
    assert resp.status_code == 409 and "nguyên dòng" in resp.json()["detail"]


def test_each_bill_paid_separately_and_session_closes_on_last(client, seed, ctx):
    new_id = _split(client, ctx, [(ctx["created"], 2)]).json()["new_order"]["id"]
    client.post(f"/api/v1/orders/{new_id}/send-to-kitchen", headers={**ctx["waiter"], **_key()})

    assert _bill(client, ctx, new_id).status_code == 200
    assert _table(client, ctx, seed)["status"] == "BILLING"
    assert _pay(client, ctx, new_id).status_code == 200

    table = _table(client, ctx, seed)
    assert table["status"] == "OCCUPIED"
    assert table["current_session"] is not None
    # Bàn trở lại có khách: gọi thêm món cho đơn còn lại được.
    more = client.post(
        f"/api/v1/orders/{ctx['order_id']}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
        headers={**ctx["waiter"], **_key()},
    )
    assert more.status_code == 201, more.text

    client.post(
        f"/api/v1/orders/{ctx['order_id']}/send-to-kitchen", headers={**ctx["waiter"], **_key()}
    )
    assert _bill(client, ctx, ctx["order_id"]).status_code == 200
    assert _pay(client, ctx, ctx["order_id"]).status_code == 200
    table = _table(client, ctx, seed)
    assert table["status"] == "CLEANING" and table["current_session"] is None


def test_table_stays_billing_when_other_bill_also_waiting(client, seed, ctx):
    new_id = _split(client, ctx, [(ctx["sent"], 3)]).json()["new_order"]["id"]
    client.post(
        f"/api/v1/orders/{ctx['order_id']}/send-to-kitchen", headers={**ctx["waiter"], **_key()}
    )
    assert _bill(client, ctx, new_id).status_code == 200
    assert _bill(client, ctx, ctx["order_id"]).status_code == 200
    assert _pay(client, ctx, new_id).status_code == 200
    assert _table(client, ctx, seed)["status"] == "BILLING"
    assert _pay(client, ctx, ctx["order_id"]).status_code == 200
    assert _table(client, ctx, seed)["status"] == "CLEANING"


def test_empty_open_order_does_not_hold_table(client, seed, ctx, db_session_factory):
    session_id = _table(client, ctx, seed)["current_session"]["id"]
    empty = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**ctx["waiter"], **_key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{ctx['order_id']}/send-to-kitchen", headers={**ctx["waiter"], **_key()}
    )
    _bill(client, ctx, ctx["order_id"])
    assert _pay(client, ctx, ctx["order_id"]).status_code == 200
    assert _table(client, ctx, seed)["status"] == "CLEANING"
    session = db_session_factory()
    assert session.get(Order, uuid.UUID(empty)).status == "CLOSED"
    session.close()


def test_must_leave_something_and_validation(client, seed, ctx):
    everything = _split(client, ctx, [(ctx["sent"], 3), (ctx["created"], 2)])
    assert everything.status_code == 422
    assert _split(client, ctx, [(ctx["created"], 3)]).status_code == 422  # quá số phần
    assert _split(client, ctx, [(ctx["created"], 1), (ctx["created"], 1)]).status_code == 422
    assert _split(client, ctx, [(str(uuid.uuid4()), 1)]).status_code == 404
    assert _split(client, ctx, [(ctx["created"], 0)]).status_code == 422
    empty = client.post(
        f"/api/v1/orders/{ctx['order_id']}/split",
        json={"items": []},
        headers={**ctx["waiter"], **_key()},
    )
    assert empty.status_code == 422


def test_voided_item_and_billing_and_reward_block(client, seed, ctx):
    client.delete(
        f"/api/v1/orders/{ctx['order_id']}/items/{ctx['created']}",
        headers={**ctx["waiter"], **_key()},
    )
    assert _split(client, ctx, [(ctx["created"], 2)]).status_code == 409

    supervisor = login(client, "supervisor_test")
    reward = client.post(
        "/api/v1/rewards",
        json={"name": "Giam", "reward_type": "FIXED", "value": "1000"},
        headers={**supervisor, **_key()},
    ).json()
    applied = client.post(
        f"/api/v1/orders/{ctx['order_id']}/rewards",
        json={"reward_id": reward["id"]},
        headers={**supervisor, **_key()},
    ).json()["applied_reward"]
    blocked = _split(client, ctx, [(ctx["sent"], 3)])
    assert blocked.status_code == 409 and "ưu đãi" in blocked.json()["detail"]
    client.delete(
        f"/api/v1/orders/{ctx['order_id']}/rewards/{applied['id']}",
        headers={**supervisor, **_key()},
    )

    _bill(client, ctx, ctx["order_id"])
    assert _split(client, ctx, [(ctx["sent"], 1)]).status_code == 409


def test_customer_stays_on_original_order(client, seed, ctx):
    customer = client.post(
        "/api/v1/customers",
        json={"phone": "0901234567", "consent": True},
        headers={**ctx["cashier"], **_key()},
    ).json()
    client.post(
        f"/api/v1/orders/{ctx['order_id']}/customer",
        json={"customer_id": customer["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    body = _split(client, ctx, [(ctx["created"], 1)]).json()
    assert body["order"]["customer_id"] == customer["id"]
    assert body["new_order"]["customer_id"] is None


def test_qr_items_go_to_original_bill(client, seed, ctx, db_session_factory):
    new_id = _split(client, ctx, [(ctx["created"], 1)]).json()["new_order"]["id"]
    # SQLite chỉ lưu tới giây: đẩy đơn tách ra sau để thứ tự cũ/mới rõ ràng như trên Postgres.
    session = db_session_factory()
    split_row = session.get(Order, uuid.UUID(new_id))
    split_row.created_at = split_row.created_at + timedelta(minutes=1)
    session.commit()
    session.close()
    token = client.post(
        f"/api/v1/tables/{seed['table_id']}/qr-session", headers={**ctx["waiter"], **_key()}
    ).json()["token"]
    client.post(
        f"/api/v1/public/qr/{token}/orders",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"])}]},
        headers=_key(),
    )
    original = client.get(f"/api/v1/orders/{ctx['order_id']}", headers=ctx["waiter"]).json()
    assert any(i["source"] == "QR" for i in original["items"])
    split = client.get(f"/api/v1/orders/{new_id}", headers=ctx["waiter"]).json()
    assert all(i["source"] == "POS" for i in split["items"])


def test_retry_roles_audit_versions(client, seed, ctx, db_session_factory):
    first = _split(client, ctx, [(ctx["created"], 1)], key="split-1")
    again = _split(client, ctx, [(ctx["created"], 1)], key="split-1")
    assert first.status_code == again.status_code == 201
    assert again.json()["new_order"]["id"] == first.json()["new_order"]["id"]
    assert _split(client, ctx, [(ctx["created"], 1)], headers=ctx["cashier"]).status_code == 403

    session = db_session_factory()
    log = session.query(AuditLog).filter_by(action="ORDER_SPLIT").one()
    assert first.json()["new_order"]["id"] in log.payload
    assert session.query(KitchenQueue).count() == 1
    session.close()
    supervisor = login(client, "supervisor_test")
    versions = client.get(
        f"/api/v1/orders/{first.json()['new_order']['id']}/versions", headers=supervisor
    ).json()
    assert versions[-1]["snapshot"]["items"][0]["quantity"] == 1
