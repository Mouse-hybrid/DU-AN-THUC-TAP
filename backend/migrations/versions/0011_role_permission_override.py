"""role_permission_override

Revision ID: 0011_role_permission_override
Revises: 0010_payments
Create Date: 2026-11-09

Supervisor sửa ma trận quyền trên màn Vai trò. Bảng chỉ lưu các ô khác mặc định trong
app/core/permissions.py, theo từng outlet; chưa có dòng nào = đúng mặc định như trước.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_role_permission_override"
down_revision: Union[str, None] = "0010_payments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    op.create_table(
        "role_permission_override",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("permission", sa.String(50), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("allowed", sa.Boolean(), nullable=False),
        sa.Column("updated_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "outlet_id", "permission", "role", name="uq_role_permission_override"
        ),
        sa.CheckConstraint(
            "role IN ('CASHIER', 'WAITER', 'KITCHEN', 'SUPERVISOR')",
            name="ck_role_permission_override_role",
        ),
    )


def downgrade() -> None:
    op.drop_table("role_permission_override")
