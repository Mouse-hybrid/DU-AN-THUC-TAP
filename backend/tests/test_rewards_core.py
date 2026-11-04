"""Rewards đợt 1: khách hàng, luật có phiên bản, gắn khách vào đơn, tích điểm đúng 1 lần
khi thanh toán, sổ điểm khớp số dư, dữ liệu cá nhân không lọt ra ngoài."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.core.loyalty import add_points, lock_customer
from app.core.security import hash_password
from app.db.models import AuditLog, Customer, Outlet, PointsLedger, Staff
from tests.conftest import SEED_PASSWORD, login

PHONE = "0901234567"
RULE = {
    "earn_amount_per_point": "10000",
    "redeem_value_per_point": "100",
    "max_redeem_percent": 50,
    "points_expire_days": 365,
}


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _create_customer(client, headers, phone=PHONE, key=None, **extra):
    return client.post(
        "/api/v1/customers",
        json={"phone": phone, "consent": True, **extra},
        headers={**headers, "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _create_rule(client, headers, **overrides):
    resp = client.post(
        "/api/v1/loyalty-rules", json={**RULE, **overrides}, headers={**headers, **_key()}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _billing_order(client, seed, quantity=1, voided_quantity=0):
    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, **_key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders",
        json={"table_session_id": session_id},
        headers={**waiter, **_key()},
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": quantity}]},
        headers={**waiter, **_key()},
    )
    if voided_quantity:
        added = client.post(
            f"/api/v1/orders/{order_id}/items",
            json={
                "items": [
                    {"menu_item_id": str(seed["menu_item_id"]), "quantity": voided_quantity}
                ]
            },
            headers={**waiter, **_key()},
        ).json()
        removed = client.delete(
            f"/api/v1/orders/{order_id}/items/{added['items'][-1]['id']}",
            headers={**waiter, **_key()},
        )
        assert removed.status_code == 200, removed.text
    for step in ("send-to-kitchen", "request-billing"):
        resp = client.post(f"/api/v1/orders/{order_id}/{step}", headers={**waiter, **_key()})
        assert resp.status_code == 200, resp.text
    return order_id


def _attach(client, order_id, customer_id, headers):
    return client.post(
        f"/api/v1/orders/{order_id}/customer",
        json={"customer_id": customer_id},
        headers={**headers, **_key()},
    )


def _pay(client, order_id, headers, key=None):
    return client.post(
        f"/api/v1/orders/{order_id}/pay",
        headers={**headers, "Idempotency-Key": key or str(uuid.uuid4())},
    )


@pytest.mark.parametrize(
    "raw", ["0901234567", "+84901234567", "84901234567", "090 123 4567", "090.123.4567"]
)
def test_phone_is_normalized(client, seed, raw):
    resp = _create_customer(client, login(client, "cashier_test"), phone=raw)
    assert resp.status_code == 201, resp.text
    assert resp.json()["phone"] == PHONE
    assert resp.json()["points_balance"] == 0
    assert resp.json()["member_code"].startswith("M")


@pytest.mark.parametrize("raw", ["123", "abc", "09012345678", "1901234567", ""])
def test_invalid_phone_rejected(client, seed, raw):
    assert _create_customer(client, login(client, "cashier_test"), phone=raw).status_code == 422


def test_create_requires_consent_and_rejects_duplicates(client, seed):
    cashier = login(client, "cashier_test")
    no_consent = client.post(
        "/api/v1/customers", json={"phone": PHONE}, headers={**cashier, **_key()}
    )
    assert no_consent.status_code == 422
    refused = client.post(
        "/api/v1/customers", json={"phone": PHONE, "consent": False}, headers={**cashier, **_key()}
    )
    assert refused.status_code == 422

    first = _create_customer(client, cashier, key="same")
    replay = _create_customer(client, cashier, key="same")
    assert replay.status_code == 201 and replay.json()["id"] == first.json()["id"]
    assert _create_customer(client, cashier, phone="+84901234567").status_code == 409


def test_cashier_looks_up_one_phone_but_cannot_list_everyone(client, seed):
    cashier = login(client, "cashier_test")
    customer = _create_customer(client, cashier, full_name="Khach A").json()

    found = client.get("/api/v1/customers", params={"phone": "+84901234567"}, headers=cashier)
    assert [c["id"] for c in found.json()] == [customer["id"]]
    none = client.get("/api/v1/customers?phone=0909999999", headers=cashier)
    assert none.status_code == 200 and none.json() == []
    assert client.get("/api/v1/customers?phone=abc", headers=cashier).status_code == 422
    assert client.get("/api/v1/customers", headers=cashier).status_code == 403

    supervisor = login(client, "supervisor_test")
    assert len(client.get("/api/v1/customers", headers=supervisor).json()) == 1
    assert client.get(f"/api/v1/customers/{customer['id']}", headers=cashier).status_code == 200


def test_waiter_and_kitchen_cannot_read_customer_data(client, seed):
    customer = _create_customer(client, login(client, "cashier_test")).json()
    for username in ("waiter_test", "kitchen_test"):
        headers = login(client, username)
        url = f"/api/v1/customers/{customer['id']}"
        assert client.get(url, headers=headers).status_code == 403
        assert client.get(f"{url}/points", headers=headers).status_code == 403
        assert client.get(f"/api/v1/customers?phone={PHONE}", headers=headers).status_code == 403


def test_customers_stay_inside_outlet(client, seed, db_session_factory):
    customer = _create_customer(client, login(client, "cashier_test")).json()
    session = db_session_factory()
    outlet = Outlet(name="Outlet Khac")
    session.add(outlet)
    session.flush()
    session.add(
        Staff(
            outlet_id=outlet.id,
            username="sup_khac",
            password_hash=hash_password(SEED_PASSWORD),
            full_name="Sup Khac",
            role="SUPERVISOR",
        )
    )
    session.commit()
    session.close()

    outsider = login(client, "sup_khac")
    assert client.get(f"/api/v1/customers/{customer['id']}", headers=outsider).status_code == 404
    assert client.get("/api/v1/customers", headers=outsider).json() == []
    # Số này chưa có ở outlet kia, nên tạo được bản riêng.
    assert _create_customer(client, outsider).status_code == 201


def test_rule_versions_and_validation(client, seed):
    supervisor = login(client, "supervisor_test")
    assert _create_rule(client, supervisor)["version"] == 1
    second = _create_rule(client, supervisor, earn_amount_per_point="5000")
    assert second["version"] == 2
    rules = client.get("/api/v1/loyalty-rules", headers=supervisor).json()
    assert [r["version"] for r in rules] == [2, 1]
    assert Decimal(rules[1]["earn_amount_per_point"]) == Decimal("10000")

    for bad in (
        {"earn_amount_per_point": "0"},
        {"redeem_value_per_point": "-1"},
        {"max_redeem_percent": 101},
        {"max_redeem_percent": 0},
        {"points_expire_days": 0},
    ):
        resp = client.post(
            "/api/v1/loyalty-rules", json={**RULE, **bad}, headers={**supervisor, **_key()}
        )
        assert resp.status_code == 422, bad


def test_payment_earns_points_once_and_records_ledger(client, seed):
    supervisor = login(client, "supervisor_test")
    cashier = login(client, "cashier_test")
    _create_rule(client, supervisor)
    customer = _create_customer(client, cashier).json()
    order_id = _billing_order(client, seed, quantity=3)  # 150.000đ

    attached = _attach(client, order_id, customer["id"], cashier)
    assert attached.status_code == 200, attached.text
    assert attached.json()["customer_id"] == customer["id"]

    assert _pay(client, order_id, cashier, key="pay-1").status_code == 200
    assert _pay(client, order_id, cashier, key="pay-1").status_code == 200  # retry
    assert _pay(client, order_id, cashier).status_code == 409  # key khác, đơn đã PAID

    url = f"/api/v1/customers/{customer['id']}"
    assert client.get(url, headers=cashier).json()["points_balance"] == 15
    entries = client.get(f"{url}/points", headers=cashier).json()
    assert len(entries) == 1
    entry = entries[0]
    assert entry["entry_type"] == "EARN" and entry["points"] == 15
    assert entry["balance_after"] == 15 and entry["order_id"] == order_id
    assert entry["rule_version"] == 1 and entry["expires_at"]


def test_earn_rounds_down_and_ignores_voided_items(client, seed):
    supervisor = login(client, "supervisor_test")
    cashier = login(client, "cashier_test")
    _create_rule(client, supervisor, earn_amount_per_point="30000")
    customer = _create_customer(client, cashier).json()
    # 50.000đ / 30.000 = 1 điểm; dòng 10 phần đã bỏ không được tính.
    order_id = _billing_order(client, seed, quantity=1, voided_quantity=10)
    _attach(client, order_id, customer["id"], cashier)
    _pay(client, order_id, cashier)
    url = f"/api/v1/customers/{customer['id']}"
    assert client.get(url, headers=cashier).json()["points_balance"] == 1


def test_uses_latest_rule_at_payment(client, seed):
    supervisor = login(client, "supervisor_test")
    cashier = login(client, "cashier_test")
    _create_rule(client, supervisor)
    customer = _create_customer(client, cashier).json()
    order_id = _billing_order(client, seed)
    _attach(client, order_id, customer["id"], cashier)
    _create_rule(client, supervisor, earn_amount_per_point="1000")
    _pay(client, order_id, cashier)

    entry = client.get(f"/api/v1/customers/{customer['id']}/points", headers=cashier).json()[0]
    assert entry["points"] == 50 and entry["rule_version"] == 2


@pytest.mark.parametrize("case", ["no_customer", "no_rule", "too_small", "locked"])
def test_payment_succeeds_without_earning(client, seed, db_session_factory, case):
    supervisor = login(client, "supervisor_test")
    cashier = login(client, "cashier_test")
    if case != "no_rule":
        earn = "9999999" if case == "too_small" else "10000"
        _create_rule(client, supervisor, earn_amount_per_point=earn)
    customer = _create_customer(client, cashier).json()
    order_id = _billing_order(client, seed)
    if case != "no_customer":
        _attach(client, order_id, customer["id"], cashier)
    if case == "locked":
        client.patch(
            f"/api/v1/customers/{customer['id']}", json={"is_active": False}, headers=supervisor
        )

    assert _pay(client, order_id, cashier).status_code == 200
    session = db_session_factory()
    assert session.query(PointsLedger).count() == 0
    session.close()


def test_attach_rules(client, seed):
    supervisor = login(client, "supervisor_test")
    cashier = login(client, "cashier_test")
    customer = _create_customer(client, cashier).json()
    order_id = _billing_order(client, seed)

    assert _attach(client, order_id, str(uuid.uuid4()), cashier).status_code == 404
    client.patch(
        f"/api/v1/customers/{customer['id']}", json={"is_active": False}, headers=supervisor
    )
    assert _attach(client, order_id, customer["id"], cashier).status_code == 409
    client.patch(
        f"/api/v1/customers/{customer['id']}", json={"is_active": True}, headers=supervisor
    )
    assert _attach(client, order_id, customer["id"], cashier).status_code == 200
    removed = _attach(client, order_id, None, cashier)
    assert removed.status_code == 200 and removed.json()["customer_id"] is None

    _pay(client, order_id, cashier)
    assert _attach(client, order_id, customer["id"], cashier).status_code == 409


def test_adjust_points_needs_reason_and_cannot_go_negative(client, seed, db_session_factory):
    supervisor = login(client, "supervisor_test")
    customer = _create_customer(client, supervisor).json()
    url = f"/api/v1/customers/{customer['id']}/points/adjust"

    def adjust(body, key=None):
        return client.post(
            url, json=body, headers={**supervisor, "Idempotency-Key": key or str(uuid.uuid4())}
        )

    assert adjust({"points": 10}).status_code == 422
    assert adjust({"points": 0, "reason": "x"}).status_code == 422
    assert adjust({"points": -1, "reason": "trừ nhầm"}).status_code == 409

    first = adjust({"points": 10, "reason": "bù điểm"}, key="adj-1")
    again = adjust({"points": 10, "reason": "bù điểm"}, key="adj-1")
    assert first.status_code == again.status_code == 201
    assert again.json()["id"] == first.json()["id"]
    assert first.json()["balance_after"] == 10
    assert adjust({"points": -4, "reason": "sửa"}).json()["balance_after"] == 6

    session = db_session_factory()
    row = session.get(Customer, uuid.UUID(customer["id"]))
    entries = session.query(PointsLedger).filter_by(customer_id=row.id).all()
    assert row.points_balance == 6 == sum(entry.points for entry in entries)
    session.close()


def test_ledger_helper_keeps_balance_in_step(client, seed, db_session_factory):
    customer = _create_customer(client, login(client, "cashier_test")).json()
    session = db_session_factory()
    row = lock_customer(session, uuid.UUID(customer["id"]))
    entry = add_points(session, row, entry_type="ADJUST", points=7, reason="test")
    assert row.points_balance == 7 and entry.balance_after == 7
    session.rollback()
    session.close()


def test_audit_does_not_contain_phone(client, seed, db_session_factory):
    supervisor = login(client, "supervisor_test")
    customer = _create_customer(client, supervisor, full_name="Khach A").json()
    client.patch(
        f"/api/v1/customers/{customer['id']}", json={"full_name": "Khach B"}, headers=supervisor
    )
    session = db_session_factory()
    logs = session.query(AuditLog).filter(AuditLog.entity_type == "customer").all()
    assert {log.action for log in logs} == {"CUSTOMER_CREATED", "CUSTOMER_UPDATED"}
    assert all(PHONE not in (log.payload or "") for log in logs)
    assert all("Khach" not in (log.payload or "") for log in logs)
    session.close()


def test_update_customer_validation(client, seed):
    supervisor = login(client, "supervisor_test")
    customer = _create_customer(client, supervisor).json()
    url = f"/api/v1/customers/{customer['id']}"
    assert client.patch(url, json={}, headers=supervisor).status_code == 422
    assert client.patch(url, json={"is_active": None}, headers=supervisor).status_code == 422
    assert client.patch(url, json={"full_name": None}, headers=supervisor).status_code == 200
