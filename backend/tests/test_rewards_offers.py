"""Rewards đợt 2: ưu đãi, áp/gỡ vào đơn, đổi điểm, tiền giảm do server tính, tính lại khi hóa
đơn đổi, chốt đúng khi thanh toán, tích điểm trên số tiền thực trả."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.db.models import AuditLog, Customer, OrderReward, PointsLedger, RestaurantTable, Reward
from tests.conftest import login

RULE = {
    "earn_amount_per_point": "10000",
    "redeem_value_per_point": "100",
    "max_redeem_percent": 50,
}
PHONE = "0901234567"


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def ctx(client, seed):
    supervisor = login(client, "supervisor_test")
    cashier = login(client, "cashier_test")
    waiter = login(client, "waiter_test")
    client.post("/api/v1/loyalty-rules", json=RULE, headers={**supervisor, **_key()})
    return {"supervisor": supervisor, "cashier": cashier, "waiter": waiter}


def _order(client, seed, ctx, quantity=4, table_id=None):
    """Món 50.000đ, mặc định 4 phần = 200.000đ, đang ở trạng thái đã gửi bếp."""
    waiter = ctx["waiter"]
    session_id = client.post(
        f"/api/v1/tables/{table_id or seed['table_id']}/open-session",
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
    return order_id


def _reward(client, ctx, **body):
    payload = {"name": "Giam 10%", "reward_type": "PERCENT", "value": "10", **body}
    resp = client.post("/api/v1/rewards", json=payload, headers={**ctx["supervisor"], **_key()})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _points_reward(client, ctx):
    return _reward(client, ctx, name="Doi diem", reward_type="POINTS", value=None)


def _customer(client, ctx, points=0, phone=PHONE):
    customer = client.post(
        "/api/v1/customers",
        json={"phone": phone, "consent": True},
        headers={**ctx["cashier"], **_key()},
    ).json()
    if points:
        resp = client.post(
            f"/api/v1/customers/{customer['id']}/points/adjust",
            json={"points": points, "reason": "test"},
            headers={**ctx["supervisor"], **_key()},
        )
        assert resp.status_code == 201, resp.text
    return customer


def _attach(client, ctx, order_id, customer_id):
    resp = client.post(
        f"/api/v1/orders/{order_id}/customer",
        json={"customer_id": customer_id},
        headers={**ctx["cashier"], **_key()},
    )
    return resp


def _apply(client, ctx, order_id, reward_id, role="cashier", key=None, **body):
    return client.post(
        f"/api/v1/orders/{order_id}/rewards",
        json={"reward_id": reward_id, **body},
        headers={**ctx[role], "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _detail(client, ctx, order_id):
    return client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()


def _bill_and_pay(client, ctx, order_id):
    billed = client.post(
        f"/api/v1/orders/{order_id}/request-billing", headers={**ctx["cashier"], **_key()}
    )
    assert billed.status_code == 200, billed.text
    return client.post(f"/api/v1/orders/{order_id}/pay", headers={**ctx["cashier"], **_key()})


def _balance(client, ctx, customer):
    return client.get(f"/api/v1/customers/{customer['id']}", headers=ctx["cashier"]).json()[
        "points_balance"
    ]


def _assert_money(actual, expected):
    assert Decimal(actual) == Decimal(expected)


def test_percent_discount_is_computed_by_server_and_capped(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx, max_discount="15000", value="10")
    resp = _apply(client, ctx, order_id, reward["id"])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    _assert_money(body["subtotal"], "200000")
    _assert_money(body["discount_total"], "15000")  # 10% = 20.000, trần 15.000
    _assert_money(body["total"], "185000")
    assert body["applied_reward"]["status"] == "APPLIED"


def test_fixed_discount_never_exceeds_bill(client, seed, ctx):
    order_id = _order(client, seed, ctx, quantity=1)
    reward = _reward(client, ctx, name="Giam tien", reward_type="FIXED", value="999999")
    body = _apply(client, ctx, order_id, reward["id"]).json()
    _assert_money(body["discount_total"], "50000")
    _assert_money(body["total"], "0")


def test_client_cannot_send_discount_amount(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx)
    resp = _apply(client, ctx, order_id, reward["id"], discount_amount="199999")
    assert resp.status_code == 422


def test_only_one_reward_and_remove_before_pay(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    first = _reward(client, ctx)
    second = _reward(client, ctx, name="Giam khac", value="5")
    applied = _apply(client, ctx, order_id, first["id"]).json()["applied_reward"]
    assert _apply(client, ctx, order_id, second["id"]).status_code == 409

    url = f"/api/v1/orders/{order_id}/rewards/{applied['id']}"
    removed = client.delete(url, headers={**ctx["cashier"], **_key()})
    assert removed.status_code == 200, removed.text
    assert removed.json()["applied_reward"] is None
    _assert_money(removed.json()["total"], "200000")
    assert client.delete(url, headers={**ctx["cashier"], **_key()}).status_code == 409
    other = client.delete(
        f"/api/v1/orders/{order_id}/rewards/{uuid.uuid4()}", headers={**ctx["cashier"], **_key()}
    )
    assert other.status_code == 404
    assert _apply(client, ctx, order_id, second["id"]).status_code == 201


def test_apply_is_idempotent(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx)
    first = _apply(client, ctx, order_id, reward["id"], key="apply-1")
    again = _apply(client, ctx, order_id, reward["id"], key="apply-1")
    assert again.status_code == 201
    assert again.json()["applied_reward"]["id"] == first.json()["applied_reward"]["id"]


@pytest.mark.parametrize(
    "body,code",
    [
        ({"min_order_amount": "999999"}, "MIN_ORDER"),
        ({"valid_to": "2020-01-01T00:00:00Z"}, "EXPIRED"),
        ({"valid_from": "2999-01-01T00:00:00Z"}, "NOT_STARTED"),
    ],
)
def test_eligibility_lists_reason_and_blocks_apply(client, seed, ctx, body, code):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx, **body)
    rows = client.get(f"/api/v1/orders/{order_id}/eligible-rewards", headers=ctx["cashier"]).json()
    row = next(r for r in rows if r["reward_id"] == reward["id"])
    assert row["eligible"] is False and row["reason_code"] == code and row["reason"]
    assert _apply(client, ctx, order_id, reward["id"]).status_code == 409


def test_eligible_list_shows_discount_and_max_points(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    percent = _reward(client, ctx)
    points = _points_reward(client, ctx)
    customer = _customer(client, ctx, points=5000)
    _attach(client, ctx, order_id, customer["id"])

    rows = {
        r["reward_id"]: r
        for r in client.get(
            f"/api/v1/orders/{order_id}/eligible-rewards", headers=ctx["cashier"]
        ).json()
    }
    _assert_money(rows[percent["id"]]["discount_amount"], "20000")
    # Trần 50% của 200.000 = 100.000đ = 1.000 điểm.
    assert rows[points["id"]]["max_points"] == 1000
    assert rows[points["id"]]["points"] == 1000
    _assert_money(rows[points["id"]]["discount_amount"], "100000")


def test_points_redeem_full_flow_and_earn_on_amount_paid(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _points_reward(client, ctx)
    customer = _customer(client, ctx, points=500)
    _attach(client, ctx, order_id, customer["id"])

    body = _apply(client, ctx, order_id, reward["id"], points=300).json()
    _assert_money(body["discount_total"], "30000")
    _assert_money(body["total"], "170000")
    # Chưa thanh toán thì chưa trừ điểm.
    assert _balance(client, ctx, customer) == 500

    assert _bill_and_pay(client, ctx, order_id).status_code == 200
    # 500 - 300 + 17 (170.000đ thực trả / 10.000).
    assert _balance(client, ctx, customer) == 217
    entries = client.get(
        f"/api/v1/customers/{customer['id']}/points", headers=ctx["cashier"]
    ).json()
    by_type = {e["entry_type"]: e for e in entries}
    assert by_type["REDEEM"]["points"] == -300 and by_type["REDEEM"]["order_id"] == order_id
    assert by_type["EARN"]["points"] == 17

    final = _detail(client, ctx, order_id)
    assert final["applied_reward"]["status"] == "COMMITTED"
    _assert_money(final["total"], "170000")
    usage = client.get(
        f"/api/v1/customers/{customer['id']}/reward-usage", headers=ctx["cashier"]
    ).json()
    assert [u["points_used"] for u in usage] == [300]
    _assert_money(usage[0]["discount_amount"], "30000")


def test_points_limits(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _points_reward(client, ctx)

    no_customer = _apply(client, ctx, order_id, reward["id"], points=10)
    assert no_customer.status_code == 409
    customer = _customer(client, ctx, points=2000)
    _attach(client, ctx, order_id, customer["id"])
    assert _apply(client, ctx, order_id, reward["id"]).status_code == 422  # thiếu points
    assert _apply(client, ctx, order_id, reward["id"], points=2001).status_code == 409  # quá số dư
    over_cap = _apply(client, ctx, order_id, reward["id"], points=1001)  # quá trần 50%
    assert over_cap.status_code == 409 and "1000" in over_cap.json()["detail"]
    assert _apply(client, ctx, order_id, reward["id"], points=1000).status_code == 201

    percent = _reward(client, ctx, name="Khac")
    other_order_points = _apply(client, ctx, order_id, percent["id"], points=1)
    assert other_order_points.status_code == 409  # đã có ưu đãi


def test_points_on_non_points_reward_rejected(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx)
    assert _apply(client, ctx, order_id, reward["id"], points=5).status_code == 422


def test_bill_change_recalculates_and_can_invalidate(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx, min_order_amount="150000")
    _apply(client, ctx, order_id, reward["id"])
    added = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 2}]},
        headers={**ctx["waiter"], **_key()},
    ).json()
    body = _detail(client, ctx, order_id)
    _assert_money(body["subtotal"], "300000")
    _assert_money(body["discount_total"], "30000")

    # Bỏ món mới rồi hủy bớt món đã gửi bếp: xuống dưới mức tối thiểu.
    new_item = added["items"][-1]["id"]
    client.delete(
        f"/api/v1/orders/{order_id}/items/{new_item}", headers={**ctx["waiter"], **_key()}
    )
    sent = [i for i in _detail(client, ctx, order_id)["items"] if i["status"] == "SENT"][0]
    voided = client.post(
        f"/api/v1/orders/{order_id}/items/{sent['id']}/void",
        json={"reason": "khach doi y"},
        headers={**ctx["supervisor"], **_key()},
    )
    assert voided.status_code == 200, voided.text
    body = _detail(client, ctx, order_id)
    assert body["applied_reward"]["invalid_reason"] == "MIN_ORDER"
    _assert_money(body["discount_total"], "0")


def test_payment_blocked_until_invalid_reward_removed(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx)
    applied = _apply(client, ctx, order_id, reward["id"]).json()["applied_reward"]
    client.patch(
        f"/api/v1/rewards/{reward['id']}",
        json={"valid_to": "2020-01-01T00:00:00Z"},
        headers=ctx["supervisor"],
    )
    resp = _bill_and_pay(client, ctx, order_id)
    assert resp.status_code == 409 and "hết hạn" in resp.json()["detail"]
    assert _detail(client, ctx, order_id)["status"] == "BILLING"

    client.delete(
        f"/api/v1/orders/{order_id}/rewards/{applied['id']}",
        headers={**ctx["cashier"], **_key()},
    )
    paid = client.post(f"/api/v1/orders/{order_id}/pay", headers={**ctx["cashier"], **_key()})
    assert paid.status_code == 200, paid.text


def test_two_orders_cannot_spend_same_points(client, seed, ctx, db_session_factory):
    session = db_session_factory()
    table = RestaurantTable(outlet_id=seed["outlet_id"], code="T2", seats=2, status="AVAILABLE")
    session.add(table)
    session.commit()
    second_table = table.id
    session.close()

    reward = _points_reward(client, ctx)
    customer = _customer(client, ctx, points=300)
    first = _order(client, seed, ctx)
    second = _order(client, seed, ctx, table_id=second_table)
    for order_id in (first, second):
        _attach(client, ctx, order_id, customer["id"])
        assert _apply(client, ctx, order_id, reward["id"], points=300).status_code == 201

    assert _bill_and_pay(client, ctx, first).status_code == 200
    # Đơn sau bị chặn vì điểm đã tiêu; 20 điểm tích từ đơn đầu không đủ 300.
    denied = _bill_and_pay(client, ctx, second)
    assert denied.status_code == 409 and "đủ điểm" in denied.json()["detail"]
    session = db_session_factory()
    row = session.get(Customer, uuid.UUID(customer["id"]))
    entries = session.query(PointsLedger).filter_by(customer_id=row.id).all()
    assert row.points_balance >= 0
    assert row.points_balance == sum(e.points for e in entries)
    session.close()


def test_usage_limit_counts_only_paid_orders(client, seed, ctx, db_session_factory):
    reward = _reward(client, ctx, max_uses=1)
    order_id = _order(client, seed, ctx)
    applied = _apply(client, ctx, order_id, reward["id"]).json()["applied_reward"]
    client.delete(
        f"/api/v1/orders/{order_id}/rewards/{applied['id']}",
        headers={**ctx["cashier"], **_key()},
    )
    _apply(client, ctx, order_id, reward["id"])
    assert _bill_and_pay(client, ctx, order_id).status_code == 200

    session = db_session_factory()
    assert session.get(Reward, uuid.UUID(reward["id"])).used_count == 1
    table = RestaurantTable(outlet_id=seed["outlet_id"], code="T2", seats=2, status="AVAILABLE")
    session.add(table)
    session.commit()
    table_id = table.id
    session.close()

    other = _order(client, seed, ctx, table_id=table_id)
    assert _apply(client, ctx, other, reward["id"]).status_code == 409


def test_supervisor_override_is_audited_and_cashier_cannot(client, seed, ctx, db_session_factory):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx, min_order_amount="999999")
    denied = _apply(client, ctx, order_id, reward["id"], override_reason="khach VIP")
    assert denied.status_code == 403

    resp = _apply(
        client, ctx, order_id, reward["id"], role="supervisor", override_reason="khach VIP"
    )
    assert resp.status_code == 201, resp.text
    _assert_money(resp.json()["discount_total"], "20000")
    assert _bill_and_pay(client, ctx, order_id).status_code == 200

    session = db_session_factory()
    log = session.query(AuditLog).filter_by(action="ORDER_REWARD_OVERRIDDEN").one()
    assert "khach VIP" in log.payload
    assert session.query(OrderReward).one().override_reason == "khach VIP"
    session.close()


def test_override_cannot_bypass_points_balance(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _points_reward(client, ctx)
    customer = _customer(client, ctx, points=10)
    _attach(client, ctx, order_id, customer["id"])
    resp = _apply(
        client, ctx, order_id, reward["id"], role="supervisor", points=100, override_reason="x"
    )
    assert resp.status_code == 409


def test_cannot_change_customer_while_redeeming(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _points_reward(client, ctx)
    customer = _customer(client, ctx, points=100)
    other = _customer(client, ctx, phone="0909999999")
    _attach(client, ctx, order_id, customer["id"])
    _apply(client, ctx, order_id, reward["id"], points=50)
    assert _attach(client, ctx, order_id, other["id"]).status_code == 409
    assert _attach(client, ctx, order_id, None).status_code == 409


def test_committed_order_keeps_numbers_after_reward_edit(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx)
    _apply(client, ctx, order_id, reward["id"])
    _bill_and_pay(client, ctx, order_id)
    client.patch(
        f"/api/v1/rewards/{reward['id']}",
        json={"value": "50", "name": "Doi ten"},
        headers=ctx["supervisor"],
    )
    body = _detail(client, ctx, order_id)
    _assert_money(body["discount_total"], "20000")
    assert body["applied_reward"]["reward_name"] == "Giam 10%"
    removed = client.delete(
        f"/api/v1/orders/{order_id}/rewards/{body['applied_reward']['id']}",
        headers={**ctx["cashier"], **_key()},
    )
    assert removed.status_code == 409


def test_redeem_rule_is_pinned_at_apply(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _points_reward(client, ctx)
    customer = _customer(client, ctx, points=100)
    _attach(client, ctx, order_id, customer["id"])
    _apply(client, ctx, order_id, reward["id"], points=100)
    client.post(
        "/api/v1/loyalty-rules",
        json={**RULE, "redeem_value_per_point": "1"},
        headers={**ctx["supervisor"], **_key()},
    )
    _assert_money(_detail(client, ctx, order_id)["discount_total"], "10000")


def test_order_without_reward_unchanged(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    body = _detail(client, ctx, order_id)
    _assert_money(body["discount_total"], "0")
    assert body["subtotal"] == body["total"] and body["applied_reward"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"name": "A", "reward_type": "PERCENT"},
        {"name": "A", "reward_type": "PERCENT", "value": "101"},
        {"name": "A", "reward_type": "FIXED", "value": "0"},
        {"name": "A", "reward_type": "POINTS", "value": "10"},
        {"name": "A", "reward_type": "KHAC", "value": "10"},
        {"name": "", "reward_type": "FIXED", "value": "10"},
        {
            "name": "A",
            "reward_type": "FIXED",
            "value": "10",
            "valid_from": "2030-01-02T00:00:00Z",
            "valid_to": "2030-01-01T00:00:00Z",
        },
    ],
)
def test_create_reward_validation(client, seed, ctx, body):
    resp = client.post("/api/v1/rewards", json=body, headers={**ctx["supervisor"], **_key()})
    assert resp.status_code == 422


def test_update_reward_rules_and_listing(client, seed, ctx):
    reward = _reward(client, ctx)
    points = _points_reward(client, ctx)
    url = f"/api/v1/rewards/{reward['id']}"
    supervisor = ctx["supervisor"]

    assert client.patch(url, json={}, headers=supervisor).status_code == 422
    assert client.patch(url, json={"name": None}, headers=supervisor).status_code == 422
    assert client.patch(url, json={"value": "101"}, headers=supervisor).status_code == 422
    assert client.patch(url, json={"name": "Doi diem"}, headers=supervisor).status_code == 409
    points_url = f"/api/v1/rewards/{points['id']}"
    assert client.patch(points_url, json={"value": "5"}, headers=supervisor).status_code == 422
    now = datetime.now(timezone.utc)
    backwards = {
        "valid_from": (now + timedelta(days=2)).isoformat(),
        "valid_to": now.isoformat(),
    }
    assert client.patch(url, json=backwards, headers=supervisor).status_code == 422
    assert client.patch(url, json={"max_discount": "1000"}, headers=supervisor).status_code == 200
    cleared = client.patch(url, json={"max_discount": None}, headers=supervisor)
    assert cleared.status_code == 200 and cleared.json()["max_discount"] is None

    client.patch(url, json={"is_active": False}, headers=supervisor)
    active = client.get("/api/v1/rewards?active_only=true", headers=ctx["cashier"]).json()
    assert [r["id"] for r in active] == [points["id"]]
    assert len(client.get("/api/v1/rewards", headers=ctx["cashier"]).json()) == 2


def test_customer_sees_discount_on_qr_order(client, seed, ctx):
    order_id = _order(client, seed, ctx)
    reward = _reward(client, ctx)
    _apply(client, ctx, order_id, reward["id"])
    token = client.post(
        f"/api/v1/tables/{seed['table_id']}/qr-session", headers={**ctx["waiter"], **_key()}
    ).json()["token"]
    body = client.get(f"/api/v1/public/qr/{token}/order").json()
    _assert_money(body["discount_total"], "20000")
    _assert_money(body["total"], "180000")
