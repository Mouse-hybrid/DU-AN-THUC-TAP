"""Trigger chặn sửa và xóa audit_log (ADR 0004, P2-AUD-005). Chỉ chạy trên Postgres thật:
CI đặt TEST_POSTGRES_URL; chạy local không có biến này thì bỏ qua."""

from __future__ import annotations

import importlib.util
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, delete, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.db.models import AuditLog, Outlet

POSTGRES_URL = os.getenv("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not POSTGRES_URL, reason="cần TEST_POSTGRES_URL (Postgres thật)")

_SPEC = importlib.util.spec_from_file_location(
    "loadtest_data", Path(__file__).resolve().parent.parent / "scripts" / "loadtest_data.py"
)


@pytest.fixture()
def factory():
    engine = create_engine(POSTGRES_URL)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.drop_all(engine)
    engine.dispose()


def _outlet_with_audit(factory, name: str) -> tuple[uuid.UUID, uuid.UUID]:
    session = factory()
    outlet = Outlet(name=name)
    session.add(outlet)
    session.flush()
    row = AuditLog(
        outlet_id=outlet.id, action="TEST", entity_type="test", entity_id=str(outlet.id)
    )
    session.add(row)
    session.commit()
    ids = (outlet.id, row.id)
    session.close()
    return ids


def _expect_blocked(factory, stmt) -> None:
    session = factory()
    with pytest.raises(DBAPIError) as exc:
        session.execute(stmt)
        session.commit()
    assert "audit_log chỉ được thêm" in str(exc.value)
    session.rollback()
    session.close()


def test_insert_works_update_delete_truncate_blocked(factory):
    _, row_id = _outlet_with_audit(factory, "Cua hang")
    _expect_blocked(factory, update(AuditLog).where(AuditLog.id == row_id).values(action="X"))
    _expect_blocked(factory, delete(AuditLog).where(AuditLog.id == row_id))
    _expect_blocked(factory, text("TRUNCATE audit_log"))

    session = factory()
    assert session.get(AuditLog, row_id).action == "TEST"
    session.close()


def test_purge_flag_only_deletes_loadtest_outlet_rows(factory):
    _, normal_row = _outlet_with_audit(factory, "Cua hang")
    _, loadtest_row = _outlet_with_audit(factory, "Load test")

    session = factory()
    session.execute(text("SET LOCAL pos.audit_purge = 'loadtest'"))
    session.execute(delete(AuditLog).where(AuditLog.id == loadtest_row))
    session.commit()
    assert session.get(AuditLog, loadtest_row) is None
    session.close()

    # Có cờ vẫn không xóa được audit của outlet khác, cũng không sửa được dòng nào.
    session = factory()
    session.execute(text("SET LOCAL pos.audit_purge = 'loadtest'"))
    with pytest.raises(DBAPIError):
        session.execute(delete(AuditLog).where(AuditLog.id == normal_row))
    session.rollback()
    session.close()

    # SET LOCAL hết hiệu lực sau transaction: transaction mới không có cờ thì bị chặn.
    _, loadtest_row = _outlet_with_audit(factory, "Load test")
    _expect_blocked(factory, delete(AuditLog).where(AuditLog.id == loadtest_row))


def test_loadtest_cleanup_still_removes_its_audit(factory):
    loadtest_data = importlib.util.module_from_spec(_SPEC)
    _SPEC.loader.exec_module(loadtest_data)
    _, loadtest_row = _outlet_with_audit(factory, loadtest_data.OUTLET_NAME)
    _, normal_row = _outlet_with_audit(factory, "Cua hang")

    session = factory()
    loadtest_data.cleanup(session, really=True)
    session.close()

    session = factory()
    assert session.get(AuditLog, loadtest_row) is None
    assert session.get(AuditLog, normal_row) is not None
    session.close()
