"""scripts/reset_staging_data.py — dọn dữ liệu giao dịch, giữ menu/tài khoản,
và tạo fixture cho QA (refire, SLA bếp)."""

from __future__ import annotations

import importlib.util
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.db.models import (
    AuditLog,
    IdempotencyKey,
    KitchenQueue,
    MenuCategory,
    MenuItem,
    Order,
    RestaurantTable,
    Staff,
    TableSession,
)
from tests.conftest import login

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "reset_staging_data.py"
_spec = importlib.util.spec_from_file_location("reset_staging_data", _SCRIPT)
reset = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = reset  # @dataclass cần tìm thấy module khi exec
_spec.loader.exec_module(reset)


def _count(session, model):
    return session.scalar(select(func.count()).select_from(model))


def _run_dine_in_flow(client, seed, prefix):
    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
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
    client.post(
        f"/api/v1/orders/{order_id}/send-to-kitchen",
        headers={**waiter, "Idempotency-Key": f"{prefix}-send"},
    )


def _add_fixture_tables_and_menu(db_session_factory, seed):
    session = db_session_factory()
    for code in ("B5", "B6"):
        session.add(RestaurantTable(outlet_id=seed["outlet_id"], code=code, seats=6))
    for name in ("Mon B", "Mon C"):
        session.add(
            MenuItem(
                outlet_id=seed["outlet_id"],
                station_id=seed["station_id"],
                name=name,
                price=Decimal("30000.00"),
            )
        )
    session.commit()
    session.close()


def test_dry_run_changes_nothing(client, seed, db_session_factory):
    _run_dine_in_flow(client, seed, "dry")
    session = db_session_factory()
    result = reset.run(session, apply=False, with_fixtures=False)
    session.close()

    assert result.deleted["order"] == 1
    assert result.tables_reset == 1
    session = db_session_factory()
    assert _count(session, Order) == 1
    assert session.get(RestaurantTable, seed["table_id"]).status == "OCCUPIED"
    session.close()


def test_reset_wipes_transactions_and_keeps_master_data(client, seed, db_session_factory):
    _run_dine_in_flow(client, seed, "wipe")
    session = db_session_factory()
    session.get(MenuItem, seed["menu_item_id"]).is_available = False
    session.commit()
    audit_before = _count(session, AuditLog)

    result = reset.run(session, apply=True, with_fixtures=False)
    session.close()

    assert result.deleted["order"] == 1
    assert result.deleted["kitchen_queue"] == 1
    session = db_session_factory()
    for model in (Order, TableSession, KitchenQueue, IdempotencyKey):
        assert _count(session, model) == 0
    assert session.get(RestaurantTable, seed["table_id"]).status == "AVAILABLE"
    assert session.get(MenuItem, seed["menu_item_id"]).is_available is True
    assert _count(session, Staff) == 4
    assert _count(session, AuditLog) == audit_before + 1
    assert session.scalar(select(AuditLog.action).order_by(AuditLog.created_at.desc()).limit(1))
    session.close()

    # Sau reset luồng nghiệp vụ chạy lại bình thường, kể cả dùng lại Idempotency-Key cũ.
    _run_dine_in_flow(client, seed, "wipe")
    assert client.get("/api/v1/orders", headers=login(client, "cashier_test")).json()


def test_fixtures_cover_refire_and_kitchen_sla(client, seed, db_session_factory):
    _add_fixture_tables_and_menu(db_session_factory, seed)
    session = db_session_factory()
    result = reset.run(session, apply=True, with_fixtures=True)
    session.close()
    assert any("B6" in line for line in result.fixtures)

    kitchen = login(client, "kitchen_test")
    supervisor = login(client, "supervisor_test")
    queue = client.get("/api/v1/kitchen/queue", headers=kitchen).json()
    assert sorted(e["sla_status"] for e in queue) == ["CRITICAL", "NORMAL", "WARNING"]
    assert {e["table_code"] for e in queue} == {"B5"}

    served = client.get("/api/v1/orders?status=SERVED", headers=supervisor).json()
    assert [o["table_code"] for o in served] == ["B6"]
    order_id = served[0]["id"]
    item_id = client.get(f"/api/v1/orders/{order_id}", headers=supervisor).json()["items"][0]["id"]
    refire = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/refire",
        headers={**supervisor, "Idempotency-Key": "fx-refire"},
    )
    assert refire.status_code == 200, refire.text
    start = client.post(
        f"/api/v1/orders/{order_id}/items/{item_id}/start-cooking",
        headers={**kitchen, "Idempotency-Key": "fx-start"},
    )
    assert start.status_code == 200, start.text

    tables = {t["code"]: t["status"] for t in client.get("/api/v1/tables", headers=kitchen).json()}
    assert tables["T1"] == "AVAILABLE"
    assert tables["B5"] == tables["B6"] == "OCCUPIED"


