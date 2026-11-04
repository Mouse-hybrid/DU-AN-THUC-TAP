"""customer + loyalty_rule + points_ledger + order.customer_id

Revision ID: 0008_rewards_core
Revises: 0007_menu_modifiers
Create Date: 2026-11-04

Rewards đợt 1 (Key Focus BRD): khách hàng theo số điện thoại, luật tích/đổi điểm có phiên
bản, sổ điểm chỉ ghi thêm. Mỗi đơn chỉ có 1 dòng cho mỗi loại giao dịch, nên không tích trùng.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008_rewards_core"
down_revision: Union[str, None] = "0007_menu_modifiers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    op.create_table(
        "customer",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("phone", sa.String(15), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=True),
        sa.Column("member_code", sa.String(20), nullable=False),
        sa.Column("points_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("outlet_id", "phone", name="uq_customer_outlet_phone"),
        sa.UniqueConstraint("member_code", name="uq_customer_member_code"),
        sa.CheckConstraint("points_balance >= 0", name="ck_customer_points_balance"),
    )
    op.create_table(
        "loyalty_rule",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("earn_amount_per_point", sa.Numeric(12, 2), nullable=False),
        sa.Column("redeem_value_per_point", sa.Numeric(12, 2), nullable=False),
        sa.Column("max_redeem_percent", sa.Integer(), nullable=False),
        sa.Column("points_expire_days", sa.Integer(), nullable=True),
        sa.Column("created_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("outlet_id", "version", name="uq_loyalty_rule_outlet_version"),
    )
    # batch_alter_table để chạy được cả SQLite (recreate table) lẫn PostgreSQL.
    with op.batch_alter_table("order") as batch_op:
        batch_op.add_column(sa.Column("customer_id", GUID_TYPE, nullable=True))
        batch_op.create_foreign_key("fk_order_customer_id", "customer", ["customer_id"], ["id"])
    op.create_table(
        "points_ledger",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("customer_id", GUID_TYPE, sa.ForeignKey("customer.id"), nullable=False),
        sa.Column("entry_type", sa.String(20), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("order_id", GUID_TYPE, sa.ForeignKey("order.id"), nullable=True),
        sa.Column("rule_version", sa.Integer(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("order_id", "entry_type", name="uq_points_ledger_order_type"),
        sa.CheckConstraint(
            "entry_type IN ('EARN', 'REDEEM', 'REVERSAL', 'ADJUST')",
            name="ck_points_ledger_entry_type",
        ),
    )


def downgrade() -> None:
    op.drop_table("points_ledger")
    with op.batch_alter_table("order") as batch_op:
        batch_op.drop_constraint("fk_order_customer_id", type_="foreignkey")
        batch_op.drop_column("customer_id")
    op.drop_table("loyalty_rule")
    op.drop_table("customer")
