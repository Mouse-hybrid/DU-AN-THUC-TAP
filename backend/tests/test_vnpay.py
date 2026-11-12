"""VNPay sandbox (SDD R2, specs/001-vnpay-sandbox): tạo link có chữ ký, giữ chỗ số tiền, xác
nhận qua Return URL + QueryDR, kiểm tra lại, đối soát, IPN, không đóng đơn hai lần.

VNPay được giả lập: khóa giả + httpx.MockTransport cho QueryDR, không gọi mạng.
"""

from __future__ import annotations

import importlib.util
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import httpx
import pytest

from app.core import config, vnpay
from app.db.models import AuditLog, Payment
from tests.conftest import login

TMN = "TESTCODE"


@pytest.fixture()
def vnp(monkeypatch):
    """Bật cấu hình VNPay giả và một QueryDR giả: `state[txn_ref]` = (mã phản hồi, trạng thái
    giao dịch, số tiền) hoặc "timeout". Mặc định: chưa có giao dịch (91)."""
    monkeypatch.setattr(config, "VNPAY_TMN_CODE", TMN)
    monkeypatch.setattr(config, "VNPAY_HASH_SECRET", "secret-test-123")
    monkeypatch.setattr(
        config, "VNPAY_RETURN_URL", "http://testserver/api/v1/payments/vnpay/return"
    )
    state: dict = {}
    calls: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = __import__("json").loads(request.content)
        calls.append(body)
        ref = body["vnp_TxnRef"]
        conf = state.get(ref, ("91", "", 0))
        if conf == "timeout":
            raise httpx.ConnectTimeout("timeout", request=request)
        code, txn_status, amount = conf
        data = {
            "vnp_ResponseId": uuid.uuid4().hex,
            "vnp_Command": "querydr",
            "vnp_ResponseCode": code,
            "vnp_Message": "ok",
            "vnp_TmnCode": TMN,
            "vnp_TxnRef": ref,
            "vnp_Amount": str(int(amount * 100)) if amount else "",
            "vnp_BankCode": "NCB",
            "vnp_PayDate": "20261112100000",
            "vnp_TransactionNo": "14000001",
            "vnp_TransactionType": "01",
            "vnp_TransactionStatus": txn_status,
            "vnp_OrderInfo": body["vnp_OrderInfo"],
        }
        data["vnp_SecureHash"] = vnpay.sign_querydr_response(data)
        if state.get("_bad_hash"):
            data["vnp_SecureHash"] = "0" * 128
        return httpx.Response(200, json=data)

    monkeypatch.setattr(vnpay, "HTTP_TRANSPORT", httpx.MockTransport(handler))
    return {"state": state, "calls": calls}


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def ctx(client, seed):
    return {
        "supervisor": login(client, "supervisor_test"),
        "cashier": login(client, "cashier_test"),
        "waiter": login(client, "waiter_test"),
    }


def _billing_order(client, seed, ctx, quantity=4):
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
    client.post(f"/api/v1/orders/{order_id}/request-billing", headers={**waiter, **_key()})
    return order_id


def _link(client, ctx, order_id, **body):
    resp = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "VNPAY", **body},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _return_params(payment_id, amount, response_code="00", txn_status="00"):
    params = {
        "vnp_Amount": str(int(Decimal(amount) * 100)),
        "vnp_BankCode": "NCB",
        "vnp_OrderInfo": "Thanh toan don",
        "vnp_PayDate": "20261112100000",
        "vnp_ResponseCode": response_code,
        "vnp_TmnCode": TMN,
        "vnp_TransactionNo": "14000001",
        "vnp_TransactionStatus": txn_status,
        "vnp_TxnRef": uuid.UUID(payment_id).hex,
    }
    params["vnp_SecureHash"] = vnpay.sign_params(params)
    return params


def _order_status(client, ctx, order_id):
    return client.get(f"/api/v1/orders/{order_id}", headers=ctx["cashier"]).json()["status"]


def _ref(payment_id):
    return uuid.UUID(payment_id).hex


# --- Ký và kiểm chữ ký ----------------------------------------------------------


