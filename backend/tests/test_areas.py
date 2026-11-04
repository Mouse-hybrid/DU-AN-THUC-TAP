"""Tầng/khu của nhà hàng: /api/v1/areas, gán bàn (PATCH /tables/{id}), lọc bàn theo khu,
seed không ghi đè bố trí đã cấu hình."""

from __future__ import annotations

import importlib.util
import sys
import uuid
from pathlib import Path

from app.core.security import hash_password
from app.db.models import AuditLog, Outlet, RestaurantTable, Staff
from tests.conftest import SEED_PASSWORD, login

_SEED_PATH = Path(__file__).resolve().parent.parent / "scripts" / "seed_dev_data.py"
_spec = importlib.util.spec_from_file_location("seed_dev_data_for_area_tests", _SEED_PATH)
seed_script = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = seed_script
_spec.loader.exec_module(seed_script)


def _create_area(client, headers, name="Tầng 1", key=None, **extra):
    return client.post(
        "/api/v1/areas",
        json={"name": name, **extra},
        headers={**headers, "Idempotency-Key": key or str(uuid.uuid4())},
    )


def _add_table(db_session_factory, seed, code, status="AVAILABLE"):
    session = db_session_factory()
    table = RestaurantTable(outlet_id=seed["outlet_id"], code=code, seats=4, status=status)
    session.add(table)
    session.commit()
    table_id = table.id
    session.close()
    return table_id


