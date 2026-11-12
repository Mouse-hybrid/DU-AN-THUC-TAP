"""Rewards đợt 3 (specs/002-rewards-dot-3): hoàn điểm khi hoàn tiền hết đơn, điểm hết hạn
theo thứ tự lô cũ trước, khách nhập số điện thoại trên QR."""

from __future__ import annotations

import importlib.util
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from app.core.loyalty import expire_points_for_customer, expiring_points
from app.db.models import (
    AuditLog,
    Customer,
    OrderReward,
    PointsLedger,
    Reward,
    TableSession,
)
from tests.conftest import login

RULE = {
    "earn_amount_per_point": "10000",
    "redeem_value_per_point": "100",
    "max_redeem_percent": 50,
    "points_expire_days": 365,
}


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def ctx(client, seed):
    ctx = {
        "supervisor": login(client, "supervisor_test"),
        "cashier": login(client, "cashier_test"),
        "waiter": login(client, "waiter_test"),
    }
    resp = client.post("/api/v1/loyalty-rules", json=RULE, headers={**ctx["supervisor"], **_key()})
    assert resp.status_code == 201, resp.text
    return ctx


def _open(client, seed, ctx):
    return client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**ctx["waiter"], **_key()},
    ).json()["id"]


def _order(client, seed, ctx, quantity=1, session_id=None):
    """Món 50.000đ × quantity, đã gửi bếp."""
    session_id = session_id or _open(client, seed, ctx)
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**ctx["waiter"], **_key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": quantity}]},
        headers={**ctx["waiter"], **_key()},
    )
    client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**ctx["waiter"], **_key()})
    return order_id


def _customer(client, ctx, phone="0901234567", points=0):
    customer = client.post(
        "/api/v1/customers",
        json={"phone": phone, "consent": True},
        headers={**ctx["cashier"], **_key()},
    ).json()
    if points:
        client.post(
            f"/api/v1/customers/{customer['id']}/points/adjust",
            json={"points": points, "reason": "test"},
            headers={**ctx["supervisor"], **_key()},
        )
    return customer


