"""Hai request ghi đồng thời vào cùng 1 order — chỉ chạy được trên Postgres thật
(SQLite không có khóa dòng/advisory lock). CI đặt TEST_POSTGRES_URL tới service
Postgres của job `test`; chạy local thì bỏ qua.

QA TC-007: hai lần "gửi bếp" cùng lúc cho 1 order từng trả 200 + 503 (cùng
Idempotency-Key) hoặc tạo phiếu bếp trùng (khác key).

BRD "No duplicate payment": hai thu ngân cùng bấm trả hết 1 đơn thì chỉ 1 lần được ghi.
"""

from __future__ import annotations

import os
import threading

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.db.models import KitchenQueue, OrderItem, Payment, RestaurantTable
from app.main import app
from tests.conftest import login

POSTGRES_URL = os.getenv("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not POSTGRES_URL, reason="cần TEST_POSTGRES_URL (Postgres thật)")

ROUNDS = 5


@pytest.fixture()
def db_session_factory():
    """Ghi đè fixture cùng tên trong conftest: dùng Postgres thay SQLite, để
    `client` và `seed` của conftest chạy trên Postgres."""
    engine = create_engine(POSTGRES_URL)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.drop_all(engine)
    engine.dispose()


def _order_with_item_on_new_table(client, seed, db_session_factory, prefix):
    session = db_session_factory()
    table = RestaurantTable(outlet_id=seed["outlet_id"], code=prefix, seats=4)
    session.add(table)
    session.commit()
    table_id = table.id
    session.close()

    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{table_id}/open-session",
        json={"guest_count": 2},
        headers={**waiter, "Idempotency-Key": f"{prefix}-open"},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders",
        json={"table_session_id": session_id},
        headers={**waiter, "Idempotency-Key": f"{prefix}-order"},
    ).json()["id"]
    client.post(
        f"/api/v1/orders/{order_id}/items",
        json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
        headers={**waiter, "Idempotency-Key": f"{prefix}-items"},
    )
    return order_id, waiter


