"""reward + order_reward

Revision ID: 0009_rewards_offers
Revises: 0008_rewards_core
Create Date: 2026-11-04

Rewards đợt 2: ưu đãi (giảm %, giảm tiền, đổi điểm) và ưu đãi đã áp vào đơn. Khi thanh toán,
order_reward lưu lại số tiền giảm và số điểm thực tế để đơn cũ không đổi khi sửa ưu đãi.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_rewards_offers"
down_revision: Union[str, None] = "0008_rewards_core"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    op.create_table(
        "reward",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("reward_type", sa.String(20), nullable=False),
        sa.Column("value", sa.Numeric(12, 2), nullable=True),
        sa.Column("min_order_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("max_discount", sa.Numeric(12, 2), nullable=True),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("valid_to", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("used_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("outlet_id", "name", name="uq_reward_outlet_name"),
        sa.CheckConstraint(
            "reward_type IN ('PERCENT', 'FIXED', 'POINTS')", name="ck_reward_type"
        ),
    )
    op.create_table(
        "order_reward",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("order_id", GUID_TYPE, sa.ForeignKey("order.id"), nullable=False),
        sa.Column("reward_id", GUID_TYPE, sa.ForeignKey("reward.id"), nullable=False),
        sa.Column("customer_id", GUID_TYPE, sa.ForeignKey("customer.id"), nullable=True),
        sa.Column("reward_name", sa.String(255), nullable=False),
        sa.Column("reward_type", sa.String(20), nullable=False),
        sa.Column("points_requested", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rule_version", sa.Integer(), nullable=True),
        sa.Column("override_reason", sa.Text(), nullable=True),
        sa.Column("discount_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("points_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(20), nullable=False, server_default="APPLIED"),
        sa.Column("applied_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('APPLIED', 'REMOVED', 'COMMITTED', 'REVERSED')",
            name="ck_order_reward_status",
        ),
    )


def downgrade() -> None:
    op.drop_table("order_reward")
    op.drop_table("reward")
