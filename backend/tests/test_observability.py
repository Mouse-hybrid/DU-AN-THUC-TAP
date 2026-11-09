"""Giám sát (SDD R3): request_id, số đo API theo mẫu route, log JSON, lọc dữ liệu gửi Sentry,
báo cáo GET /ops/metrics và cảnh báo."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.api.v1 import ops
from app.core.observability import JsonFormatter, metrics, request_id_var, scrub_event
from app.db.models import KitchenQueue, OrderItem, Payment
from app.main import app
from tests.conftest import login


@pytest.fixture(autouse=True)
def _fresh_metrics():
    metrics.reset()
    yield
    metrics.reset()


def test_request_id_is_generated_and_echoed(client):
    resp = client.get("/api/v1/menu/items")
    generated = resp.headers["X-Request-ID"]
    assert len(generated) == 32

    resp = client.get("/api/v1/menu/items", headers={"X-Request-ID": "fe-abc-123"})
    assert resp.headers["X-Request-ID"] == "fe-abc-123"

    resp = client.get("/api/v1/menu/items", headers={"X-Request-ID": "bad id <script>"})
    assert resp.headers["X-Request-ID"] != "bad id <script>"


def test_metrics_use_route_template_not_real_path(client):
    client.get("/api/v1/public/qr/secret-token-123/menu")
    client.get("/api/v1/khong-co-route-nay")
    client.get("/health")
    routes = {r["route"] for r in metrics.snapshot()["routes"]}
    assert "GET /api/v1/public/qr/{token}/menu" in routes
    assert "GET <unmatched>" in routes
    assert not any("secret-token-123" in r for r in routes)
    assert not any("/health" in r for r in routes)


def test_unhandled_error_returns_request_id(client, seed, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("lỗi giả lập")

    monkeypatch.setattr(ops, "_kitchen", boom)
    headers = login(client, "supervisor_test")
    # Fixture `client` đã trỏ app vào DB test; client riêng để nhận response 500 thay vì ném lỗi.
    raw = TestClient(app, raise_server_exceptions=False)
    resp = raw.get("/api/v1/ops/metrics", headers={**headers, "X-Request-ID": "trace-500"})
    assert resp.status_code == 500
    assert resp.json()["request_id"] == "trace-500"
    assert resp.headers["X-Request-ID"] == "trace-500"
    assert "lỗi giả lập" not in resp.text
    server_errors = [r for r in metrics.snapshot()["routes"] if r["server_errors"]]
    assert [r["route"] for r in server_errors] == ["GET /api/v1/ops/metrics"]


def test_json_formatter_includes_request_id_and_fields():
    token = request_id_var.set("req-1")
    try:
        record = logging.LogRecord("app.access", logging.INFO, __file__, 1, "request", None, None)
        record.fields = {"route": "GET /x", "status": 200}
        line = json.loads(JsonFormatter().format(record))
    finally:
        request_id_var.reset(token)
    assert line["request_id"] == "req-1"
    assert line["route"] == "GET /x" and line["status"] == 200
    assert line["level"] == "INFO"


def test_scrub_event_removes_sensitive_data():
    event = {
        "request": {
            "url": "http://pos/api/v1/public/qr/abcDEF123/items",
            "data": {"password": "x"},
            "cookies": {"a": "b"},
            "query_string": "token=1",
            "headers": {"Authorization": "Bearer t", "Idempotency-Key": "k", "Accept": "*/*"},
        },
        "transaction": "/api/v1/public/qr/abcDEF123/items",
        "exception": {"values": [{"value": "Khách 0901234567 không hợp lệ"}]},
    }
    token = request_id_var.set("req-2")
    try:
        out = scrub_event(event)
    finally:
        request_id_var.reset(token)
    request = out["request"]
    assert "data" not in request and "cookies" not in request and "query_string" not in request
    assert request["headers"]["Authorization"] == "[filtered]"
    assert request["headers"]["Idempotency-Key"] == "[filtered]"
    assert request["headers"]["Accept"] == "*/*"
    assert "abcDEF123" not in request["url"] and "abcDEF123" not in out["transaction"]
    assert "0901234567" not in out["exception"]["values"][0]["value"]
    assert out["tags"]["request_id"] == "req-2"


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _cooked_item(client, seed, waiter):
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
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}] * 3},
        headers={**waiter, **_key()},
    )
    client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers={**waiter, **_key()})
    return order_id


def test_ops_metrics_kitchen_and_payments(client, seed, db_session_factory):
    supervisor = login(client, "supervisor_test")
    order_id = _cooked_item(client, seed, login(client, "waiter_test"))

    now = datetime.now(timezone.utc)
    session = db_session_factory()
    entries = (
        session.query(KitchenQueue)
        .join(OrderItem, KitchenQueue.order_item_id == OrderItem.id)
        .filter(OrderItem.order_id == uuid.UUID(order_id))
        .all()
    )
    assert len(entries) == 3
    # Món 1 nấu 5 phút (đúng hạn), món 2 nấu 20 phút (trễ), món 3 đang nấu 30 phút.
    fast, slow, cooking = entries
    fast.status, fast.started_at, fast.done_at = "DONE", now - timedelta(minutes=6), now
    slow.status, slow.started_at, slow.done_at = "DONE", now - timedelta(minutes=21), now
    cooking.status, cooking.started_at = "IN_PROGRESS", now - timedelta(minutes=30)
    outlet_id = seed["outlet_id"]
    for status, amount in (("SUCCEEDED", "100"), ("SUCCEEDED", "50"), ("FAILED", "10")):
        session.add(
            Payment(
                order_id=uuid.UUID(order_id),
                outlet_id=outlet_id,
                method="CASH",
                amount=Decimal(amount),
                status=status,
            )
        )
    session.add(
        Payment(
            order_id=uuid.UUID(order_id),
            outlet_id=outlet_id,
            method="CASH",
            amount=Decimal("5"),
            status="CANCELLED",
        )
    )
    session.commit()
    session.close()

    resp = client.get("/api/v1/ops/metrics", headers=supervisor)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kitchen"] == {
        "late_after_minutes": 12,
        "finished": 2,
        "late": 1,
        "late_rate": 0.5,
        "cooking_over_threshold": 1,
    }
    assert body["payments"]["succeeded"] == 2
    assert body["payments"]["failed"] == 1
    assert body["payments"]["success_rate"] == pytest.approx(0.6667)
    assert body["payments"]["by_status"]["CANCELLED"] == 1
    assert body["api"]["requests"] > 0
    # Dưới ALERT_MIN_SAMPLES nên chưa cảnh báo.
    assert body["alerts"] == []


def test_ops_metrics_alerts_when_thresholds_crossed(client, seed, monkeypatch):
    monkeypatch.setattr(ops, "ALERT_MIN_SAMPLES", 1)
    for _ in range(3):
        metrics.record("GET /api/v1/x", 500, 10.0)
    metrics.record("GET /api/v1/x", 200, 10.0)
    resp = client.get("/api/v1/ops/metrics", headers=login(client, "supervisor_test"))
    codes = [a["code"] for a in resp.json()["alerts"]]
    assert "API_ERROR_RATE" in codes


def test_ops_metrics_is_supervisor_only(client, seed):
    resp = client.get("/api/v1/ops/metrics", headers=login(client, "cashier_test"))
    assert resp.status_code == 403
    assert client.get("/api/v1/ops/metrics").status_code == 401
