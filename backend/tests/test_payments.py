"""Thanh toán v2 (SDD R1): trả nhiều lần, nhiều hình thức, tiền thối, không trả vượt, hủy lần
ghi nhầm, hoàn tiền, đơn có ưu đãi và tích điểm, tương thích /pay."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.db.models import AuditLog, Payment, RestaurantTable, TableSession
from tests.conftest import login

RULE = {
    "earn_amount_per_point": "10000",
    "redeem_value_per_point": "100",
    "max_redeem_percent": 50,
}


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def ctx(client, seed):
    return {
        "supervisor": login(client, "supervisor_test"),
        "cashier": login(client, "cashier_test"),
        "waiter": login(client, "waiter_test"),
    }


def _billing_order(client, seed, ctx, quantity=4, bill=True):
    """Món 50.000đ, mặc định 4 phần = 200.000đ, đã gửi bếp và (mặc định) đã yêu cầu thanh toán."""
    waiter = ctx["waiter"]
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, **_key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**waiter, **_key()}
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": quantity}]},
        headers={**waiter, **_key()},
    )
    client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**waiter, **_key()})
    if bill:
        _bill(client, ctx, order_id)
    return order_id


def _bill(client, ctx, order_id):
    resp = client.post(
        f"/api/v1/orders/{order_id}/request-billing", headers={**ctx["waiter"], **_key()}
    )
    assert resp.status_code == 200, resp.text


def _pay(client, ctx, order_id, role="cashier", key=None, **body):
    return client.post(
        f"/api/v1/orders/{order_id}/payments",
        json=body,
        headers={**ctx[role], "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _list(client, ctx, order_id):
    resp = client.get(f"/api/v1/orders/{order_id}/payments", headers=ctx["cashier"])
    assert resp.status_code == 200, resp.text
    return resp.json()


def _money(value):
    return Decimal(str(value))


def test_split_payment_cash_then_card_closes_order(client, seed, ctx, db_session_factory):
    order_id = _billing_order(client, seed, ctx)

    first = _pay(client, ctx, order_id, method="CASH", amount="80000", cash_received="100000")
    assert first.status_code == 201, first.text
    body = first.json()
    assert body["order_status"] == "BILLING"
    assert _money(body["payment"]["change_due"]) == Decimal("20000")
    assert _money(body["summary"]["paid"]) == Decimal("80000")
    assert _money(body["summary"]["remaining"]) == Decimal("120000")

    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert _money(detail["amount_paid"]) == Decimal("80000")
    assert _money(detail["amount_due"]) == Decimal("120000")

    second = _pay(client, ctx, order_id, method="CARD", provider_ref="POS-0001")
    assert second.status_code == 201, second.text
    body = second.json()
    assert body["order_status"] == "PAID"
    assert _money(body["payment"]["amount"]) == Decimal("120000")
    assert body["payment"]["cash_received"] is None
    assert _money(body["summary"]["remaining"]) == 0

    listed = _list(client, ctx, order_id)
    assert [p["method"] for p in listed["payments"]] == ["CASH", "CARD"]

    session = db_session_factory()
    table = session.get(RestaurantTable, seed["table_id"])
    assert table.status == "CLEANING"
    assert session.query(TableSession).one().status == "CLOSED"
    actions = [row.action for row in session.query(AuditLog).order_by(AuditLog.created_at)]
    assert actions.count("PAYMENT_RECORDED") == 2
    assert "ORDER_PAID" in actions
    session.close()


def test_payment_cannot_exceed_remaining(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
    resp = _pay(client, ctx, order_id, method="CARD", amount="200001")
    assert resp.status_code == 409
    assert "vượt quá" in resp.json()["detail"]

    assert _pay(client, ctx, order_id, method="CASH", amount="150000").status_code == 201
    resp = _pay(client, ctx, order_id, method="CASH", amount="60000")
    assert resp.status_code == 409


def test_cash_received_must_cover_amount_and_card_has_no_cash(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
    resp = _pay(client, ctx, order_id, method="CASH", amount="100000", cash_received="50000")
    assert resp.status_code == 422
    resp = _pay(client, ctx, order_id, method="CARD", cash_received="50000")
    assert resp.status_code == 422
    resp = _pay(client, ctx, order_id, method="VNPAY", cash_received="50000")
    assert resp.status_code == 422
    resp = _pay(client, ctx, order_id, method="MOMO")
    assert resp.status_code == 422
    resp = _pay(client, ctx, order_id, method="CASH", amount="0")
    assert resp.status_code == 422


def test_payment_requires_billing_and_cashier(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx, bill=False)
    assert _pay(client, ctx, order_id, method="CASH").status_code == 409
    _bill(client, ctx, order_id)
    assert _pay(client, ctx, order_id, role="waiter", method="CASH").status_code == 403
    resp = client.get(f"/api/v1/orders/{order_id}/payments", headers=ctx["waiter"])
    assert resp.status_code == 403


def test_idempotent_retry_records_payment_once(client, seed, ctx, db_session_factory):
    order_id = _billing_order(client, seed, ctx)
    key = str(uuid.uuid4())
    first = _pay(client, ctx, order_id, key=key, method="CASH", amount="50000")
    again = _pay(client, ctx, order_id, key=key, method="CASH", amount="50000")
    assert first.status_code == again.status_code == 201
    assert first.json()["payment"]["id"] == again.json()["payment"]["id"]
    session = db_session_factory()
    assert session.query(Payment).count() == 1
    session.close()


def test_supervisor_cancels_wrong_payment_before_paid(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
    payment_id = _pay(client, ctx, order_id, method="CARD", amount="150000").json()["payment"][
        "id"
    ]

    resp = client.post(
        f"/api/v1/payments/{payment_id}/cancel",
        json={"reason": "Quẹt nhầm số tiền"},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 403

    resp = client.post(
        f"/api/v1/payments/{payment_id}/cancel",
        json={"reason": "Quẹt nhầm số tiền"},
        headers={**ctx["supervisor"], **_key()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["payments"][0]["status"] == "CANCELLED"
    assert _money(body["summary"]["paid"]) == 0
    assert _money(body["summary"]["remaining"]) == Decimal("200000")

    again = client.post(
        f"/api/v1/payments/{payment_id}/cancel",
        json={"reason": "Quẹt nhầm số tiền"},
        headers={**ctx["supervisor"], **_key()},
    )
    assert again.status_code == 409

    assert _pay(client, ctx, order_id, method="CASH").json()["order_status"] == "PAID"


def test_cannot_cancel_after_paid_and_refund_partially(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
    payment_id = _pay(client, ctx, order_id, method="CASH").json()["payment"]["id"]

    cancel = client.post(
        f"/api/v1/payments/{payment_id}/cancel",
        json={"reason": "Muốn hủy"},
        headers={**ctx["supervisor"], **_key()},
    )
    assert cancel.status_code == 409

    def refund(amount=None, role="supervisor"):
        body = {"reason": "Món ra chậm, giảm cho khách"}
        if amount is not None:
            body["amount"] = amount
        return client.post(
            f"/api/v1/payments/{payment_id}/refunds", json=body, headers={**ctx[role], **_key()}
        )

    assert refund("50000", role="cashier").status_code == 403
    resp = refund("50000")
    assert resp.status_code == 201, resp.text
    payment = resp.json()["payments"][0]
    assert payment["status"] == "SUCCEEDED"
    assert _money(payment["refunded_amount"]) == Decimal("50000")
    assert len(payment["refunds"]) == 1
    assert _money(resp.json()["summary"]["refunded"]) == Decimal("50000")

    assert refund("150001").status_code == 409
    resp = refund()
    assert resp.status_code == 201
    payment = resp.json()["payments"][0]
    assert payment["status"] == "REFUNDED"
    assert _money(payment["refunded_amount"]) == Decimal("200000")
    assert resp.json()["order_status"] == "PAID"
    assert refund("1").status_code == 409


def test_refund_requires_paid_order(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
    payment_id = _pay(client, ctx, order_id, method="CASH", amount="10000").json()["payment"]["id"]
    resp = client.post(
        f"/api/v1/payments/{payment_id}/refunds",
        json={"reason": "Khách đổi ý"},
        headers={**ctx["supervisor"], **_key()},
    )
    assert resp.status_code == 409


def test_pay_shortcut_records_remaining_cash(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
    assert _pay(client, ctx, order_id, method="CARD", amount="30000").status_code == 201
    resp = client.post(f"/api/v1/orders/{order_id}/pay", headers={**ctx["cashier"], **_key()})
    assert resp.status_code == 200, resp.text
    listed = _list(client, ctx, order_id)
    assert listed["order_status"] == "PAID"
    assert [(p["method"], _money(p["amount"])) for p in listed["payments"]] == [
        ("CARD", Decimal("30000")),
        ("CASH", Decimal("170000")),
    ]
    assert _money(listed["summary"]["paid"]) == Decimal("200000")


def test_reward_discount_and_points_on_final_payment(client, seed, ctx):
    client.post("/api/v1/loyalty-rules", json=RULE, headers={**ctx["supervisor"], **_key()})
    order_id = _billing_order(client, seed, ctx)
    customer = client.post(
        "/api/v1/customers",
        json={"phone": "0907654321", "consent": True},
        headers={**ctx["cashier"], **_key()},
    ).json()
    client.post(
        f"/api/v1/orders/{order_id}/customer",
        json={"customer_id": customer["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    reward = client.post(
        "/api/v1/rewards",
        json={"name": "Giam 20000", "reward_type": "FIXED", "value": "20000"},
        headers={**ctx["supervisor"], **_key()},
    ).json()
    applied = client.post(
        f"/api/v1/orders/{order_id}/rewards",
        json={"reward_id": reward["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    assert applied.status_code == 201, applied.text

    first = _pay(client, ctx, order_id, method="CASH", amount="100000")
    assert _money(first.json()["summary"]["total"]) == Decimal("180000")

    # Đã nhận tiền thì không đổi được số phải trả theo hướng giảm, cũng không đổi khách.
    other = client.post(
        "/api/v1/rewards",
        json={"name": "Giam 5%", "reward_type": "PERCENT", "value": "5"},
        headers={**ctx["supervisor"], **_key()},
    ).json()
    order_reward_id = applied.json()["applied_reward"]["id"]
    client.delete(
        f"/api/v1/orders/{order_id}/rewards/{order_reward_id}",
        headers={**ctx["cashier"], **_key()},
    )
    blocked = client.post(
        f"/api/v1/orders/{order_id}/rewards",
        json={"reward_id": other["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    assert blocked.status_code == 409
    blocked = client.post(
        f"/api/v1/orders/{order_id}/customer",
        json={"customer_id": customer["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    assert blocked.status_code == 409

    # Gỡ ưu đãi làm số phải trả tăng lại 200.000đ, còn 100.000đ.
    last = _pay(client, ctx, order_id, method="CARD")
    assert last.status_code == 201, last.text
    assert _money(last.json()["payment"]["amount"]) == Decimal("100000")
    assert last.json()["order_status"] == "PAID"
    balance = client.get(f"/api/v1/customers/{customer['id']}", headers=ctx["cashier"]).json()[
        "points_balance"
    ]
    assert balance == 20


def test_final_payment_with_reward_commits_discount(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
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
    resp = _pay(client, ctx, order_id, method="CASH", cash_received="200000")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["order_status"] == "PAID"
    assert _money(body["payment"]["amount"]) == Decimal("180000")
    assert _money(body["payment"]["change_due"]) == Decimal("20000")
    detail = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()
    assert detail["applied_reward"]["status"] == "COMMITTED"
    assert _money(detail["amount_due"]) == 0


def test_payments_are_scoped_to_outlet(client, seed, ctx, db_session_factory):
    from app.core.security import hash_password
    from app.db.models import Outlet, Staff
    from tests.conftest import SEED_PASSWORD

    order_id = _billing_order(client, seed, ctx)
    payment_id = _pay(client, ctx, order_id, method="CASH", amount="10000").json()["payment"]["id"]

    session = db_session_factory()
    other = Outlet(name="Outlet khac")
    session.add(other)
    session.flush()
    session.add(
        Staff(
            outlet_id=other.id,
            username="sup_other",
            password_hash=hash_password(SEED_PASSWORD),
            full_name="Sup khac",
            role="SUPERVISOR",
        )
    )
    session.commit()
    session.close()
    outsider = login(client, "sup_other")

    assert client.get(f"/api/v1/orders/{order_id}/payments", headers=outsider).status_code == 404
    resp = client.post(
        f"/api/v1/payments/{payment_id}/cancel",
        json={"reason": "Thử outlet khác"},
        headers={**outsider, **_key()},
    )
    assert resp.status_code == 404
