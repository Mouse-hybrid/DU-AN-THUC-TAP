"""Báo cáo audit: tổng hợp theo thao tác, nhân viên, ngày giờ Việt Nam, thao tác ngoại lệ;
xuất CSV; danh sách có tổng số và sắp mới nhất trước; chỉ trong outlet của mình."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.api.v1 import audit as audit_api
from app.db.models import AuditLog, Outlet
from tests.conftest import login

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def _log(session, seed, action, staff=None, at=None, payload=None, outlet_id=None):
    session.add(
        AuditLog(
            outlet_id=outlet_id or seed["outlet_id"],
            staff_id=seed["staff_ids"][staff] if staff else None,
            action=action,
            entity_type="order",
            entity_id=str(uuid.uuid4()),
            payload=payload,
            created_at=at or NOW - timedelta(hours=1),
        )
    )


@pytest.fixture()
def logs(seed, db_session_factory):
    session = db_session_factory()
    _log(session, seed, "ORDER_CREATED", "WAITER")
    _log(session, seed, "ORDER_CREATED", "WAITER")
    _log(session, seed, "ORDER_ITEM_VOIDED", "SUPERVISOR")
    _log(session, seed, "ORDER_ITEMS_ADDED")  # khách QR, không có nhân viên
    _log(session, seed, "ORDER_PAID", "CASHIER", at=NOW - timedelta(days=30))  # ngoài 7 ngày
    other = Outlet(name="Outlet Khac")
    session.add(other)
    session.flush()
    _log(session, seed, "ORDER_ITEM_VOIDED", outlet_id=other.id)
    session.commit()
    session.close()


def _summary(client, **params):
    return client.get(
        "/api/v1/audit-logs/summary", params=params, headers=login(client, "supervisor_test")
    )


def test_summary_counts_by_action_staff_and_exceptions(client, seed, logs):
    resp = _summary(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 4  # đơn trả 30 ngày trước và outlet khác không tính
    assert body["exception_total"] == 1
    actions = {row["action"]: row for row in body["by_action"]}
    assert actions["ORDER_CREATED"]["count"] == 2
    assert actions["ORDER_ITEM_VOIDED"]["is_exception"] is True
    assert actions["ORDER_CREATED"]["is_exception"] is False
    assert body["by_action"][0]["action"] == "ORDER_CREATED"  # nhiều nhất trước

    staff = {row["username"]: row for row in body["by_staff"]}
    assert staff["waiter_test"]["count"] == 2
    assert staff["supervisor_test"]["exception_count"] == 1
    assert staff[None]["staff_id"] is None and staff[None]["count"] == 1


def test_summary_range_and_filters(client, seed, logs):
    wide = _summary(
        client,
        created_from=(NOW - timedelta(days=40)).isoformat(),
        created_to=NOW.isoformat(),
    ).json()
    assert wide["total"] == 5
    only_waiter = _summary(client, staff_id=str(seed["staff_ids"]["WAITER"])).json()
    assert only_waiter["total"] == 2
    only_void = _summary(client, action="ORDER_ITEM_VOIDED").json()
    assert only_void["total"] == 1

    too_long = _summary(
        client,
        created_from=(NOW - timedelta(days=100)).isoformat(),
        created_to=NOW.isoformat(),
    )
    assert too_long.status_code == 422
    backwards = _summary(
        client,
        created_from=NOW.isoformat(),
        created_to=(NOW - timedelta(days=1)).isoformat(),
    )
    assert backwards.status_code == 422


def test_days_are_grouped_in_vietnam_time(client, seed, db_session_factory):
    # 17:30 UTC ngày D là 00:30 ngày D+1 giờ Việt Nam.
    base = (NOW - timedelta(days=2)).replace(hour=17, minute=30, second=0)
    session = db_session_factory()
    _log(session, seed, "ORDER_CREATED", "WAITER", at=base - timedelta(hours=1))  # 23:30 ngày D
    _log(session, seed, "ORDER_CREATED", "WAITER", at=base)  # 00:30 ngày D+1
    session.commit()
    session.close()

    body = _summary(
        client,
        created_from=(base - timedelta(days=1)).isoformat(),
        created_to=(base + timedelta(days=1)).isoformat(),
    ).json()
    days = {row["date"]: row["count"] for row in body["by_day"]}
    assert days == {
        base.date().isoformat(): 1,
        (base.date() + timedelta(days=1)).isoformat(): 1,
    }


def test_list_total_header_and_newest_first(client, seed, logs):
    supervisor = login(client, "supervisor_test")
    resp = client.get("/api/v1/audit-logs?limit=2&sort=desc", headers=supervisor)
    assert resp.status_code == 200
    assert resp.headers["X-Total-Count"] == "5"
    rows = resp.json()
    assert len(rows) == 2
    assert rows[0]["created_at"] >= rows[1]["created_at"]
    oldest = client.get("/api/v1/audit-logs?limit=1", headers=supervisor).json()[0]
    assert oldest["action"] == "ORDER_PAID"
    assert client.get("/api/v1/audit-logs?sort=khac", headers=supervisor).status_code == 422


def test_export_csv(client, seed, logs, db_session_factory):
    session = db_session_factory()
    _log(session, seed, "POINTS_ADJUSTED", "SUPERVISOR", payload="=HYPERLINK(1)")
    session.commit()
    session.close()

    resp = client.get(
        "/api/v1/audit-logs/export?action=POINTS_ADJUSTED&action=ORDER_CREATED",
        headers=login(client, "supervisor_test"),
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"]
    assert resp.headers["X-Truncated"] == "false"
    text = resp.content.decode("utf-8")
    assert text.startswith("﻿")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    assert rows[0][:3] == ["created_at", "action", "exception"]
    assert len(rows) == 4  # tiêu đề + 2 tạo đơn + 1 điều chỉnh điểm
    adjusted = next(row for row in rows if row[1] == "POINTS_ADJUSTED")
    assert adjusted[2] == "x"
    assert adjusted[0].endswith("+07:00")
    assert adjusted[7] == "'=HYPERLINK(1)"


def test_export_is_capped(client, seed, logs, monkeypatch):
    monkeypatch.setattr(audit_api, "EXPORT_MAX_ROWS", 2)
    resp = client.get("/api/v1/audit-logs/export", headers=login(client, "supervisor_test"))
    assert resp.headers["X-Truncated"] == "true"
    assert len(resp.content.decode("utf-8").strip().splitlines()) == 3


def test_formula_cells_are_neutralised():
    assert audit_api._csv_cell("=SUM(A1)") == "'=SUM(A1)"
    assert audit_api._csv_cell("-1") == "'-1"
    assert audit_api._csv_cell("binh thuong") == "binh thuong"
    assert audit_api._csv_cell(None) == ""
