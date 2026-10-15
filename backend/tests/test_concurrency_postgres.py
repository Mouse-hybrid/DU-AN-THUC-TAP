"""Hai request ghi đồng thời vào cùng 1 order — chỉ chạy được trên Postgres thật
(SQLite không có khóa dòng/advisory lock). CI đặt TEST_POSTGRES_URL tới service
Postgres của job `test`; chạy local thì bỏ qua.

QA TC-007: hai lần "gửi bếp" cùng lúc cho 1 order từng trả 200 + 503 (cùng
Idempotency-Key) hoặc tạo phiếu bếp trùng (khác key).
"""

from __future__ import annotations

import os
import threading

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.db.models import KitchenQueue, OrderItem, RestaurantTable
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