def test_area_overview_counts_tables_by_status(client, seed, db_session_factory):
    supervisor = login(client, "supervisor_test")
    area = _create_area(client, supervisor, sort_order=1).json()
    assert area["table_count"] == 0 and area["status_counts"] == {}
    busy_id = _add_table(db_session_factory, seed, "T2", status="OCCUPIED")

    for table_id in (seed["table_id"], busy_id):
        resp = client.patch(
            f"/api/v1/tables/{table_id}", json={"area_id": area["id"]}, headers=supervisor
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["area_name"] == "Tầng 1"

    waiter = login(client, "waiter_test")
    rows = client.get("/api/v1/areas", headers=waiter).json()
    assert rows[0]["table_count"] == 2
    assert rows[0]["status_counts"] == {"AVAILABLE": 1, "OCCUPIED": 1}


def test_tables_filter_and_show_area(client, seed, db_session_factory):
    supervisor = login(client, "supervisor_test")
    area = _create_area(client, supervisor).json()
    other_id = _add_table(db_session_factory, seed, "T2")
    client.patch(
        f"/api/v1/tables/{seed['table_id']}", json={"area_id": area["id"]}, headers=supervisor
    )

    everything = {t["code"]: t for t in client.get("/api/v1/tables", headers=supervisor).json()}
    assert everything["T1"]["area_name"] == "Tầng 1"
    assert everything["T2"]["area_id"] is None

    filtered = client.get(f"/api/v1/tables?area_id={area['id']}", headers=supervisor).json()
    assert [t["code"] for t in filtered] == ["T1"]
    detail = client.get(f"/api/v1/tables/{seed['table_id']}", headers=supervisor).json()
    assert detail["area_id"] == area["id"]

    removed = client.patch(
        f"/api/v1/tables/{seed['table_id']}", json={"area_id": None}, headers=supervisor
    )
    assert removed.json()["area_id"] is None
    missing = client.patch(f"/api/v1/tables/{other_id}", json={}, headers=supervisor)
    assert missing.status_code == 422


def test_tables_sorted_by_number_in_code(client, seed, db_session_factory):
    for code in ("T10", "T2"):
        _add_table(db_session_factory, seed, code)
    rows = client.get("/api/v1/tables", headers=login(client, "waiter_test")).json()
    assert [t["code"] for t in rows] == ["T1", "T2", "T10"]


def test_create_area_idempotent_and_rejects_duplicate_name(client, seed):
    supervisor = login(client, "supervisor_test")
    first = _create_area(client, supervisor, key="same")
    again = _create_area(client, supervisor, key="same")
    assert again.status_code == 201 and again.json()["id"] == first.json()["id"]
    assert _create_area(client, supervisor, key="other").status_code == 409
    assert _create_area(client, supervisor, name="", key="empty").status_code == 422


def test_cannot_hide_area_with_tables_or_assign_to_hidden_area(client, seed):
    supervisor = login(client, "supervisor_test")
    area = _create_area(client, supervisor).json()
    table_url = f"/api/v1/tables/{seed['table_id']}"
    area_url = f"/api/v1/areas/{area['id']}"
    client.patch(table_url, json={"area_id": area["id"]}, headers=supervisor)

    assert client.patch(area_url, json={"is_active": False}, headers=supervisor).status_code == 409

    client.patch(table_url, json={"area_id": None}, headers=supervisor)
    hidden = client.patch(area_url, json={"is_active": False}, headers=supervisor)
    assert hidden.status_code == 200 and hidden.json()["is_active"] is False
    assign = client.patch(table_url, json={"area_id": area["id"]}, headers=supervisor)
    assert assign.status_code == 409
    active = client.get("/api/v1/areas?active_only=true", headers=supervisor).json()
    assert active == []


def test_update_area_validation(client, seed):
    supervisor = login(client, "supervisor_test")
    area = _create_area(client, supervisor).json()
    _create_area(client, supervisor, name="Tầng 2")
    url = f"/api/v1/areas/{area['id']}"

    assert client.patch(url, json={}, headers=supervisor).status_code == 422
    assert client.patch(url, json={"name": None}, headers=supervisor).status_code == 422
    assert client.patch(url, json={"name": "Tầng 2"}, headers=supervisor).status_code == 409
    renamed = client.patch(url, json={"name": "Tầng trệt", "sort_order": 5}, headers=supervisor)
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Tầng trệt" and renamed.json()["sort_order"] == 5


def test_area_stays_inside_outlet_and_changes_are_audited(client, seed, db_session_factory):
    supervisor = login(client, "supervisor_test")
    area = _create_area(client, supervisor).json()

    session = db_session_factory()
    outlet = Outlet(name="Outlet Khac")
    session.add(outlet)
    session.flush()
    session.add(
        Staff(
            outlet_id=outlet.id,
            username="sup_khac",
            password_hash=hash_password(SEED_PASSWORD),
            full_name="Sup Khac",
            role="SUPERVISOR",
        )
    )
    session.commit()
    session.close()

    outsider = login(client, "sup_khac")
    assert client.get("/api/v1/areas", headers=outsider).json() == []
    url = f"/api/v1/areas/{area['id']}"
    assert client.patch(url, json={"name": "X"}, headers=outsider).status_code == 404
    table_url = f"/api/v1/tables/{seed['table_id']}"
    assert client.patch(table_url, json={"area_id": None}, headers=outsider).status_code == 404

    client.patch(table_url, json={"area_id": area["id"]}, headers=supervisor)
    session = db_session_factory()
    actions = {log.action for log in session.query(AuditLog).all()}
    session.close()
    assert {"TABLE_AREA_CREATED", "TABLE_AREA_CHANGED"} <= actions


def test_seed_assigns_areas_without_overwriting_layout(client, seed, db_session_factory):
    session = db_session_factory()
    outlet = Outlet(name=seed_script.QA3_OUTLET_NAME)
    session.add(outlet)
    session.commit()
    seed_script._ensure_qa_third_outlet(session, SEED_PASSWORD, True)
    session.commit()
    session.close()

    admin = login(client, "qa3_admin")
    tables = {t["code"]: t for t in client.get("/api/v1/tables", headers=admin).json()}
    assert tables["Q3-1"]["area_name"] == "Tầng 1"
    assert tables["Q3-3"]["area_name"] == "Sân vườn"

    garden = tables["Q3-3"]["area_id"]
    client.patch(f"/api/v1/tables/{tables['Q3-1']['id']}", json={"area_id": garden}, headers=admin)
    session = db_session_factory()
    seed_script._ensure_qa_third_outlet(session, SEED_PASSWORD, True)
    session.commit()
    session.close()

    tables = {t["code"]: t for t in client.get("/api/v1/tables", headers=admin).json()}
    assert tables["Q3-1"]["area_name"] == "Sân vườn"
    assert len(client.get("/api/v1/areas", headers=admin).json()) == 2
