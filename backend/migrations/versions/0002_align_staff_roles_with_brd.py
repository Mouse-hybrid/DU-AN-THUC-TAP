"""align staff.role với bảng Role thật trong BRD

Revision ID: 0002_align_staff_roles_with_brd
Revises: 0001_initial_schema
Create Date: 2026-09-23

Migration 0001 đặt tạm STAFF_ROLE = (ADMIN, MANAGER, CASHIER, WAITER, KITCHEN,
HOST) — suy luận chủ quan lúc chưa đối chiếu kỹ BRD. Đọc lại bảng Role trong
BRD gốc (mục "Role || Description || Key Responsibilities || System Access ||
Restrictions") thì hệ thống CHỈ có đúng 4 role nội bộ: Cashier, Waiter,
Kitchen Staff, Supervisor (Customer là người dùng QR bên ngoài, không phải
staff). Migration này sửa lại CHECK constraint cho khớp, kèm data-fix cho
các staff đã tạo với role cũ không còn hợp lệ.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0002_align_staff_roles_with_brd"
down_revision: Union[str, None] = "0001_initial_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_ROLES = "'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST'"
_NEW_ROLES = "'CASHIER', 'WAITER', 'KITCHEN', 'SUPERVISOR'"


def upgrade() -> None:
    # Data-fix TRƯỚC khi đổi constraint — nếu không các row role=ADMIN/HOST cũ
    # (vd tài khoản seed dev) sẽ vi phạm CHECK constraint mới ngay lập tức.
    # ADMIN/MANAGER -> SUPERVISOR (đều là role "full access, override" trong BRD).
    # HOST -> WAITER (role gần nhất về mặt trách nhiệm: quản lý bàn/khách).
    op.execute("UPDATE staff SET role = 'SUPERVISOR' WHERE role IN ('ADMIN', 'MANAGER')")
    op.execute("UPDATE staff SET role = 'WAITER' WHERE role = 'HOST'")

    # batch_alter_table để chạy được trên cả SQLite (phải recreate table vì
    # SQLite không hỗ trợ DROP/ADD CONSTRAINT trực tiếp) lẫn PostgreSQL.
    with op.batch_alter_table("staff") as batch_op:
        batch_op.drop_constraint("ck_staff_role", type_="check")
        batch_op.create_check_constraint("ck_staff_role", f"role IN ({_NEW_ROLES})")


def downgrade() -> None:
    with op.batch_alter_table("staff") as batch_op:
        batch_op.drop_constraint("ck_staff_role", type_="check")
        batch_op.create_check_constraint("ck_staff_role", f"role IN ({_OLD_ROLES})")
