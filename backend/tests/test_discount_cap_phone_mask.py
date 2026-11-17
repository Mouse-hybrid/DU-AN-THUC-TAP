"""ADR 0004 (P2-RFI-RWD): trần giảm giá 50% theo Nghị định 81, che số điện thoại với Cashier."""

from __future__ import annotations

import uuid
from decimal import Decimal

from app.db.models import LoyaltyRule, Reward
from tests.test_rewards_offers import (
    _apply,
    _assert_money,
    _attach,
    _bill_and_pay,
    _customer,
    _key,
    _order,
    _points_reward,
    _reward,
    ctx,  # noqa: F401  (fixture)
)

PHONE = "0901234567"
MASKED = "090****567"


# --- Trần 50% -------------------------------------------------------------------------------


def test_percent_reward_over_half_is_rejected(client, seed, ctx):  # noqa: F811
    resp = client.post(
        "/api/v1/rewards",
        json={"name": "Giam 60%", "reward_type": "PERCENT", "value": "60"},
        headers={**ctx["supervisor"], **_key()},
    )
    assert resp.status_code == 422
    assert "50%" in resp.text

    ok = _reward(client, ctx, name="Giam 50%", value="50")
    patch = client.patch(
        f"/api/v1/rewards/{ok['id']}", json={"value": "51"}, headers=ctx["supervisor"]
    )
    assert patch.status_code == 422


def test_loyalty_rule_redeem_percent_over_half_is_rejected(client, seed, ctx):  # noqa: F811
    resp = client.post(
        "/api/v1/loyalty-rules",
        json={"earn_amount_per_point": "10000", "redeem_value_per_point": "100",
              "max_redeem_percent": 51},
        headers={**ctx["supervisor"], **_key()},
    )
    assert resp.status_code == 422


def test_old_reward_over_half_is_still_capped_even_with_override(
    client, seed, ctx, db_session_factory  # noqa: F811
):
    """Ưu đãi tạo trước khi có trần (dữ liệu cũ 80%) vẫn chỉ giảm 50%, Supervisor cũng vậy."""
    reward = _reward(client, ctx, name="Cu", value="10")
    session = db_session_factory()
    session.get(Reward, uuid.UUID(reward["id"])).value = Decimal("80")
    session.commit()
    session.close()

    order_id = _order(client, seed, ctx)  # 200.000đ
    body = _apply(
        client, ctx, order_id, reward["id"], role="supervisor", override_reason="Khach quen"
    ).json()
    _assert_money(body["discount_total"], "100000")
    _assert_money(body["total"], "100000")


def test_old_rule_over_half_still_caps_points_at_half(
    client, seed, ctx, db_session_factory  # noqa: F811
):
    """Luật điểm cũ cho đổi 80% (tạo trước khi có trần) vẫn chỉ đổi tối đa 50% hóa đơn."""
    session = db_session_factory()
    for rule in session.query(LoyaltyRule).all():
        rule.max_redeem_percent = 80
    session.commit()
    session.close()

    order_id = _order(client, seed, ctx)  # 200.000đ, 1 điểm = 100đ
    customer = _customer(client, ctx, points=5000)
    assert _attach(client, ctx, order_id, customer["id"]).status_code == 200
    reward = _points_reward(client, ctx)
    over = _apply(client, ctx, order_id, reward["id"], points=1001)
    assert over.status_code == 409 and "1000" in over.json()["detail"]
    body = _apply(client, ctx, order_id, reward["id"], points=1000).json()
    _assert_money(body["discount_total"], "100000")
    paid = _bill_and_pay(client, ctx, order_id)
    assert paid.status_code == 200, paid.text


# --- Che số điện thoại ------------------------------------------------------------------------


def test_cashier_sees_masked_phone_supervisor_sees_full(client, seed, ctx):  # noqa: F811
    created = client.post(
        "/api/v1/customers",
        json={"phone": PHONE, "consent": True},
        headers={**ctx["cashier"], "Idempotency-Key": "mask-1"},
    )
    assert created.status_code == 201
    assert created.json()["phone"] == MASKED
    customer_id = created.json()["id"]

    lookup = client.get("/api/v1/customers", params={"phone": PHONE}, headers=ctx["cashier"])
    assert [c["phone"] for c in lookup.json()] == [MASKED]
    one = client.get(f"/api/v1/customers/{customer_id}", headers=ctx["cashier"])
    assert one.json()["phone"] == MASKED

    sup = ctx["supervisor"]
    assert client.get(f"/api/v1/customers/{customer_id}", headers=sup).json()["phone"] == PHONE
    assert [c["phone"] for c in client.get("/api/v1/customers", headers=sup).json()] == [PHONE]
    patched = client.patch(
        f"/api/v1/customers/{customer_id}", json={"full_name": "A"}, headers=sup
    )
    assert patched.json()["phone"] == PHONE


def test_idempotent_replay_masks_for_caller(client, seed, ctx):  # noqa: F811
    """Bản lưu cho Idempotency-Key là bản đủ, nhưng gửi lại vẫn che theo vai trò."""
    body = {"phone": PHONE, "consent": True}
    first = client.post(
        "/api/v1/customers", json=body, headers={**ctx["cashier"], "Idempotency-Key": "mask-2"}
    )
    replay = client.post(
        "/api/v1/customers", json=body, headers={**ctx["cashier"], "Idempotency-Key": "mask-2"}
    )
    assert first.json() == replay.json()
    assert replay.json()["phone"] == MASKED


def test_permission_override_controls_phone_visibility(client, seed, ctx):  # noqa: F811
    """Quyền xem đủ đi theo LOYALTY_MANAGE trong ma trận đang hiệu lực, không cố định theo tên
    vai trò: Supervisor cấp LOYALTY_MANAGE cho Cashier thì Cashier thấy đủ ngay."""
    customer = _customer(client, ctx, phone=PHONE)
    url = f"/api/v1/customers/{customer['id']}"
    assert client.get(url, headers=ctx["cashier"]).json()["phone"] == MASKED

    resp = client.put(
        "/api/v1/staff/permissions/LOYALTY_MANAGE",
        json={"roles": ["CASHIER", "SUPERVISOR"]},
        headers={**ctx["supervisor"], **_key()},
    )
    assert resp.status_code == 200, resp.text
    assert client.get(url, headers=ctx["cashier"]).json()["phone"] == PHONE
