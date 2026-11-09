"""scripts/loadtest_data.py (SDD R4): tạo dữ liệu outlet Load test, kiểm ghi trùng, dọn dữ liệu."""

from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest

from app.db.models import KitchenQueue, Outlet, Payment, RestaurantTable, Staff, TableSession
from tests.conftest import login

_SPEC = importlib.util.spec_from_file_location(
    "loadtest_data", Path(__file__).resolve().parent.parent / "scripts" / "loadtest_data.py"
)
loadtest_data = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(loadtest_data)

PASSWORD = "loadtest-pass-123"


@pytest.fixture()
def prepared(db_session_factory, monkeypatch):
    monkeypatch.setenv("LOADTEST_PASSWORD", PASSWORD)
    session = db_session_factory()
    loadtest_data.prepare(session, 3)
    loadtest_data.prepare(session, 3)  # chạy lại không tạo thêm
    session.close()


def test_prepare_is_idempotent_and_separate_outlet(db_session_factory, prepared):
    session = db_session_factory()
    outlet = session.query(Outlet).filter_by(name="Load test").one()
    codes = sorted(t.code for t in session.query(RestaurantTable).filter_by(outlet_id=outlet.id))
    assert codes == ["LT-001", "LT-002", "LT-003"]
    assert session.query(Staff).filter_by(outlet_id=outlet.id).count() == 4
    session.close()


def test_prepare_requires_password(db_session_factory, monkeypatch):
    monkeypatch.delenv("LOADTEST_PASSWORD", raising=False)
    session = db_session_factory()
    with pytest.raises(SystemExit):
        loadtest_data.prepare(session, 1)
    session.close()


def _one_cycle(client):
    waiter = login(client, "lt_waiter", PASSWORD)
    cashier = login(client, "lt_cashier", PASSWORD)

    def key():
        return {"Idempotency-Key": f"lt-{uuid.uuid4()}"}

    tables = {t["code"]: t["id"] for t in client.get("/api/v1/tables", headers=waiter).json()}
    menu = client.get("/api/v1/menu", headers=waiter).json()
    session_id = client.post(
        f"/api/v1/tables/{tables['LT-001']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, **key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**waiter, **key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": menu[0]["id"], "quantity": 2}]},
        headers={**waiter, **key()},
    )
    client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**waiter, **key()})
    client.post(f"/api/v1/orders/{order_id}/request-billing", headers={**waiter, **key()})
    resp = client.post(
        f"/api/v1/orders/{order_id}/payments", json={"method": "CASH"}, headers={**cashier, **key()}
    )
    assert resp.status_code == 201, resp.text
    return order_id


def test_verify_detects_duplicates_and_cleanup_removes_data(
    client, db_session_factory, prepared, capsys
):
    order_id = _one_cycle(client)
    session = db_session_factory()
    assert loadtest_data.verify(session) == 0

    # Ghi trùng giả: thêm 1 phiếu bếp nữa cho cùng món, 1 lần thu tiền nữa.
    entry = session.query(KitchenQueue).first()
    session.add(
        KitchenQueue(order_item_id=entry.order_item_id, station_id=entry.station_id, status="DONE")
    )
    outlet_id = session.query(Outlet).filter_by(name="Load test").one().id
    session.add(
        Payment(
            order_id=uuid.UUID(order_id),
            outlet_id=outlet_id,
            method="CASH",
            amount=1000,
            status="SUCCEEDED",
        )
    )
    session.commit()
    assert loadtest_data.verify(session) == 1
    output = capsys.readouterr().out
    assert "Món có hơn 1 phiếu bếp: 1" in output
    assert "Đơn thu tiền vượt tổng món: 1" in output

    loadtest_data.cleanup(session, really=False)
    assert session.query(TableSession).count() == 1
    loadtest_data.cleanup(session, really=True)
    assert session.query(TableSession).count() == 0
    assert session.query(Payment).count() == 0
    assert session.query(RestaurantTable).filter_by(outlet_id=outlet_id).count() == 3
    session.close()