@pytest.mark.parametrize("app_env", ["production", "prod", ""])
def test_refuses_non_test_environments(app_env):
    with pytest.raises(SystemExit):
        reset.ensure_env_allowed(app_env)


def test_allows_staging():
    reset.ensure_env_allowed("staging")


_SEED = Path(__file__).resolve().parent.parent / "scripts" / "seed_dev_data.py"
_seed_spec = importlib.util.spec_from_file_location("seed_dev_data", _SEED)
seed_script = importlib.util.module_from_spec(_seed_spec)
sys.modules[_seed_spec.name] = seed_script
_seed_spec.loader.exec_module(seed_script)


def test_qa_second_outlet_has_no_menu_and_is_isolated(client, seed, db_session_factory):
    """TC_API_03_004 (chi nhánh không có menu) + TC_EXT_019 (truy cập chéo chi nhánh)."""
    _add_fixture_tables_and_menu(db_session_factory, seed)
    session = db_session_factory()
    seed_script._ensure_qa_second_outlet(session, "password123", True)
    seed_script._ensure_qa_second_outlet(session, "password123", True)  # chạy lại không trùng
    session.commit()
    result = reset.run(session, apply=True, with_fixtures=True)
    session.close()
    q2_line = next(line for line in result.fixtures if line.startswith("Q2-1"))
    q2_order_id = q2_line.rsplit("order_id=", 1)[1]

    qa2 = login(client, "qa2_admin")
    assert client.get("/api/v1/menu", headers=qa2).json() == []
    assert [o["id"] for o in client.get("/api/v1/orders", headers=qa2).json()] == [q2_order_id]
    assert [t["code"] for t in client.get("/api/v1/tables", headers=qa2).json()] == ["Q2-1"]

    outlet1 = login(client, "supervisor_test")
    assert client.get(f"/api/v1/orders/{q2_order_id}", headers=outlet1).status_code == 404
    assert q2_order_id not in {
        o["id"] for o in client.get("/api/v1/orders", headers=outlet1).json()
    }
    assert login(client, "qa2_cashier")


def _add_menu_with_qa_items(db_session_factory, seed):
    """Menu mẫu (tên trùng SEED_MENU) lẫn món/nhóm do test QA tạo qua POST /menu."""
    session = db_session_factory()
    main_dishes = MenuCategory(outlet_id=seed["outlet_id"], name="Món chính", sort_order=2)
    qa_category = MenuCategory(outlet_id=seed["outlet_id"], name="DES06-QA-CAT", sort_order=9)
    # Nhóm lạ nhưng có món mẫu: giữ lại, không làm món mẫu mất nhóm.
    shared = MenuCategory(outlet_id=seed["outlet_id"], name="QA nhóm có món mẫu", sort_order=8)
    session.add_all([main_dishes, qa_category, shared])
    session.flush()
    rows = (
        ("Phở bò", main_dishes.id),
        ("Bún chả", shared.id),
        ("DES05-QA-UNMAPPED-1", None),
        ("DES06-QA-ITEM-1", qa_category.id),
    )
    for name, category_id in rows:
        session.add(
            MenuItem(
                outlet_id=seed["outlet_id"],
                station_id=seed["station_id"],
                category_id=category_id,
                name=name,
                price=Decimal("10000.00"),
            )
        )
    session.commit()
    session.close()