def test_payment_url_is_signed_and_tamper_proof(vnp):
    pid = uuid.uuid4()
    created = datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc)
    url, create_date, expires = vnpay.build_payment_url(
        pid, Decimal("200000"), "Thanh toan don abc123", "10.0.0.1", created
    )
    assert url.startswith("https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?")
    params = dict(parse_qsl(urlsplit(url).query))
    assert params["vnp_Amount"] == "20000000"
    assert params["vnp_TxnRef"] == pid.hex
    assert params["vnp_CreateDate"] == create_date == "20261112100000"  # giờ Việt Nam
    assert params["vnp_ExpireDate"] == "20261112101500"
    assert expires == created + timedelta(minutes=15)
    assert vnpay.verify_signature(params)
    assert not vnpay.verify_signature({**params, "vnp_Amount": "100"})
    assert not vnpay.verify_signature({k: v for k, v in params.items() if k != "vnp_SecureHash"})


def test_query_transaction_results(vnp):
    pid = uuid.uuid4()
    vnp["state"][pid.hex] = ("00", "00", 200000)
    paid = vnpay.query_transaction(pid, "20261112100000", "x")
    assert paid.status == vnpay.PAID and paid.amount == Decimal("200000")
    assert paid.txn_no == "14000001"
    vnp["state"][pid.hex] = ("00", "01", 200000)
    assert vnpay.query_transaction(pid, "20261112100000", "x").status == vnpay.PENDING
    vnp["state"][pid.hex] = ("91", "", 0)
    assert vnpay.query_transaction(pid, "20261112100000", "x").status == vnpay.NOT_FOUND
    vnp["state"][pid.hex] = "timeout"
    assert vnpay.query_transaction(pid, "20261112100000", "x").status == vnpay.ERROR
    vnp["state"][pid.hex] = ("00", "00", 200000)
    vnp["state"]["_bad_hash"] = True
    assert vnpay.query_transaction(pid, "20261112100000", "x").status == vnpay.ERROR


# --- Tạo link -------------------------------------------------------------------


def test_create_link_reserves_amount_and_reuses_link(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    first = _link(client, ctx, order_id)
    payment = first["payment"]
    assert payment["status"] == "PENDING" and payment["method"] == "VNPAY"
    assert payment["payment_url"].startswith("https://sandbox.vnpayment.vn/")
    assert Decimal(first["summary"]["pending"]) == Decimal("200000")
    assert Decimal(first["summary"]["remaining"]) == Decimal("200000")

    again = _link(client, ctx, order_id)
    assert again["payment"]["id"] == payment["id"]

    cash = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH"},
        headers={**ctx["cashier"], **_key()},
    )
    assert cash.status_code == 409 and "VNPay" in cash.json()["detail"]
    pay = client.post(f"/api/v1/orders/{order_id}/pay", headers={**ctx["cashier"], **_key()})
    assert pay.status_code == 409


def test_partial_link_then_cash_for_rest(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    _link(client, ctx, order_id, amount="50000")
    cash = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH"},
        headers={**ctx["cashier"], **_key()},
    )
    assert cash.status_code == 201, cash.text
    assert Decimal(cash.json()["payment"]["amount"]) == Decimal("150000")
    assert cash.json()["order_status"] == "BILLING"


def test_link_requires_configuration(client, seed, ctx, monkeypatch):
    monkeypatch.setattr(config, "VNPAY_TMN_CODE", "")
    order_id = _billing_order(client, seed, ctx)
    resp = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "VNPAY"},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 503
    assert resp.json()["detail"] == "VNPay chưa được cấu hình"


# --- Return URL -----------------------------------------------------------------