def _send_concurrently(order_id, headers_list):
    """Bắn các request gửi bếp cùng lúc, mỗi request một TestClient/thread riêng."""
    barrier = threading.Barrier(len(headers_list))
    results: list[int] = [0] * len(headers_list)

    def worker(index, headers):
        local_client = TestClient(app)
        barrier.wait()
        resp = local_client.post(f"/api/v1/orders/{order_id}/send-to-kitchen", headers=headers)
        results[index] = resp.status_code

    threads = [threading.Thread(target=worker, args=(i, h)) for i, h in enumerate(headers_list)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return results


def _queue_entries(db_session_factory, order_id):
    session = db_session_factory()
    count = session.scalar(
        select(func.count())
        .select_from(KitchenQueue)
        .join(OrderItem, KitchenQueue.order_item_id == OrderItem.id)
        .where(OrderItem.order_id == order_id)
    )
    session.close()
    return count


def test_concurrent_send_with_same_key_replays_instead_of_503(client, seed, db_session_factory):
    for round_no in range(ROUNDS):
        order_id, waiter = _order_with_item_on_new_table(
            client, seed, db_session_factory, f"S{round_no}"
        )
        key = {**waiter, "Idempotency-Key": f"same-key-{round_no}"}
        statuses = _send_concurrently(order_id, [key, key])
        assert statuses == [200, 200], f"vòng {round_no}: {statuses}"
        assert _queue_entries(db_session_factory, order_id) == 1


def test_concurrent_send_with_different_keys_creates_one_ticket(client, seed, db_session_factory):
    for round_no in range(ROUNDS):
        order_id, waiter = _order_with_item_on_new_table(
            client, seed, db_session_factory, f"D{round_no}"
        )
        statuses = _send_concurrently(
            order_id,
            [
                {**waiter, "Idempotency-Key": f"diff-a-{round_no}"},
                {**waiter, "Idempotency-Key": f"diff-b-{round_no}"},
            ],
        )
        assert sorted(statuses) == [200, 409], f"vòng {round_no}: {statuses}"
        assert _queue_entries(db_session_factory, order_id) == 1


def test_concurrent_full_payments_record_only_one(client, seed, db_session_factory):
    cashier = login(client, "cashier_test")
    for round_no in range(ROUNDS):
        order_id, waiter = _order_with_item_on_new_table(
            client, seed, db_session_factory, f"P{round_no}"
        )
        client.post(
            f"/api/v1/orders/{order_id}/send-to-kitchen",
            headers={**waiter, "Idempotency-Key": f"pay-send-{round_no}"},
        )
        client.post(
            f"/api/v1/orders/{order_id}/request-billing",
            headers={**waiter, "Idempotency-Key": f"pay-bill-{round_no}"},
        )

        barrier = threading.Barrier(2)
        statuses: list[int] = [0, 0]

        def worker(index):
            local_client = TestClient(app)
            barrier.wait()
            resp = local_client.post(
                f"/api/v1/orders/{order_id}/payments",
                json={"method": "CASH"},
                headers={**cashier, "Idempotency-Key": f"pay-{round_no}-{index}"},
            )
            statuses[index] = resp.status_code

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert sorted(statuses) == [201, 409], f"vòng {round_no}: {statuses}"
        session = db_session_factory()
        count = session.scalar(
            select(func.count()).select_from(Payment).where(Payment.order_id == order_id)
        )
        session.close()
        assert count == 1


def _run_concurrently(calls):
    """Mỗi call là (method, path, json, headers); chạy cùng lúc, trả status theo thứ tự."""
    barrier = threading.Barrier(len(calls))
    statuses: list[int] = [0] * len(calls)

    def worker(index, method, path, body, headers):
        local_client = TestClient(app)
        barrier.wait()
        resp = local_client.request(method, path, json=body, headers=headers)
        statuses[index] = resp.status_code

    threads = [threading.Thread(target=worker, args=(i, *call)) for i, call in enumerate(calls)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return statuses


def _new_table(db_session_factory, seed, code):
    session = db_session_factory()
    table = RestaurantTable(outlet_id=seed["outlet_id"], code=code, seats=4)
    session.add(table)
    session.commit()
    table_id = table.id
    session.close()
    return table_id


def _table_id(db_session_factory, code):
    session = db_session_factory()
    table_id = session.scalar(select(RestaurantTable.id).where(RestaurantTable.code == code))
    session.close()
    return table_id


def _bill(client, order_id, waiter, prefix):
    client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": f"{prefix}-send"},
    )
    resp = client.post(
        f"/api/v1/orders/{order_id}/request-billing",
        headers={**waiter, "Idempotency-Key": f"{prefix}-bill"},
    )
    assert resp.status_code == 200, resp.text


def test_cross_merge_does_not_deadlock(client, seed, db_session_factory):
    for round_no in range(ROUNDS):
        _, waiter = _order_with_item_on_new_table(client, seed, db_session_factory, f"MA{round_no}")
        _order_with_item_on_new_table(client, seed, db_session_factory, f"MB{round_no}")
        a = _table_id(db_session_factory, f"MA{round_no}")
        b = _table_id(db_session_factory, f"MB{round_no}")
        statuses = _run_concurrently(
            [
                (
                    "POST",
                    f"/api/v1/tables/{a}/merge",
                    {"table_ids": [str(b)]},
                    {**waiter, "Idempotency-Key": f"merge-ab-{round_no}"},
                ),
                (
                    "POST",
                    f"/api/v1/tables/{b}/merge",
                    {"table_ids": [str(a)]},
                    {**waiter, "Idempotency-Key": f"merge-ba-{round_no}"},
                ),
            ]
        )
        assert sorted(statuses) == [200, 409], f"vòng {round_no}: {statuses}"


def test_two_transfers_into_same_empty_table(client, seed, db_session_factory):
    for round_no in range(ROUNDS):
        _, waiter = _order_with_item_on_new_table(client, seed, db_session_factory, f"TA{round_no}")
        _order_with_item_on_new_table(client, seed, db_session_factory, f"TB{round_no}")
        target = _new_table(db_session_factory, seed, f"TC{round_no}")
        body = {"target_table_id": str(target)}
        statuses = _run_concurrently(
            [
                (
                    "POST",
                    f"/api/v1/tables/{_table_id(db_session_factory, code)}/transfer",
                    body,
                    {**waiter, "Idempotency-Key": f"tr-{code}"},
                )
                for code in (f"TA{round_no}", f"TB{round_no}")
            ]
        )
        assert sorted(statuses) == [200, 409], f"vòng {round_no}: {statuses}"


def test_two_orders_redeeming_same_points_only_one_pays(client, seed, db_session_factory):
    supervisor = login(client, "supervisor_test")
    cashier = login(client, "cashier_test")
    client.post(
        "/api/v1/loyalty-rules",
        json={
            "earn_amount_per_point": "10000",
            "redeem_value_per_point": "100",
            "max_redeem_percent": 50,
        },
        headers={**supervisor, "Idempotency-Key": "rule-1"},
    )
    reward = client.post(
        "/api/v1/rewards",
        json={"name": "Doi diem", "reward_type": "POINTS"},
        headers={**supervisor, "Idempotency-Key": "reward-1"},
    ).json()
    for round_no in range(ROUNDS):
        customer = client.post(
            "/api/v1/customers",
            json={"phone": f"09000000{round_no:02d}", "consent": True},
            headers={**cashier, "Idempotency-Key": f"cust-{round_no}"},
        ).json()
        client.post(
            f"/api/v1/customers/{customer['id']}/points/adjust",
            json={"points": 300, "reason": "test"},
            headers={**supervisor, "Idempotency-Key": f"adj-{round_no}"},
        )
        orders = []
        for side in "XY":
            order_id, waiter = _order_with_item_on_new_table(
                client, seed, db_session_factory, f"R{side}{round_no}"
            )
            client.post(
                f"/api/v1/orders/{order_id}/customer",
                json={"customer_id": customer["id"]},
                headers={**cashier, "Idempotency-Key": f"att-{side}{round_no}"},
            )
            applied = client.post(
                f"/api/v1/orders/{order_id}/rewards",
                json={"reward_id": reward["id"], "points": 200},
                headers={**cashier, "Idempotency-Key": f"app-{side}{round_no}"},
            )
            assert applied.status_code == 201, applied.text
            _bill(client, order_id, waiter, f"r{side}{round_no}")
            orders.append(order_id)
        statuses = _run_concurrently(
            [
                (
                    "POST",
                    f"/api/v1/orders/{order_id}/payments",
                    {"method": "CASH"},
                    {**cashier, "Idempotency-Key": f"rp-{order_id}"},
                )
                for order_id in orders
            ]
        )
        assert sorted(statuses) == [201, 409], f"vòng {round_no}: {statuses}"
        balance = client.get(f"/api/v1/customers/{customer['id']}", headers=cashier).json()
        # 300 - 200 điểm đổi + điểm tích của đơn đã trả (50.000đ - 20.000đ = 3 điểm).
        assert balance["points_balance"] == 103, f"vòng {round_no}: {balance}"


def test_paying_split_bills_together_closes_session_once(client, seed, db_session_factory):
    cashier = login(client, "cashier_test")
    for round_no in range(ROUNDS):
        order_id, waiter = _order_with_item_on_new_table(
            client, seed, db_session_factory, f"SB{round_no}"
        )
        client.post(
            f"/api/v1/orders/{order_id}/items",
            json={"items": [{"menu_item_id": str(seed["menu_item_id"]), "quantity": 1}]},
            headers={**waiter, "Idempotency-Key": f"sb-more-{round_no}"},
        )
        detail = client.get(f"/api/v1/orders/{order_id}", headers=waiter).json()
        split = client.post(
            f"/api/v1/orders/{order_id}/split",
            json={"items": [{"order_item_id": detail["items"][-1]["id"], "quantity": 1}]},
            headers={**waiter, "Idempotency-Key": f"sb-split-{round_no}"},
        )
        assert split.status_code == 201, split.text
        new_id = split.json()["new_order"]["id"]
        # Gửi bếp cả hai đơn trước: bàn sang BILLING rồi thì không gửi bếp thêm được.
        for oid, tag in ((order_id, "a"), (new_id, "b")):
            client.post(
                f"/api/v1/orders/{oid}/send-to-kitchen",
                headers={**waiter, "Idempotency-Key": f"sb-send-{tag}{round_no}"},
            )
        for oid, tag in ((order_id, "a"), (new_id, "b")):
            resp = client.post(
                f"/api/v1/orders/{oid}/request-billing",
                headers={**waiter, "Idempotency-Key": f"sb-bill-{tag}{round_no}"},
            )
            assert resp.status_code == 200, resp.text
        statuses = _run_concurrently(
            [
                (
                    "POST",
                    f"/api/v1/orders/{oid}/payments",
                    {"method": "CARD"},
                    {**cashier, "Idempotency-Key": f"sbp-{oid}"},
                )
                for oid in (order_id, new_id)
            ]
        )
        assert statuses == [201, 201], f"vòng {round_no}: {statuses}"
        session = db_session_factory()
        table = session.scalar(
            select(RestaurantTable).where(RestaurantTable.code == f"SB{round_no}")
        )
        assert table.status == "CLEANING", f"vòng {round_no}: bàn {table.status}"
        session.close()