def _menu_names(session):
    return set(session.scalars(select(MenuItem.name)))


def test_purge_extra_menu_dry_run_lists_without_deleting(client, seed, db_session_factory):
    _add_menu_with_qa_items(db_session_factory, seed)
    session = db_session_factory()
    before = _menu_names(session)

    result = reset.run(session, apply=False, with_fixtures=False, purge_menu=True)

    assert result.menu_items_purged == ["DES05-QA-UNMAPPED-1", "DES06-QA-ITEM-1", "Mon Test"]
    assert result.categories_purged == ["DES06-QA-CAT"]
    assert _menu_names(session) == before
    session.close()


def test_purge_extra_menu_keeps_only_seed_menu(client, seed, db_session_factory):
    _add_menu_with_qa_items(db_session_factory, seed)
    # Món QA đang nằm trong một đơn: reset xóa đơn trước, rồi mới xóa được món.
    _run_dine_in_flow(client, seed, "purge")
    session = db_session_factory()

    result = reset.run(session, apply=True, with_fixtures=False, purge_menu=True)
    session.close()

    assert "Mon Test" in result.menu_items_purged
    session = db_session_factory()
    assert _menu_names(session) == {"Phở bò", "Bún chả"}
    assert set(session.scalars(select(MenuCategory.name))) == {
        "Món chính",
        "QA nhóm có món mẫu",
    }
    payload = session.scalar(
        select(AuditLog.payload).where(AuditLog.action == "STAGING_DATA_RESET")
    )
    assert "DES06-QA-ITEM-1" in str(payload)
    session.close()


def test_reset_without_purge_keeps_qa_menu(client, seed, db_session_factory):
    _add_menu_with_qa_items(db_session_factory, seed)
    session = db_session_factory()
    reset.run(session, apply=True, with_fixtures=False)
    session.close()
    session = db_session_factory()
    assert "DES06-QA-ITEM-1" in _menu_names(session)
    session.close()


def test_qa_third_outlet_runs_full_flow_and_has_sold_out_fixture(client, seed, db_session_factory):
    """Chi nhánh QA 3: đủ menu mẫu, 2 trạm, 4 vai; reset --with-fixtures đặt 1 món hết hàng.
    Menu QA 3 trùng tên menu mẫu nên --purge-extra-menu không xóa."""
    _add_fixture_tables_and_menu(db_session_factory, seed)
    session = db_session_factory()
    seed_script._ensure_qa_third_outlet(session, "password123", True)
    seed_script._ensure_qa_third_outlet(session, "password123", True)  # chạy lại không trùng
    session.commit()
    preview = reset.run(session, apply=False, with_fixtures=False, purge_menu=True)
    result = reset.run(session, apply=True, with_fixtures=True)
    session.close()

    qa3_names = {
        name for _order, dishes in seed_script.SEED_MENU.values() for name, _p, _s in dishes
    }
    assert not qa3_names & set(preview.menu_items_purged)
    assert any("Nước cam" in line and "QA 3" in line for line in result.fixtures)

    waiter = login(client, "qa3_waiter")
    menu = {m["name"]: m["is_available"] for m in client.get("/api/v1/menu", headers=waiter).json()}
    assert set(menu) == qa3_names
    assert menu[seed_script.QA3_SOLD_OUT_ITEM] is False
    tables = {t["code"] for t in client.get("/api/v1/tables", headers=waiter).json()}
    assert tables == {"Q3-1", "Q3-2", "Q3-3"}

    kitchen = login(client, "qa3_kitchen")
    stations = client.get("/api/v1/kitchen/stations", headers=kitchen).json()
    assert {s["name"] for s in stations} == set(seed_script.SEED_STATIONS)
    assert login(client, "qa3_admin") and login(client, "qa3_cashier")

    # Cách ly: tài khoản chi nhánh test không thấy bàn của QA 3.
    outlet1 = login(client, "supervisor_test")
    codes = {t["code"] for t in client.get("/api/v1/tables", headers=outlet1).json()}
    assert not codes & tables