def test_return_success_confirms_with_querydr_once(client, seed, ctx, vnp, db_session_factory):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    vnp["state"][_ref(payment["id"])] = ("00", "00", 200000)
    params = _return_params(payment["id"], 200000)

    resp = client.get("/api/v1/payments/vnpay/return", params=params)
    assert resp.status_code == 200
    assert "Thanh toán thành công" in resp.text and "200.000đ" in resp.text
    assert order_id not in resp.text
    assert _order_status(client, ctx, order_id) == "PAID"

    again = client.get("/api/v1/payments/vnpay/return", params=params)
    assert "Thanh toán thành công" in again.text
    session = db_session_factory()
    assert session.query(AuditLog).filter_by(action="ORDER_PAID").count() == 1
    stored = session.get(Payment, uuid.UUID(payment["id"]))
    assert stored.status == "SUCCEEDED" and stored.provider_txn_no == "14000001"
    session.close()


def test_return_does_not_trust_url_without_querydr(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    # URL báo thành công nhưng VNPay (QueryDR) nói chưa hoàn tất.
    vnp["state"][_ref(payment["id"])] = ("00", "01", 200000)
    resp = client.get(
        "/api/v1/payments/vnpay/return", params=_return_params(payment["id"], 200000)
    )
    assert "chưa hoàn tất" in resp.text
    assert _order_status(client, ctx, order_id) == "BILLING"


def test_tampered_return_is_rejected(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    vnp["state"][_ref(payment["id"])] = ("00", "00", 200000)
    params = _return_params(payment["id"], 200000)
    params["vnp_Amount"] = "100"
    resp = client.get("/api/v1/payments/vnpay/return", params=params)
    assert resp.status_code == 400 and "không hợp lệ" in resp.text
    assert vnp["calls"] == []
    assert _order_status(client, ctx, order_id) == "BILLING"


def test_failed_payment_allows_new_link(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    vnp["state"][_ref(payment["id"])] = ("00", "02", 200000)
    resp = client.get(
        "/api/v1/payments/vnpay/return",
        params=_return_params(payment["id"], 200000, response_code="24", txn_status="02"),
    )
    assert "chưa hoàn tất" in resp.text
    listed = client.get(f"/api/v1/orders/{order_id}/payments", headers=ctx["cashier"]).json()
    assert listed["payments"][0]["status"] == "FAILED"
    assert _link(client, ctx, order_id)["payment"]["id"] != payment["id"]


def test_amount_mismatch_is_not_accepted(client, seed, ctx, vnp, db_session_factory):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    vnp["state"][_ref(payment["id"])] = ("00", "00", 100000)
    client.get("/api/v1/payments/vnpay/return", params=_return_params(payment["id"], 200000))
    assert _order_status(client, ctx, order_id) == "BILLING"
    session = db_session_factory()
    assert session.get(Payment, uuid.UUID(payment["id"])).status == "UNKNOWN"
    assert session.query(AuditLog).filter_by(action="PAYMENT_AMOUNT_MISMATCH").count() == 1
    session.close()


# --- Kiểm tra lại, hủy link -----------------------------------------------------


def test_check_endpoint(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    url = f"/api/v1/payments/{payment['id']}/check"

    assert client.post(url, headers={**ctx["waiter"], **_key()}).status_code == 403
    vnp["state"][_ref(payment["id"])] = ("00", "01", 200000)
    pending = client.post(url, headers={**ctx["cashier"], **_key()})
    assert pending.status_code == 200 and pending.json()["payment"]["status"] == "PENDING"

    vnp["state"][_ref(payment["id"])] = "timeout"
    assert client.post(url, headers={**ctx["cashier"], **_key()}).status_code == 502

    vnp["state"][_ref(payment["id"])] = ("00", "00", 200000)
    done = client.post(url, headers={**ctx["cashier"], **_key()})
    assert done.json()["payment"]["status"] == "SUCCEEDED"
    assert done.json()["order_status"] == "PAID"


def test_check_rejects_cash_payment(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    cash = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH", "amount": "10000"},
        headers={**ctx["cashier"], **_key()},
    ).json()["payment"]
    resp = client.post(
        f"/api/v1/payments/{cash['id']}/check", headers={**ctx["cashier"], **_key()}
    )
    assert resp.status_code == 409


def test_cashier_cancels_link_and_late_success_is_audited(
    client, seed, ctx, vnp, db_session_factory
):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    resp = client.post(
        f"/api/v1/payments/{payment['id']}/cancel",
        json={"reason": "Khách đổi sang tiền mặt"},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 200, resp.text
    paid_cash = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH"},
        headers={**ctx["cashier"], **_key()},
    )
    assert paid_cash.json()["order_status"] == "PAID"

    # Khách vẫn trả xong trên VNPay sau đó.
    vnp["state"][_ref(payment["id"])] = ("00", "00", 200000)
    client.get("/api/v1/payments/vnpay/return", params=_return_params(payment["id"], 200000))
    session = db_session_factory()
    assert session.get(Payment, uuid.UUID(payment["id"])).status == "CANCELLED"
    assert session.query(AuditLog).filter_by(action="PAYMENT_LATE_SUCCESS").count() == 1
    session.close()


def test_cashier_still_cannot_cancel_collected_payment(client, seed, ctx, vnp):
    order_id = _billing_order(client, seed, ctx)
    cash = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH", "amount": "10000"},
        headers={**ctx["cashier"], **_key()},
    ).json()["payment"]
    resp = client.post(
        f"/api/v1/payments/{cash['id']}/cancel",
        json={"reason": "Ghi nhầm"},
        headers={**ctx["cashier"], **_key()},
    )
    assert resp.status_code == 403


# --- Đối soát -------------------------------------------------------------------


def _reconcile_module():
    spec = importlib.util.spec_from_file_location(
        "reconcile_vnpay", Path(__file__).resolve().parent.parent / "scripts" / "reconcile_vnpay.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_reconcile_expires_unknowns_and_confirms(client, seed, ctx, vnp, db_session_factory):
    script = _reconcile_module()
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    pid = uuid.UUID(payment["id"])
    later = datetime.now(timezone.utc) + timedelta(minutes=20)

    session = db_session_factory()
    assert script.run(session, datetime.now(timezone.utc)) == {}  # còn hạn: chưa đụng

    vnp["state"][pid.hex] = "timeout"
    assert script.run(session, later) == {"UNKNOWN": 1}

    vnp["state"][pid.hex] = ("00", "00", 200000)
    assert script.run(session, later) == {"SUCCEEDED": 1}
    session.close()
    assert _order_status(client, ctx, order_id) == "PAID"


def test_reconcile_expires_abandoned_link(client, seed, ctx, vnp, db_session_factory):
    script = _reconcile_module()
    order_id = _billing_order(client, seed, ctx)
    _link(client, ctx, order_id)
    session = db_session_factory()
    later = datetime.now(timezone.utc) + timedelta(minutes=20)
    assert script.run(session, later) == {"EXPIRED": 1}
    session.close()
    # Hết hạn thì không giữ chỗ nữa: thu tiền mặt được.
    cash = client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": "CASH"},
        headers={**ctx["cashier"], **_key()},
    )
    assert cash.json()["order_status"] == "PAID"


# --- IPN ------------------------------------------------------------------------


def test_ipn_codes(client, seed, ctx, vnp, monkeypatch):
    order_id = _billing_order(client, seed, ctx)
    payment = _link(client, ctx, order_id)["payment"]
    params = _return_params(payment["id"], 200000)
    url = "/api/v1/payments/vnpay/ipn"

    assert client.get(url, params=params).json()["RspCode"] == "99"  # đang tắt
    monkeypatch.setattr(config, "VNPAY_IPN_ENABLED", True)

    assert client.get(url, params={**params, "vnp_Amount": "1"}).json()["RspCode"] == "97"
    wrong_amount = _return_params(payment["id"], 100000)
    assert client.get(url, params=wrong_amount).json()["RspCode"] == "04"
    unknown = _return_params(str(uuid.uuid4()), 200000)
    assert client.get(url, params=unknown).json()["RspCode"] == "01"

    assert client.get(url, params=params).json() == {
        "RspCode": "00",
        "Message": "Confirm Success",
    }
    assert _order_status(client, ctx, order_id) == "PAID"
    assert client.get(url, params=params).json()["RspCode"] == "02"
    assert vnp["calls"] == []  # IPN đã có chữ ký VNPay, không cần QueryDR
