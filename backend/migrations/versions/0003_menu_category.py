"""menu_category + menu_item.category_id

Revision ID: 0003_menu_category
Revises: 0002_align_staff_roles_with_brd
Create Date: 2026-10-08

Thêm nhóm món cho Menu Management (BRD) — POS lọc món theo nhóm (Figma
screen-09/12) và màn quản lý nhóm món (screen-102). category_id nullable để
các món đã có trên staging không bị vi phạm ràng buộc; gán nhóm sau qua
PATCH /api/v1/menu/{id} hoặc seed.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_menu_category"
down_revision: Union[str, None] = "0002_align_staff_roles_with_brd"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    op.create_table(
        "menu_category",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.UniqueConstraint("outlet_id", "name", name="uq_menu_category_outlet_name"),
    )

    # batch_alter_table để chạy được cả SQLite (recreate table) lẫn PostgreSQL.
    with op.batch_alter_table("menu_item") as batch_op:
        batch_op.add_column(sa.Column("category_id", GUID_TYPE, nullable=True))
        batch_op.create_foreign_key(
            "fk_menu_item_category_id", "menu_category", ["category_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("menu_item") as batch_op:
        batch_op.drop_constraint("fk_menu_item_category_id", type_="foreignkey")
        batch_op.drop_column("category_id")
    op.drop_table("menu_category")
