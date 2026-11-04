"""modifier_group + modifier_option + order_item_modifier

Revision ID: 0007_menu_modifiers
Revises: 0006_qr_ordering
Create Date: 2026-11-04

Tùy chọn món (phiếu quyết định B7: size và topping có giá cộng thêm, chưa có combo).
order_item_modifier lưu lại tên và giá lúc gọi, để sửa tùy chọn sau này không đổi đơn cũ.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007_menu_modifiers"
down_revision: Union[str, None] = "0006_qr_ordering"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    op.create_table(
        "modifier_group",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("menu_item_id", GUID_TYPE, sa.ForeignKey("menu_item.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("min_select", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_select", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.UniqueConstraint("menu_item_id", "name", name="uq_modifier_group_item_name"),
        sa.CheckConstraint(
            "min_select >= 0 AND max_select >= 1 AND min_select <= max_select",
            name="ck_modifier_group_select_range",
        ),
    )
    op.create_table(
        "modifier_option",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("group_id", GUID_TYPE, sa.ForeignKey("modifier_group.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("price_delta", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("is_available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("group_id", "name", name="uq_modifier_option_group_name"),
        sa.CheckConstraint("price_delta >= 0", name="ck_modifier_option_price_delta"),
    )
    op.create_table(
        "order_item_modifier",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("order_item_id", GUID_TYPE, sa.ForeignKey("order_item.id"), nullable=False),
        sa.Column("option_id", GUID_TYPE, sa.ForeignKey("modifier_option.id"), nullable=False),
        sa.Column("group_name", sa.String(100), nullable=False),
        sa.Column("option_name", sa.String(100), nullable=False),
        sa.Column("price_delta", sa.Numeric(12, 2), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("order_item_modifier")
    op.drop_table("modifier_option")
    op.drop_table("modifier_group")
