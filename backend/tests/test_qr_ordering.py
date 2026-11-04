"""QR Ordering: cấp/thu hồi mã, API công khai không đăng nhập, món của khách chờ phục vụ
xác nhận, dùng chung đơn với POS, chặn khi BILLING, retry, hết hạn, cách ly giữa các bàn."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.db.models import AuditLog, KitchenQueue, MenuItem, RestaurantTable, TableSession
from tests.conftest import login


def _open_table(client, table_id, headers):
    resp = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _issue(client, table_id, headers):
    resp = client.post(
        f"/api/v1/tables/{table_id}/qr-session",
        headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _submit(client, token, seed, key=None, quantity=1, note=None):
    return client.post(
        f"/api/v1/public/qr/{token}/orders",
        json={
            "items": [
                {"menu_item_id": str(seed["menu_item_id"]), "quantity": quantity, "note": note}
            ]
        },
        headers={"Idempotency-Key": key or str(uuid.uuid4())},
    )


def _table_order(client, seed, headers):
    table = client.get(f"/api/v1/tables/{seed['table_id']}", headers=headers).json()
    return table["orders"][0]


@pytest.fixture()
def qr(client, seed):
    waiter = login(client, "waiter_test")
    _open_table(client, seed["table_id"], waiter)
    issued = _issue(client, seed["table_id"], waiter)
    return {"token": issued["token"], "waiter": waiter, "issued": issued}


def test_issue_requires_open_session_and_returns_path(client, seed):
    waiter = login(client, "waiter_test")
    resp = client.post(
        f"/api/v1/tables/{seed['table_id']}/qr-session",
        headers={**waiter, "Idempotency-Key": "no-session"},
    )
    assert resp.status_code == 409

    _open_table(client, seed["table_id"], waiter)
    issued = _issue(client, seed["table_id"], waiter)
    assert issued["path"] == f"/qr/{issued['token']}"
    assert len(issued["token"]) >= 32
    again = client.get(f"/api/v1/tables/{seed['table_id']}/qr-session", headers=waiter)
    assert again.json()["token"] == issued["token"]


def test_public_info_and_menu_need_no_login_and_hide_internal_fields(client, seed, qr):
    info = client.get(f"/api/v1/public/qr/{qr['token']}")
    assert info.status_code == 200, info.text
    assert info.json()["table_code"] == "T1"
    assert info.json()["ordering_locked"] is False

    menu = client.get(f"/api/v1/public/qr/{qr['token']}/menu")
    assert menu.status_code == 200
    item = menu.json()["items"][0]
    assert item["name"] == "Mon Test"
    assert "station_id" not in item and "outlet_id" not in menu.text


def test_menu_hides_items_without_station_and_marks_sold_out(
    client, seed, qr, db_session_factory
):
    session = db_session_factory()
    session.add(
        MenuItem(outlet_id=seed["outlet_id"], station_id=None, name="Chua Gan Tram", price=1000)
    )
    session.get(MenuItem, seed["menu_item_id"]).is_available = False
    session.commit()
    session.close()

    items = client.get(f"/api/v1/public/qr/{qr['token']}/menu").json()["items"]
    assert [i["name"] for i in items] == ["Mon Test"]
    assert items[0]["is_available"] is False
    resp = _submit(client, qr["token"], seed)
    assert resp.status_code == 409


def test_customer_items_wait_until_staff_sends_to_kitchen(client, seed, qr, db_session_factory):
    resp = _submit(client, qr["token"], seed, quantity=2, note="không hành")
    assert resp.status_code == 201, resp.text
    item = resp.json()["items"][0]
    assert item["status"] == "CREATED" and item["source"] == "QR"
    assert item["note"] == "không hành"
    assert float(resp.json()["subtotal"]) == 100000

    session = db_session_factory()
    assert session.query(KitchenQueue).count() == 0
    session.close()

    table = client.get(f"/api/v1/tables/{seed['table_id']}", headers=qr["waiter"]).json()
    order = table["orders"][0]
    assert order["items"][0]["source"] == "QR"
    sent = client.post(
        f"/api/v1/orders/{order['id']}/send-to-kitchen",
        headers={**qr["waiter"], "Idempotency-Key": str(uuid.uuid4())},
    )
    assert sent.status_code == 200, sent.text

    tracked = client.get(f"/api/v1/public/qr/{qr['token']}/order").json()
    assert tracked["items"][0]["status"] == "SENT"
    session = db_session_factory()
    assert session.query(KitchenQueue).count() == 1
    session.close()


def test_staff_rejects_customer_item_before_sending(client, seed, qr):
    _submit(client, qr["token"], seed)
    order = _table_order(client, seed, qr["waiter"])
    removed = client.delete(
        f"/api/v1/orders/{order['id']}/items/{order['items'][0]['id']}",
        headers={**qr["waiter"], "Idempotency-Key": str(uuid.uuid4())},
    )
    assert removed.status_code == 200, removed.text
    tracked = client.get(f"/api/v1/public/qr/{qr['token']}/order").json()
    assert tracked["items"][0]["status"] == "VOIDED"
    assert float(tracked["subtotal"]) == 0


def test_two_guests_and_pos_share_one_order(client, seed, qr):
    pos_order = client.post(
        "/api/v1/orders",
        json={"table_session_id": qr["issued"]["table_session_id"]},
        headers={**qr["waiter"], "Idempotency-Key": str(uuid.uuid4())},
    ).json()
    _submit(client, qr["token"], seed)
    _submit(client, qr["token"], seed)

    table = client.get(f"/api/v1/tables/{seed['table_id']}", headers=qr["waiter"]).json()
    assert [o["id"] for o in table["orders"]] == [pos_order["id"]]
    assert len(table["orders"][0]["items"]) == 2


def test_retry_same_key_does_not_duplicate_and_other_body_conflicts(client, seed, qr):
    first = _submit(client, qr["token"], seed, key="retry-1")
    again = _submit(client, qr["token"], seed, key="retry-1")
    assert again.status_code == 201
    assert again.json() == first.json()
    tracked = client.get(f"/api/v1/public/qr/{qr['token']}/order").json()
    assert len(tracked["items"]) == 1

    other_body = _submit(client, qr["token"], seed, key="retry-1", quantity=3)
    assert other_body.status_code == 409
    no_key = client.post(
        f"/api/v1/public/qr/{qr['token']}/orders",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"])}]},
    )
    assert no_key.status_code == 400


def test_billing_locks_ordering(client, seed, qr):
    _submit(client, qr["token"], seed)
    order = _table_order(client, seed, qr["waiter"])
    key = {"Idempotency-Key": str(uuid.uuid4())}
    client.post(f"/api/v1/orders/{order['id']}/send-to-kitchen", headers={**qr["waiter"], **key})
    billed = client.post(
        f"/api/v1/orders/{order['id']}/request-billing",
        headers={**qr["waiter"], "Idempotency-Key": str(uuid.uuid4())},
    )
    assert billed.status_code == 200, billed.text

    assert client.get(f"/api/v1/public/qr/{qr['token']}").json()["ordering_locked"] is True
    assert _submit(client, qr["token"], seed).status_code == 409
    assert client.get(f"/api/v1/public/qr/{qr['token']}/order").status_code == 200


def test_pending_limit_blocks_spam_until_staff_confirms(client, seed, qr):
    for _ in range(3):
        assert _submit(client, qr["token"], seed, quantity=10).status_code == 201
    assert _submit(client, qr["token"], seed).status_code == 409

    order = _table_order(client, seed, qr["waiter"])
    client.post(
        f"/api/v1/orders/{order['id']}/send-to-kitchen",
        headers={**qr["waiter"], "Idempotency-Key": str(uuid.uuid4())},
    )
    assert _submit(client, qr["token"], seed).status_code == 201


@pytest.mark.parametrize(
    "overrides",
    [
        {"items": []},
        {"items": [{"menu_item_id": "khong-phai-uuid"}]},
        {"items": [{"menu_item_id": str(uuid.uuid4()), "quantity": 0}]},
        {"items": [{"menu_item_id": str(uuid.uuid4()), "quantity": 21}]},
        {"items": [{"menu_item_id": str(uuid.uuid4()), "note": "x" * 201}]},
    ],
)
def test_submit_validation(client, seed, qr, overrides):
    resp = client.post(
        f"/api/v1/public/qr/{qr['token']}/orders",
        json=overrides,
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 422


def test_unknown_item_rejected(client, seed, qr):
    resp = client.post(
        f"/api/v1/public/qr/{qr['token']}/orders",
        json={"items": [{"menu_item_id": str(uuid.uuid4())}]},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 404


def test_token_invalid_revoked_rotated_expired_closed(client, seed, qr, db_session_factory):
    assert client.get("/api/v1/public/qr/gia-mao").status_code == 401

    # Cấp lại: mã cũ hết dùng.
    rotated = _issue(client, seed["table_id"], qr["waiter"])
    assert client.get(f"/api/v1/public/qr/{qr['token']}").status_code == 401
    assert client.get(f"/api/v1/public/qr/{rotated['token']}").status_code == 200

    # Hết hạn: 410, phân biệt với mã sai để giao diện hiện màn 54.
    session = db_session_factory()
    row = session.query(TableSession).filter_by(qr_session_token=rotated["token"]).one()
    row.qr_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    session.commit()
    session.close()
    assert client.get(f"/api/v1/public/qr/{rotated['token']}").status_code == 410
    assert _submit(client, rotated["token"], seed).status_code == 410
    missing = client.get(f"/api/v1/tables/{seed['table_id']}/qr-session", headers=qr["waiter"])
    assert missing.status_code == 404

    # Thu hồi.
    fresh = _issue(client, seed["table_id"], qr["waiter"])
    revoked = client.delete(f"/api/v1/tables/{seed['table_id']}/qr-session", headers=qr["waiter"])
    assert revoked.status_code == 204
    assert client.get(f"/api/v1/public/qr/{fresh['token']}").status_code == 401

    # Phiên đóng sau khi thanh toán: mã đang còn hạn cũng hết dùng.
    last = _issue(client, seed["table_id"], qr["waiter"])
    assert _submit(client, last["token"], seed).status_code == 201
    order = _table_order(client, seed, qr["waiter"])
    for path in ("send-to-kitchen", "request-billing"):
        client.post(
            f"/api/v1/orders/{order['id']}/{path}",
            headers={**qr["waiter"], "Idempotency-Key": str(uuid.uuid4())},
        )
    paid = client.post(
        f"/api/v1/orders/{order['id']}/pay",
        headers={**login(client, "cashier_test"), "Idempotency-Key": str(uuid.uuid4())},
    )
    assert paid.status_code == 200, paid.text
    assert client.get(f"/api/v1/public/qr/{last['token']}").status_code == 410


def test_token_only_reaches_its_own_table(client, seed, qr, db_session_factory):
    session = db_session_factory()
    other = RestaurantTable(outlet_id=seed["outlet_id"], code="T2", seats=2, status="AVAILABLE")
    session.add(other)
    session.commit()
    other_id = other.id
    session.close()
    _open_table(client, other_id, qr["waiter"])
    other_token = _issue(client, other_id, qr["waiter"])["token"]

    _submit(client, qr["token"], seed)
    assert client.get(f"/api/v1/public/qr/{other_token}/order").json()["items"] == []
    assert client.get(f"/api/v1/public/qr/{other_token}").json()["table_code"] == "T2"


def test_staff_only_manages_own_outlet_and_token_stays_out_of_audit(
    client, seed, qr, db_session_factory
):
    session = db_session_factory()
    logs = session.query(AuditLog).filter_by(action="QR_SESSION_ISSUED").all()
    assert logs and all(qr["token"] not in (log.payload or "") for log in logs)
    session.close()

    kitchen = login(client, "kitchen_test")
    url = f"/api/v1/tables/{seed['table_id']}/qr-session"
    assert client.get(url, headers=kitchen).status_code == 403
    unknown = client.get(f"/api/v1/tables/{uuid.uuid4()}/qr-session", headers=qr["waiter"])
    assert unknown.status_code == 404


def test_qr_activity_is_audited_without_staff(client, seed, qr, db_session_factory):
    _submit(client, qr["token"], seed)
    session = db_session_factory()
    added = session.query(AuditLog).filter_by(action="ORDER_ITEMS_ADDED").one()
    assert added.staff_id is None and '"source": "QR"' in added.payload
    session.close()
