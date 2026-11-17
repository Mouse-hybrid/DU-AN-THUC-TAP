"""audit_log: trigger chặn sửa và xóa

Revision ID: 0014_audit_log_immutable
Revises: 0013_payment_vnpay
Create Date: 2026-11-17

ADR 0004 (P2-RFI-AUD), bằng chứng cho P2-AUD-005: chặn UPDATE, DELETE và TRUNCATE bảng
audit_log ở tầng database. Chỉ `scripts/loadtest_data.py cleanup` được xóa audit của outlet
"Load test", khi đặt `SET LOCAL pos.audit_purge = 'loadtest'`. Chỉ chạy trên Postgres.

SQL giữ nguyên tại đây (không import app/db/audit_guard.py) để migration không đổi theo code.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0014_audit_log_immutable"
down_revision: Union[str, None] = "0013_payment_vnpay"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_FUNCTION = """
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('pos.audit_purge', true) = 'loadtest'
       AND EXISTS (SELECT 1 FROM outlet WHERE id = OLD.outlet_id AND name = 'Load test') THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION USING
        MESSAGE = 'audit_log chỉ được thêm, không được sửa hay xóa (thao tác ' || TG_OP || ')',
        ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql
"""


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute(_FUNCTION)
    op.execute(
        "CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log "
        "FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()"
    )
    op.execute(
        "CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log "
        "FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()"
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log")
    op.execute("DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log")
    op.execute("DROP FUNCTION IF EXISTS audit_log_immutable()")
