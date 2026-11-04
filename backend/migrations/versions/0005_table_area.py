"""table_area + restaurant_table.area_id

Revision ID: 0005_table_area
Revises: 0004_staff_token_version
Create Date: 2026-11-04

Nhà hàng có nhiều tầng/khu (BE-S3-01, Figma màn 03, lọc khu ở màn 04, QR màn 40).
area_id nullable để bàn đã có trên staging không vi phạm ràng buộc; seed gán khu sau.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_table_area"
down_revision: Union[str, None] = "0004_staff_token_version"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    op.create_table(
        "table_area",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.UniqueConstraint("outlet_id", "name", name="uq_table_area_outlet_name"),
    )

    # batch_alter_table để chạy được cả SQLite (recreate table) lẫn PostgreSQL.
    with op.batch_alter_table("restaurant_table") as batch_op:
        batch_op.add_column(sa.Column("area_id", GUID_TYPE, nullable=True))
        batch_op.create_foreign_key(
            "fk_restaurant_table_area_id", "table_area", ["area_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("restaurant_table") as batch_op:
        batch_op.drop_constraint("fk_restaurant_table_area_id", type_="foreignkey")
        batch_op.drop_column("area_id")
    op.drop_table("table_area")
