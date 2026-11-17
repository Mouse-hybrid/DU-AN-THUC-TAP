"""Chặn sửa và xóa bảng audit_log ngay trong Postgres (ADR 0004, P2-RFI-AUD; P2-AUD-005).

Ứng dụng không có API sửa hay xóa audit. Trigger này chặn thêm ở tầng database, nên một lỗi
code, một script hay một câu SQL gõ tay cũng không sửa hay xóa được lịch sử:
- UPDATE, DELETE từng dòng và TRUNCATE đều báo lỗi;
- INSERT vẫn bình thường.

Ngoại lệ duy nhất: `scripts/loadtest_data.py cleanup` được xóa audit của outlet "Load test"
(dữ liệu chịu tải, không phải nghiệp vụ). Script phải đặt `SET LOCAL pos.audit_purge =
'loadtest'` trong transaction, và chỉ xóa được dòng thuộc đúng outlet đó; không sửa được dòng
nào.

Giới hạn: người có quyền chủ bảng (`pos_app`) vẫn có thể DROP TRIGGER. Trigger chống sai sót
và chống sửa lén qua ứng dụng, không thay cho phân quyền database.

Bản SQL ở đây cài trigger khi `Base.metadata.create_all` (test trên Postgres). Migration
`0014_audit_log_immutable` giữ bản riêng của nó, vì migration không được đổi theo code sau này.
SQLite (test thường) không cài trigger.
"""

from __future__ import annotations

from sqlalchemy import DDL, Table, event

LOADTEST_OUTLET_NAME = "Load test"
PURGE_SETTING = "pos.audit_purge"

CREATE_FUNCTION = f"""
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('{PURGE_SETTING}', true) = 'loadtest'
       AND EXISTS (
           SELECT 1 FROM outlet WHERE id = OLD.outlet_id AND name = '{LOADTEST_OUTLET_NAME}'
       ) THEN
        RETURN OLD;
    END IF;
    -- Không dùng dấu phần trăm: DDL của SQLAlchemy coi đó là ký tự định dạng.
    RAISE EXCEPTION USING
        MESSAGE = 'audit_log chỉ được thêm, không được sửa hay xóa (thao tác ' || TG_OP || ')',
        ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql
"""

CREATE_ROW_TRIGGER = """
CREATE TRIGGER audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()
"""

CREATE_TRUNCATE_TRIGGER = """
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()
"""


def install_on_create(table: Table) -> None:
    """Cài trigger mỗi khi bảng audit_log được tạo bằng create_all trên Postgres."""
    for sql in (CREATE_FUNCTION, CREATE_ROW_TRIGGER, CREATE_TRUNCATE_TRIGGER):
        event.listen(table, "after_create", DDL(sql).execute_if(dialect="postgresql"))
