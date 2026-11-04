"""table_session.qr_expires_at + order_item.source

Revision ID: 0006_qr_ordering
Revises: 0005_table_area
Create Date: 2026-11-04

QR Ordering (Key Focus BRD): token QR có hạn dùng, và phân biệt món khách tự gọi với
món nhân viên nhập. Món cũ nhận source 'POS'.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006_qr_ordering"
down_revision: Union[str, None] = "0005_table_area"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "table_session", sa.Column("qr_expires_at", sa.DateTime(timezone=True), nullable=True)
    )
    # batch_alter_table để chạy được cả SQLite (recreate table) lẫn PostgreSQL.
    with op.batch_alter_table("order_item") as batch_op:
        batch_op.add_column(
            sa.Column("source", sa.String(10), nullable=False, server_default="POS")
        )
        batch_op.create_check_constraint("ck_order_item_source", "source IN ('POS', 'QR')")


def downgrade() -> None:
    with op.batch_alter_table("order_item") as batch_op:
        batch_op.drop_constraint("ck_order_item_source", type_="check")
        batch_op.drop_column("source")
    op.drop_column("table_session", "qr_expires_at")
