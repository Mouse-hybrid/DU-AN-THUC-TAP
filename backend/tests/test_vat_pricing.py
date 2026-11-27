"""VAT và phí phục vụ (specs/003-vat-hoa-don US1, US2): công thức, làm tròn, chốt tỉ lệ khi
BILLING, chốt số khi PAID, tách bill, cấu hình outlet."""

from __future__ import annotations

import itertools
import json
import uuid
from decimal import ROUND_HALF_UP, Decimal

import pytest

from app.core.pricing import PricingRates, compute_charges
from app.db.models import AuditLog, Order, Outlet
from tests.conftest import login

D = Decimal


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _money(value):
    return D(str(value))


# ---------------------------------------------------------------------------
# Hàm thuần
# ---------------------------------------------------------------------------


def test_spec_example_us1():
    rates = PricingRates(vat_rate=D("8"), service_charge_rate=D("5"))
    charges = compute_charges(D("270000"), rates)
    assert charges.service_charge == D("13500")
    assert charges.tax_total == D("22680")
    assert charges.total == D("306180")


def test_prices_include_vat_extracts_tax_without_adding():
    charges = compute_charges(D("108000"), PricingRates(vat_rate=D("8"), prices_include_vat=True))
    assert charges.tax_total == D("8000")
    assert charges.service_charge == D("0")
    assert charges.total == D("108000")


def test_defaults_are_off():
    charges = compute_charges(D("270000"), PricingRates())
    assert (charges.service_charge, charges.tax_total, charges.total) == (0, 0, D("270000"))


@pytest.mark.parametrize("base", [D("0"), D("-1")])
def test_zero_or_negative_base_has_no_charges(base):
    charges = compute_charges(base, PricingRates(vat_rate=D("10"), service_charge_rate=D("5")))
    assert (charges.service_charge, charges.tax_total, charges.total) == (0, 0, 0)


def _hand(base, vat, include, sc):
    """Tính tay theo research R-1 để đối chiếu."""

    def r(x):
        return x.quantize(D("1"), rounding=ROUND_HALF_UP)

    service = r(base * sc / 100)
    taxable = base + service
    if include:
        return service, r(taxable * vat / (100 + vat)), taxable
    tax = r(taxable * vat / 100)
    return service, tax, taxable + tax


# 2 giá × gồm/chưa gồm VAT × có/không phí × có/không giảm giá = 16 tổ hợp (SC-002 cùng 4 tổ
# hợp tách bill bên dưới). Giá lẻ để thử làm tròn nửa lên.
@pytest.mark.parametrize(
    "subtotal,include,sc,discount",
    list(itertools.product([D("123450"), D("99999")], [False, True], [D("0"), D("5")], [0, 1])),
)
def test_combinations_match_hand_calculation(subtotal, include, sc, discount):
    base = subtotal - (D("12345") if discount else 0)
    rates = PricingRates(vat_rate=D("8"), prices_include_vat=include, service_charge_rate=sc)
    charges = compute_charges(base, rates)
    assert (charges.service_charge, charges.tax_total, charges.total) == _hand(
        base, D("8"), include, sc
    )
    assert charges.total == charges.total.quantize(D("1"))


def test_half_rounds_up():
    # 1.250 × 10% = 125; 1.255 × 10% = 125,5 -> 126
    assert compute_charges(D("1255"), PricingRates(vat_rate=D("10"))).tax_total == D("126")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@pytest.fixture()
def ctx(client, seed):
    return {
        "supervisor": login(client, "supervisor_test"),
        "cashier": login(client, "cashier_test"),
        "waiter": login(client, "waiter_test"),
    }


def _set_rates(client, ctx, **body):
    resp = client.patch("/api/v1/outlet/settings", json=body, headers=ctx["supervisor"])
    assert resp.status_code == 200, resp.text
    return resp.json()


def _open_order(client, seed, ctx, quantity=6):
    """Món 50.000đ, mặc định 6 phần = 300.000đ, chưa gửi bếp."""
    waiter = ctx["waiter"]
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, **_key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders", json={"table_session_id": session_id}, headers={**waiter, **_key()}
    ).json()["id"]
    resp = client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": quantity}]},
        headers={**waiter, **_key()},
    )
    assert resp.status_code in (200, 201), resp.text
    return order_id


def _send_and_bill(client, ctx, order_id):
    resp = client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**ctx["waiter"], **_key()}
    )
    assert resp.status_code == 200, resp.text
    resp = client.post(
        f"/api/v1/orders/{order_id}/request-billing", headers={**ctx["waiter"], **_key()}
    )
    assert resp.status_code == 200, resp.text


