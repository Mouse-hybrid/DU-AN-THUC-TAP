"""Fixture dùng chung cho test vertical slice: DB SQLite in-memory riêng cho
mỗi test (cô lập hoàn toàn, không đụng tới DB thật/staging), override
`get_session` của app để trỏ vào DB test này, và seed sẵn 1 bộ dữ liệu tối
thiểu (outlet, 3 staff theo role khác nhau, 1 bàn, 1 kitchen_station, 1 menu_item).
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.base import Base, get_session
from app.db.models import KitchenStation, MenuItem, Outlet, RestaurantTable, Staff
from app.main import app

SEED_PASSWORD = "password123"


@pytest.fixture()
def db_session_factory():
    """1 engine SQLite in-memory riêng/test, dùng StaticPool để mọi session
    (kể cả session mở trong fixture `seed` lẫn session request qua API) đều
    thấy CHUNG 1 database — mặc định SQLite in-memory mỗi connection là 1 DB
    riêng, StaticPool bắt buộc tái dùng đúng 1 connection.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    testing_session_local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    yield testing_session_local
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture()
def client(db_session_factory):
    def _override_get_session():
        session = db_session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_session] = _override_get_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def seed(db_session_factory):
    """Seed trực tiếp qua ORM (không qua API) — nhanh và tách biệt khỏi API
    đang được test. Trả về dict id để test dùng.
    """
    session = db_session_factory()

    outlet = Outlet(name="Outlet Test")
    session.add(outlet)
    session.flush()

    staff_by_role = {}
    for role, username in (
        ("SUPERVISOR", "supervisor_test"),
        ("CASHIER", "cashier_test"),
        ("WAITER", "waiter_test"),
        ("KITCHEN", "kitchen_test"),
    ):
        staff = Staff(
            outlet_id=outlet.id,
            username=username,
            password_hash=hash_password(SEED_PASSWORD),
            full_name=f"{role} Test",
            role=role,
        )
        session.add(staff)
        session.flush()
        staff_by_role[role] = staff.id

    station = KitchenStation(outlet_id=outlet.id, name="Station Test")
    session.add(station)
    session.flush()

    menu_item = MenuItem(
        outlet_id=outlet.id, station_id=station.id, name="Mon Test", price=Decimal("50000.00")
    )
    session.add(menu_item)
    session.flush()

    table = RestaurantTable(outlet_id=outlet.id, code="T1", seats=4, status="AVAILABLE")
    session.add(table)
    session.flush()

    session.commit()

    data = {
        "outlet_id": outlet.id,
        "staff_ids": staff_by_role,
        "station_id": station.id,
        "menu_item_id": menu_item.id,
        "table_id": table.id,
    }
    session.close()
    return data


def login(client: TestClient, username: str, password: str = SEED_PASSWORD) -> dict[str, str]:
    """Helper login + trả sẵn Authorization header, dùng chung cho các test file."""
    resp = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}
