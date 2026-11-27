"""Chế độ gửi món QR theo cửa hàng: DIRECT (mặc định) vào bếp ngay, CONFIRM chờ phục vụ xác
nhận. Supervisor đổi ở PATCH /outlet/settings."""

from __future__ import annotations

import json
import uuid

from sqlalchemy import select

from app.db.models import AuditLog, KitchenQueue, OrderItem
from tests.conftest import login
from tests.test_qr_ordering import _submit, _table_order, qr  # noqa: F401  (fixture qr)


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _set_mode(client, headers, mode):
    return client.patch("/api/v1/outlet/settings", json={"qr_send_mode": mode}, headers=headers)


def test_default_direct_sends_customer_items_to_kitchen(client, seed, qr, db_session_factory):  # noqa: F811
    info = client.get(f"/api/v1/public/qr/{qr['token']}").json()
    assert info["send_mode"] == "DIRECT"

    resp = _submit(client, qr["token"], seed, quantity=2, note="Ít cay, không hành")
    assert resp.status_code == 201, resp.text
    line = resp.json()["items"][0]
    assert line["status"] == "SENT" and line["note"] == "Ít cay, không hành"

    order = _table_order(client, seed, qr["waiter"])
    assert order["status"] == "SENT"

    session = db_session_factory()
    item = session.scalars(select(OrderItem)).one()
    queue = session.scalars(select(KitchenQueue)).all()
    assert [q.order_item_id for q in queue] == [item.id]
    assert queue[0].station_id == seed["station_id"] and queue[0].status == "QUEUED"
    sent = session.scalars(
        select(AuditLog).where(AuditLog.action == "ORDER_SENT_TO_KITCHEN")
    ).one()
    assert sent.staff_id is None and json.loads(sent.payload)["source"] == "QR"
    session.close()

    # Đã có món vào bếp nên khách yêu cầu thanh toán được ngay.
    bill = client.post(f"/api/v1/public/qr/{qr['token']}/request-bill", headers=_key())
    assert bill.status_code == 200, bill.text


def test_direct_replay_with_same_key_does_not_send_twice(client, seed, qr, db_session_factory):  # noqa: F811
    first = _submit(client, qr["token"], seed, key="qr-direct-1")
    again = _submit(client, qr["token"], seed, key="qr-direct-1")
    assert first.status_code == again.status_code == 201
    assert first.json() == again.json()
    session = db_session_factory()
    assert len(session.scalars(select(KitchenQueue)).all()) == 1
    session.close()


def test_direct_does_not_send_staff_draft_items(client, seed, qr, db_session_factory):  # noqa: F811
    """Món nhân viên đang soạn (CREATED, chưa bấm gửi bếp) không bị món QR kéo theo vào bếp."""
    waiter = qr["waiter"]
    order_id = client.post(
        "/api/v1/orders",
        json={"table_session_id": qr["issued"]["table_session_id"]},
        headers={**waiter, **_key()},
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
        headers={**waiter, **_key()},
    )
    assert _submit(client, qr["token"], seed).status_code == 201

    session = db_session_factory()
    by_source = {i.source: i.status for i in session.scalars(select(OrderItem))}
    assert by_source == {"POS": "CREATED", "QR": "SENT"}
    session.close()


def test_supervisor_switches_to_confirm_mode(client, seed, qr, db_session_factory):  # noqa: F811
    supervisor = login(client, "supervisor_test")
    for role in ("cashier_test", "waiter_test"):
        headers = login(client, role)
        assert client.get("/api/v1/outlet/settings", headers=headers).status_code == 403
        assert _set_mode(client, headers, "CONFIRM").status_code == 403

    # Từ specs/003 response có thêm thuế/phí; ở đây chỉ kiểm chế độ gửi món.
    assert client.get("/api/v1/outlet/settings", headers=supervisor).json()["qr_send_mode"] == (
        "DIRECT"
    )
    assert _set_mode(client, supervisor, "LATER").status_code == 422
    changed = _set_mode(client, supervisor, "CONFIRM")
    assert changed.status_code == 200 and changed.json()["qr_send_mode"] == "CONFIRM"
    # Gửi lại cùng giá trị: không ghi thêm audit.
    assert _set_mode(client, supervisor, "CONFIRM").status_code == 200

    assert client.get(f"/api/v1/public/qr/{qr['token']}").json()["send_mode"] == "CONFIRM"
    resp = _submit(client, qr["token"], seed)
    assert resp.json()["items"][0]["status"] == "CREATED"

    session = db_session_factory()
    assert session.scalars(select(KitchenQueue)).all() == []
    audits = session.scalars(
        select(AuditLog).where(AuditLog.action == "OUTLET_SETTINGS_UPDATED")
    ).all()
    assert len(audits) == 1
    assert json.loads(audits[0].payload) == {
        "qr_send_mode": {"before": "DIRECT", "after": "CONFIRM"}
    }
    session.close()