def _billing_order(client, seed, ctx, quantity=6):
    order_id = _open_order(client, seed, ctx, quantity)
    _send_and_bill(client, ctx, order_id)
    return order_id


def _detail(client, ctx, order_id):
    resp = client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"])
    assert resp.status_code == 200, resp.text
    return resp.json()


def _apply_fixed(client, ctx, order_id, value="30000"):
    reward = client.post(
        "/api/v1/rewards",
        json={"name": f"Giam {value}", "reward_type": "FIXED", "value": value},
        headers={**ctx["supervisor"], **_key()},
    ).json()
    resp = client.post(
        f"/api/v1/orders/{order_id}/rewards",
        json={"reward_id": reward["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _pay(client, ctx, order_id, **body):
    return client.post(
        f"/api/v1/orders/{order_id}/payments", json=body, headers={**ctx["cashier"], **_key()}
    )


def test_order_detail_matches_spec_table(client, seed, ctx):
    _set_rates(client, ctx, vat_rate="8", service_charge_rate="5")
    order_id = _billing_order(client, seed, ctx)
    _apply_fixed(client, ctx, order_id)

    body = _detail(client, ctx, order_id)
    assert _money(body["subtotal"]) == D("300000")
    assert _money(body["discount_total"]) == D("30000")
    assert _money(body["service_charge"]) == D("13500")
    assert _money(body["tax_total"]) == D("22680")
    assert _money(body["total"]) == D("306180")
    assert _money(body["amount_due"]) == D("306180")
    assert body["pricing_rates"]["locked"] is True
    assert _money(body["pricing_rates"]["vat_rate"]) == D("8")


def test_defaults_keep_old_numbers(client, seed, ctx):
    order_id = _billing_order(client, seed, ctx)
    body = _detail(client, ctx, order_id)
    assert _money(body["total"]) == D("300000")
    assert _money(body["service_charge"]) == 0
    assert _money(body["tax_total"]) == 0


def test_prices_include_vat_total_unchanged(client, seed, ctx):
    _set_rates(client, ctx, vat_rate="8", prices_include_vat=True)
    order_id = _billing_order(client, seed, ctx, quantity=2)  # 100.000đ
    body = _detail(client, ctx, order_id)
    assert _money(body["total"]) == D("100000")
    assert _money(body["tax_total"]) == D("7407")  # 100.000 × 8/108 = 7.407,4


def test_split_payments_must_cover_new_total(client, seed, ctx, db_session_factory):
    _set_rates(client, ctx, vat_rate="8", service_charge_rate="5")
    order_id = _billing_order(client, seed, ctx)  # 300.000 -> phí 15.000 -> VAT 25.200 = 340.200

    first = _pay(client, ctx, order_id, method="CASH", amount="300000")
    assert first.status_code == 201, first.text
    assert _money(first.json()["summary"]["total"]) == D("340200")
    assert first.json()["order_status"] == "BILLING"

    over = _pay(client, ctx, order_id, method="CARD", amount="40201")
    assert over.status_code == 409, over.text

    last = _pay(client, ctx, order_id, method="CARD", amount="40200")
    assert last.status_code == 201, last.text
    assert last.json()["order_status"] == "PAID"

    session = db_session_factory()
    order = session.get(Order, uuid.UUID(order_id))
    assert order.service_charge == D("15000")
    assert order.tax_total == D("25200")
    assert order.paid_at is not None
    paid_audit = session.query(AuditLog).filter_by(action="ORDER_PAID").one()
    assert D(json.loads(paid_audit.payload)["vat_rate"]) == D("8")
    session.close()


def test_rates_locked_at_billing(client, seed, ctx):
    _set_rates(client, ctx, vat_rate="8")
    order_id = _billing_order(client, seed, ctx)
    _pay(client, ctx, order_id, method="CASH", amount="100000")

    _set_rates(client, ctx, vat_rate="10", service_charge_rate="5")
    body = _detail(client, ctx, order_id)
    assert _money(body["total"]) == D("324000")  # vẫn 8%, không phí
    assert _money(body["amount_due"]) == D("224000")


def test_open_order_follows_current_config(client, seed, ctx):
    order_id = _open_order(client, seed, ctx)
    _set_rates(client, ctx, vat_rate="10")
    body = _detail(client, ctx, order_id)
    assert body["pricing_rates"]["locked"] is False
    assert _money(body["total"]) == D("330000")


def test_paid_order_keeps_numbers_after_config_change(client, seed, ctx):
    _set_rates(client, ctx, vat_rate="8")
    order_id = _billing_order(client, seed, ctx)
    assert _pay(client, ctx, order_id, method="CASH", amount="324000").json()["order_status"] == (
        "PAID"
    )
    _set_rates(client, ctx, vat_rate="10", service_charge_rate="5")
    body = _detail(client, ctx, order_id)
    assert _money(body["total"]) == D("324000")
    assert _money(body["tax_total"]) == D("24000")


def test_order_paid_before_migration_stays_at_zero_rate(client, seed, ctx, db_session_factory):
    order_id = _billing_order(client, seed, ctx)
    session = db_session_factory()
    order = session.get(Order, uuid.UUID(order_id))
    # Giống đơn tạo trước migration 0016: chưa có tỉ lệ chốt.
    order.vat_rate_applied = None
    order.prices_include_vat_applied = None
    order.service_charge_rate_applied = None
    session.commit()
    session.close()

    _set_rates(client, ctx, vat_rate="10", service_charge_rate="5")
    assert _money(_detail(client, ctx, order_id)["total"]) == D("300000")


def test_remove_reward_during_billing_recomputes_tax(client, seed, ctx):
    _set_rates(client, ctx, vat_rate="8", service_charge_rate="5")
    order_id = _billing_order(client, seed, ctx)
    applied = _apply_fixed(client, ctx, order_id)
    assert _money(_detail(client, ctx, order_id)["total"]) == D("306180")

    resp = client.delete(
        f"/api/v1/orders/{order_id}/rewards/{applied['applied_reward']['id']}",
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code in (200, 204), resp.text
    assert _money(_detail(client, ctx, order_id)["total"]) == D("340200")


def test_vnpay_amount_uses_new_total(client, seed, ctx, monkeypatch):
    from app.api.v1 import vnpay as vnpay_api

    if not hasattr(vnpay_api, "price_order"):
        pytest.skip("VNPay không dùng price_order")
    _set_rates(client, ctx, vat_rate="8", service_charge_rate="5")
    order_id = _billing_order(client, seed, ctx)
    summary = client.get(f"/api/v1/orders/{order_id}/payments", headers=ctx["cashier"]).json()
    assert _money(summary["summary"]["total"]) == D("340200")
    assert _money(summary["summary"]["remaining"]) == D("340200")


@pytest.mark.parametrize("pre_tax,expected", [(False, 33), (True, 30)])
def test_points_earned_on_total_or_base(
    client, seed, ctx, db_session_factory, monkeypatch, pre_tax, expected
):
    """330.000đ gồm VAT 10% -> 33 điểm; bật LOYALTY_EARN_ON_PRE_TAX -> tính trên 300.000đ."""
    from app.api.v1 import orders as orders_api
    from app.db.models import Customer

    client.post(
        "/api/v1/loyalty-rules",
        json={
            "earn_amount_per_point": "10000",
            "redeem_value_per_point": "100",
            "max_redeem_percent": 50,
        },
        headers={**ctx["supervisor"], **_key()},
    )
    _set_rates(client, ctx, vat_rate="10")
    monkeypatch.setattr(orders_api, "LOYALTY_EARN_ON_PRE_TAX", pre_tax)
    order_id = _billing_order(client, seed, ctx)
    customer = client.post(
        "/api/v1/customers",
        json={"phone": "0901111111", "consent": True},
        headers={**ctx["cashier"], **_key()},
    ).json()
    client.post(
        f"/api/v1/orders/{order_id}/customer",
        json={"customer_id": customer["id"]},
        headers={**ctx["cashier"], **_key()},
    )
    assert _pay(client, ctx, order_id, method="CASH", amount="330000").status_code == 201
    session = db_session_factory()
    assert session.get(Customer, uuid.UUID(customer["id"])).points_balance == expected
    session.close()


def test_outlet_settings_permissions_validation_audit(client, seed, ctx, db_session_factory):
    current = client.get("/api/v1/outlet/settings", headers=ctx["supervisor"]).json()
    assert _money(current["vat_rate"]) == 0
    assert current["prices_include_vat"] is False

    denied = client.patch("/api/v1/outlet/settings", json={"vat_rate": "8"}, headers=ctx["cashier"])
    assert denied.status_code == 403

    for bad in (
        {"vat_rate": "21"},
        {"vat_rate": "-1"},
        {"service_charge_rate": "31"},
        {"vat_rate": "8.123"},
    ):
        resp = client.patch("/api/v1/outlet/settings", json=bad, headers=ctx["supervisor"])
        assert resp.status_code == 422, bad

    body = _set_rates(client, ctx, vat_rate="8", service_charge_rate="5")
    assert _money(body["vat_rate"]) == D("8")
    assert body["qr_send_mode"] == "DIRECT"  # trường không gửi thì giữ nguyên
    _set_rates(client, ctx, vat_rate="8")  # không đổi gì thì không ghi audit

    session = db_session_factory()
    rows = session.query(AuditLog).filter_by(action="OUTLET_SETTINGS_UPDATED").all()
    assert len(rows) == 1
    payload = json.loads(rows[0].payload)
    assert D(payload["vat_rate"]["before"]) == 0
    assert D(payload["vat_rate"]["after"]) == D("8")
    assert "qr_send_mode" not in payload
    session.close()


def test_other_outlet_config_does_not_apply(client, seed, ctx, db_session_factory):
    session = db_session_factory()
    session.add(Outlet(name="Outlet khac", vat_rate=D("10"), service_charge_rate=D("5")))
    session.commit()
    session.close()
    order_id = _billing_order(client, seed, ctx)
    assert _money(_detail(client, ctx, order_id)["total"]) == D("300000")


def test_qr_order_view_includes_charges(client, seed, ctx):
    _set_rates(client, ctx, vat_rate="8", service_charge_rate="5")
    order_id = _open_order(client, seed, ctx)
    qr = client.post(
        f"/api/v1/tables/{seed['table_id']}/qr-session", headers={**ctx["waiter"], **_key()}
    )
    assert qr.status_code == 201, qr.text
    token = qr.json()["token"]
    _send_and_bill(client, ctx, order_id)
    detail = _detail(client, ctx, order_id)
    view = client.get(f"/api/v1/public/qr/{token}/order")
    assert view.status_code == 200, view.text
    assert _money(view.json()["total"]) == _money(detail["total"]) == D("340200")
    assert _money(view.json()["tax_total"]) == D("25200")


# ---------------------------------------------------------------------------
# Tách bill (US2)
# ---------------------------------------------------------------------------


def _split_bills(client, seed, ctx, move_quantity):
    """Đơn 6 phần (300.000đ) chưa gửi bếp, tách `move_quantity` phần sang bill mới, rồi gửi bếp
    và yêu cầu thanh toán cả hai."""
    order_id = _open_order(client, seed, ctx)
    line = _detail(client, ctx, order_id)["items"][0]["id"]
    resp = client.post(
        f"/api/v1/orders/{order_id}/split",
        json={"items": [{"order_item_id": line, "quantity": move_quantity}]},
        headers={**ctx["waiter"], **_key()},
    )
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["new_order"]["id"]
    # Gửi bếp cả hai trước: bàn đã BILLING thì không gửi món được nữa.
    for target in (order_id, new_id):
        sent = client.post(
            f"/api/v1/orders/{target}/send-to-kitchen", headers={**ctx["waiter"], **_key()}
        )
        assert sent.status_code == 200, sent.text
    for target in (order_id, new_id):
        billed = client.post(
            f"/api/v1/orders/{target}/request-billing", headers={**ctx["waiter"], **_key()}
        )
        assert billed.status_code == 200, billed.text
    return order_id, new_id


def test_split_bill_each_has_own_charges(client, seed, ctx):
    _set_rates(client, ctx, vat_rate="8", service_charge_rate="5")
    bill_a, bill_b = _split_bills(client, seed, ctx, move_quantity=4)  # A 100.000, B 200.000
    a = _detail(client, ctx, bill_a)
    b = _detail(client, ctx, bill_b)
    assert (_money(a["service_charge"]), _money(a["tax_total"]), _money(a["total"])) == (
        D("5000"),
        D("8400"),
        D("113400"),
    )
    assert (_money(b["service_charge"]), _money(b["tax_total"]), _money(b["total"])) == (
        D("10000"),
        D("16800"),
        D("226800"),
    )
    assert _money(a["total"]) + _money(b["total"]) == D("340200")


@pytest.mark.parametrize("include,sc", list(itertools.product([False, True], ["0", "5"])))
def test_split_bill_sum_within_one_dong(client, seed, ctx, include, sc):
    _set_rates(client, ctx, vat_rate="8", prices_include_vat=include, service_charge_rate=sc)
    bill_a, bill_b = _split_bills(client, seed, ctx, move_quantity=1)
    whole = compute_charges(
        D("300000"),
        PricingRates(vat_rate=D("8"), prices_include_vat=include, service_charge_rate=D(sc)),
    )
    parts = [_detail(client, ctx, o) for o in (bill_a, bill_b)]
    for field in ("service_charge", "tax_total"):
        assert abs(sum(_money(p[field]) for p in parts) - getattr(whole, field)) <= 1
    assert abs(sum(_money(p["total"]) for p in parts) - whole.total) <= 2