def _attach(client, ctx, order_id, customer_id):
    resp = client.post(
        f"/api/v1/orders/{order_id}/customer",
        json={"customer_id": customer_id},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 200, resp.text


def _bill_and_pay(client, ctx, order_id, **body):
    client.post(f"/api/v1/orders/{order_id}/request-billing", headers={**ctx["waiter"], **_key()})
    resp = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH", **body},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["payment"]["id"]


def _refund(client, ctx, payment_id, amount=None):
    body = {"reason": "Khách phàn nàn"}
    if amount is not None:
        body["amount"] = amount
    resp = client.post(
        f"/api/v1/payments/{payment_id}/refunds", json=body, headers={**ctx["supervisor"], **_key()}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _balance(client, ctx, customer):
    return client.get(f"/api/v1/customers/{customer['id']}", headers=ctx["cashier"]).json()[
        "points_balance"
    ]


def _ledger(db_session_factory, order_id, entry_type):
    session = db_session_factory()
    rows = (
        session.query(PointsLedger)
        .filter_by(order_id=uuid.UUID(order_id), entry_type=entry_type)
        .all()
    )
    session.close()
    return rows


# ---------------------------------------------------------------------------
# US1: hoàn điểm
# ---------------------------------------------------------------------------


def test_full_refund_returns_redeemed_and_takes_earned(client, seed, ctx, db_session_factory):
    customer = _customer(client, ctx, points=300)
    order_id = _order(client, seed, ctx)
    _attach(client, ctx, order_id, customer["id"])
    reward = client.post(
        "/api/v1/rewards",
        json={"name": "Doi diem", "reward_type": "POINTS"},
        headers={**ctx["supervisor"], **_key()},
    ).json()
    applied = client.post(
        f"/api/v1/orders/{order_id}/rewards",
        json={"reward_id": reward["id"], "points": 200},
        headers={**ctx["cashier"], **_key()},
    )
    assert applied.status_code == 201, applied.text
    payment_id = _bill_and_pay(client, ctx, order_id)
    assert _balance(client, ctx, customer) == 103  # 300 - 200 + 3 (30.000đ)

    _refund(client, ctx, payment_id, amount="10000")
    assert _balance(client, ctx, customer) == 103  # hoàn một phần: điểm không đổi
    assert _ledger(db_session_factory, order_id, "REVERSAL") == []

    _refund(client, ctx, payment_id)
    assert _balance(client, ctx, customer) == 300
    (reversal,) = _ledger(db_session_factory, order_id, "REVERSAL")
    assert reversal.points == 197
    assert "trả 200 điểm đổi, thu 3 điểm tích" in reversal.reason

    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert detail["applied_reward"]["status"] == "REVERSED"
    assert Decimal(detail["total"]) == Decimal("30000")  # hóa đơn cũ giữ số tiền đã giảm

    session = db_session_factory()
    assert session.get(Reward, uuid.UUID(reward["id"])).used_count == 0
    actions = [a.action for a in session.query(AuditLog).filter_by(entity_id=order_id)]
    assert "POINTS_REVERSED" in actions and "POINTS_REVERSAL_SHORTFALL" not in actions
    session.close()


def test_full_refund_takes_back_earned_points_only(client, seed, ctx, db_session_factory):
    customer = _customer(client, ctx)
    order_id = _order(client, seed, ctx)
    _attach(client, ctx, order_id, customer["id"])
    payment_id = _bill_and_pay(client, ctx, order_id)
    assert _balance(client, ctx, customer) == 5
    _refund(client, ctx, payment_id)
    assert _balance(client, ctx, customer) == 0
    assert [r.points for r in _ledger(db_session_factory, order_id, "REVERSAL")] == [-5]


def test_refund_without_customer_writes_no_points(client, seed, ctx, db_session_factory):
    order_id = _order(client, seed, ctx)
    payment_id = _bill_and_pay(client, ctx, order_id)
    _refund(client, ctx, payment_id)
    session = db_session_factory()
    assert session.query(PointsLedger).count() == 0
    session.close()


def test_shortfall_keeps_balance_non_negative(client, seed, ctx, db_session_factory):
    customer = _customer(client, ctx)
    order_id = _order(client, seed, ctx)
    _attach(client, ctx, order_id, customer["id"])
    payment_id = _bill_and_pay(client, ctx, order_id)
    # Khách đã dùng hết 5 điểm vừa tích (giả lập bằng điều chỉnh tay).
    client.post(
        f"/api/v1/customers/{customer['id']}/points/adjust",
        json={"points": -3, "reason": "test"},
        headers={**ctx["supervisor"], **_key()},
    )
    _refund(client, ctx, payment_id)
    assert _balance(client, ctx, customer) == 0
    assert [r.points for r in _ledger(db_session_factory, order_id, "REVERSAL")] == [-2]
    session = db_session_factory()
    shortfall = session.query(AuditLog).filter_by(action="POINTS_REVERSAL_SHORTFALL").one()
    assert '"points_not_taken": 3' in shortfall.payload
    session.close()


def test_reversal_happens_once_after_last_payment_refunded(client, seed, ctx, db_session_factory):
    customer = _customer(client, ctx)
    order_id = _order(client, seed, ctx, quantity=2)  # 100.000đ, tích 10 điểm
    _attach(client, ctx, order_id, customer["id"])
    first = _bill_and_pay(client, ctx, order_id, amount="40000")
    second = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CARD"},
        headers={**ctx["cashier"], **_key()},
    ).json()["payment"]["id"]
    assert _balance(client, ctx, customer) == 10
    _refund(client, ctx, first)
    assert _balance(client, ctx, customer) == 10
    _refund(client, ctx, second)
    assert _balance(client, ctx, customer) == 0
    assert len(_ledger(db_session_factory, order_id, "REVERSAL")) == 1


def test_full_refund_reverses_discount_reward_usage(client, seed, ctx, db_session_factory):
    order_id = _order(client, seed, ctx)
    reward = client.post(
        "/api/v1/rewards",
        json={"name": "Giam 10%", "reward_type": "PERCENT", "value": "10"},
        headers={**ctx["supervisor"], **_key()},
    ).json()
    client.post(
        f"/api/v1/orders/{order_id}/rewards",
        json={"reward_id": reward["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    payment_id = _bill_and_pay(client, ctx, order_id)
    session = db_session_factory()
    assert session.get(Reward, uuid.UUID(reward["id"])).used_count == 1
    session.close()
    _refund(client, ctx, payment_id)
    session = db_session_factory()
    assert session.get(Reward, uuid.UUID(reward["id"])).used_count == 0
    assert session.query(OrderReward).one().status == "REVERSED"
    session.close()


# ---------------------------------------------------------------------------
# US2: hết hạn điểm
# ---------------------------------------------------------------------------

NOW = datetime(2027, 1, 10, tzinfo=timezone.utc)


def _make_customer(db_session_factory, seed, rows):
    """rows: (ngày tạo, loại, điểm, hạn, order_key). Trả id khách."""
    session = db_session_factory()
    customer = Customer(
        outlet_id=seed["outlet_id"],
        phone=f"09{uuid.uuid4().int % 10**8:08d}",
        member_code=uuid.uuid4().hex[:8],
        points_balance=sum(r[2] for r in rows),
        consent_at=NOW,
    )
    session.add(customer)
    session.flush()
    balance = 0
    for created_at, entry_type, points, expires_at, _ in rows:
        balance += points
        session.add(
            PointsLedger(
                customer_id=customer.id,
                entry_type=entry_type,
                points=points,
                balance_after=balance,
                expires_at=expires_at,
                created_at=created_at,
            )
        )
    session.commit()
    customer_id = customer.id
    session.close()
    return customer_id


def _expire(db_session_factory, customer_id, now=NOW):
    session = db_session_factory()
    entry = expire_points_for_customer(session, customer_id, now)
    session.commit()
    balance = session.get(Customer, customer_id).points_balance
    session.close()
    return (-entry.points if entry else 0), balance


def _d(day):
    return datetime(2026, 1, day, tzinfo=timezone.utc)


def test_expires_only_expired_lot(db_session_factory, seed):
    cid = _make_customer(
        db_session_factory,
        seed,
        [
            (_d(1), "EARN", 50, NOW - timedelta(days=1), None),
            (_d(2), "EARN", 30, NOW + timedelta(days=30), None),
        ],
    )
    assert _expire(db_session_factory, cid) == (50, 30)
    assert _expire(db_session_factory, cid) == (0, 30)  # chạy lại không trừ thêm


def test_used_points_come_from_oldest_lot(db_session_factory, seed):
    cid = _make_customer(
        db_session_factory,
        seed,
        [
            (_d(1), "EARN", 50, NOW - timedelta(days=1), None),
            (_d(3), "REDEEM", -40, None, None),
        ],
    )
    assert _expire(db_session_factory, cid) == (10, 0)


def test_manual_adjust_is_consumed_first_when_older(db_session_factory, seed):
    cid = _make_customer(
        db_session_factory,
        seed,
        [
            (_d(1), "ADJUST", 100, None, None),
            (_d(2), "REDEEM", -50, None, None),
            (_d(3), "EARN", 50, NOW - timedelta(days=1), None),
        ],
    )
    # 50 điểm đã đổi lấy từ lô cộng tay (cũ hơn), nên lô 50 tích điểm hết hạn nguyên.
    assert _expire(db_session_factory, cid) == (50, 50)


def test_no_expiry_date_never_expires(db_session_factory, seed):
    cid = _make_customer(db_session_factory, seed, [(_d(1), "EARN", 50, None, None)])
    assert _expire(db_session_factory, cid) == (0, 50)


def test_expire_script_dry_run_then_real(db_session_factory, seed, capsys):
    spec = importlib.util.spec_from_file_location(
        "expire_points", Path(__file__).resolve().parent.parent / "scripts" / "expire_points.py"
    )
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    cid = _make_customer(
        db_session_factory, seed, [(_d(1), "EARN", 20, NOW - timedelta(days=1), None)]
    )
    session = db_session_factory()
    assert script.run(session, NOW, dry_run=True) == (1, 20)
    assert session.get(Customer, cid).points_balance == 20
    assert script.run(session, NOW, dry_run=False) == (1, 20)
    assert script.run(session, NOW, dry_run=False) == (0, 0)
    assert session.query(AuditLog).filter_by(action="POINTS_EXPIRED").count() == 1
    session.close()


def test_expiring_points_ignores_reversed_order_lot(client, seed, ctx, db_session_factory):
    customer = _customer(client, ctx)
    order_id = _order(client, seed, ctx)
    _attach(client, ctx, order_id, customer["id"])
    payment_id = _bill_and_pay(client, ctx, order_id)
    _refund(client, ctx, payment_id)
    session = db_session_factory()
    row = session.get(Customer, uuid.UUID(customer["id"]))
    assert expiring_points(session, row, datetime.now(timezone.utc) + timedelta(days=400)) == 0
    session.close()


# ---------------------------------------------------------------------------
# US3: số điện thoại trên QR
# ---------------------------------------------------------------------------


def _qr(client, seed, ctx):
    session_id = _open(client, seed, ctx)
    token = client.post(
        f"/api/v1/tables/{seed['table_id']}/qr-session", headers={**ctx["waiter"], **_key()}
    ).json()["token"]
    return session_id, token


def _member(client, token, phone):
    return client.post(
        f"/api/v1/public/qr/{token}/member", json={"phone": phone}, headers=_key()
    )


def test_member_phone_links_existing_customer(client, seed, ctx, db_session_factory):
    customer = _customer(client, ctx, phone="0901234567")
    session_id, token = _qr(client, seed, ctx)
    order_id = _order(client, seed, ctx, session_id=session_id)

    resp = _member(client, token, "090 123 4567")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "RECEIVED", "phone_masked": "090****567"}

    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert detail["customer_id"] == customer["id"]
    assert detail["has_pending_member"] is False

    _bill_and_pay(client, ctx, order_id)
    assert _balance(client, ctx, customer) == 5


def test_non_member_phone_is_kept_for_cashier(client, seed, ctx, db_session_factory):
    session_id, token = _qr(client, seed, ctx)
    order_id = _order(client, seed, ctx, session_id=session_id)
    resp = _member(client, token, "0912345678")
    assert resp.status_code == 200
    assert set(resp.json()) == {"status", "phone_masked"} and resp.json()["status"] == "RECEIVED"

    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert detail["customer_id"] is None and detail["has_pending_member"] is True
    pending = client.get(f"/api/v1/orders/{order_id}/pending-member", headers=ctx["cashier"]).json()
    assert pending == {"phone": "0912345678", "member_customer_id": None}
    assert (
        client.get(f"/api/v1/orders/{order_id}/pending-member", headers=ctx["waiter"]).status_code
        == 403
    )

    # Thu ngân xác nhận đồng ý, đăng ký rồi gắn: số chờ biến mất.
    customer = _customer(client, ctx, phone="0912345678")
    _attach(client, ctx, order_id, customer["id"])
    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert detail["has_pending_member"] is False


def test_existing_customer_on_order_is_not_replaced(client, seed, ctx):
    first = _customer(client, ctx, phone="0901111111")
    other = _customer(client, ctx, phone="0902222222")
    session_id, token = _qr(client, seed, ctx)
    order_id = _order(client, seed, ctx, session_id=session_id)
    _attach(client, ctx, order_id, first["id"])

    assert _member(client, token, "0902222222").status_code == 200
    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert detail["customer_id"] == first["id"]
    pending = client.get(f"/api/v1/orders/{order_id}/pending-member", headers=ctx["cashier"]).json()
    assert pending == {"phone": "0902222222", "member_customer_id": other["id"]}


def test_locked_customer_is_not_linked(client, seed, ctx, db_session_factory):
    customer = _customer(client, ctx, phone="0903333333")
    session = db_session_factory()
    session.get(Customer, uuid.UUID(customer["id"])).is_active = False
    session.commit()
    session.close()
    session_id, token = _qr(client, seed, ctx)
    order_id = _order(client, seed, ctx, session_id=session_id)
    assert _member(client, token, "0903333333").status_code == 200
    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert detail["customer_id"] is None and detail["has_pending_member"] is True


def test_attempt_limit_and_invalid_phone(client, seed, ctx):
    _, token = _qr(client, seed, ctx)
    assert _member(client, token, "123").status_code == 422  # không tính vào số lần
    for i in range(5):
        assert _member(client, token, f"090000000{i}").status_code == 200
    resp = _member(client, token, "0900000009")
    assert resp.status_code == 429
    assert "thu ngân" in resp.json()["detail"]


def test_invalid_token_and_idempotent_retry(client, seed, ctx, db_session_factory):
    assert _member(client, "khong-co-ma-nay", "0901234567").status_code == 401
    session_id, token = _qr(client, seed, ctx)
    key = {"Idempotency-Key": str(uuid.uuid4())}
    url = f"/api/v1/public/qr/{token}/member"
    first = client.post(url, json={"phone": "0904444444"}, headers=key)
    again = client.post(url, json={"phone": "0904444444"}, headers=key)
    assert first.json() == again.json()
    session = db_session_factory()
    assert session.get(TableSession, uuid.UUID(session_id)).qr_member_attempts == 1
    session.close()


def test_pending_phone_cleared_when_session_closes(client, seed, ctx, db_session_factory):
    session_id, token = _qr(client, seed, ctx)
    order_id = _order(client, seed, ctx, session_id=session_id)
    _member(client, token, "0905555555")
    _bill_and_pay(client, ctx, order_id)
    session = db_session_factory()
    assert session.get(TableSession, uuid.UUID(session_id)).pending_member_phone is None
    session.close()
