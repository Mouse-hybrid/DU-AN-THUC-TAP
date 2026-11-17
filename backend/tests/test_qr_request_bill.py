"""Khách yêu cầu thanh toán bằng QR (P2-QR-013): đúng phiên của mã QR chuyển BILLING, chặn gọi
thêm món, không đụng bàn khác, gọi lại không lỗi, chặn khi còn món chờ xác nhận."""

from __future__ import annotations

import json
import uuid

import pytest

from app.db.models import AuditLog, RestaurantTable
from tests.conftest import login
from tests.test_qr_ordering import _issue, _open_table, _submit


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def qr(client, seed):
    waiter = login(client, "waiter_test")
    _open_table(client, seed["table_id"], waiter)
    token = _issue(client, seed["table_id"], waiter)["token"]
    return {"token": token, "waiter": waiter}


def _order_id(client, seed, waiter):
    table = client.get(f"/api/v1/tables/{seed['table_id']}", headers=waiter).json()
    return table["orders"][0]["id"]


def _confirm_and_send(client, seed, qr):
    """Phục vụ xác nhận món khách gọi: gửi bếp (theo phiếu B6)."""
    order_id = _order_id(client, seed, qr["waiter"])
    resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**qr["waiter"], **_key()}
    )
    assert resp.status_code == 200, resp.text
    return order_id


def _request_bill(client, token, key=None):
    return client.post(
        f"/api/v1/public/qr/{token}/request-bill",
        headers={"Idempotency-Key": key or str(uuid.uuid4())},
    )


def test_request_bill_moves_session_to_billing(client, seed, qr, db_session_factory):
    _submit(client, qr["token"], seed, quantity=2)
    order_id = _confirm_and_send(client, seed, qr)

    resp = _request_bill(client, qr["token"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["quantity"] == 2

    table = client.get(f"/api/v1/tables/{seed['table_id']}", headers=qr["waiter"]).json()
    assert table["status"] == "BILLING"
    assert table["orders"][0]["status"] == "BILLING"

    # Đã yêu cầu thanh toán: khách không gọi thêm được.
    more = _submit(client, qr["token"], seed)
    assert more.status_code == 409

    session = db_session_factory()
    log = session.query(AuditLog).filter_by(action="ORDER_BILLING_REQUESTED").one()
    assert log.staff_id is None and log.entity_id == order_id
    assert json.loads(log.payload)["source"] == "QR"
    session.close()

    # Thu ngân thanh toán bình thường sau đó.
    paid = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH"},
        headers={**login(client, "cashier_test"), **_key()},
    )
    assert paid.status_code == 201 and paid.json()["order_status"] == "PAID"


def test_second_request_returns_current_bill(client, seed, qr, db_session_factory):
    _submit(client, qr["token"], seed)
    _confirm_and_send(client, seed, qr)
    first = _request_bill(client, qr["token"])
    again = _request_bill(client, qr["token"])
    assert first.status_code == again.status_code == 200
    assert again.json()["total"] == first.json()["total"]
    session = db_session_factory()
    assert session.query(AuditLog).filter_by(action="ORDER_BILLING_REQUESTED").count() == 1
    session.close()


def test_blocked_while_items_wait_for_staff(client, seed, qr):
    _submit(client, qr["token"], seed)
    _confirm_and_send(client, seed, qr)
    _submit(client, qr["token"], seed)  # món mới, phục vụ chưa xác nhận
    resp = _request_bill(client, qr["token"])
    assert resp.status_code == 409
    assert "chờ nhân viên xác nhận" in resp.json()["detail"]
    table = client.get(f"/api/v1/tables/{seed['table_id']}", headers=qr["waiter"]).json()
    assert table["status"] == "OCCUPIED"


def test_blocked_when_nothing_sent_to_kitchen(client, seed, qr):
    resp = _request_bill(client, qr["token"])
    assert resp.status_code == 409
    assert "chưa có món" in resp.json()["detail"]


def test_other_table_is_not_affected(client, seed, qr, db_session_factory):
    session = db_session_factory()
    other = RestaurantTable(outlet_id=seed["outlet_id"], code="T2", seats=4)
    session.add(other)
    session.commit()
    other_id = other.id
    session.close()
    _open_table(client, other_id, qr["waiter"])

    _submit(client, qr["token"], seed)
    _confirm_and_send(client, seed, qr)
    assert _request_bill(client, qr["token"]).status_code == 200
    statuses = {
        t["code"]: t["status"] for t in client.get("/api/v1/tables", headers=qr["waiter"]).json()
    }
    assert statuses == {"T1": "BILLING", "T2": "OCCUPIED"}


def test_invalid_token_and_idempotent_replay(client, seed, qr):
    assert _request_bill(client, "khong-co-ma-nay").status_code == 401
    _submit(client, qr["token"], seed)
    _confirm_and_send(client, seed, qr)
    first = _request_bill(client, qr["token"], key="bill-1")
    again = _request_bill(client, qr["token"], key="bill-1")
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
