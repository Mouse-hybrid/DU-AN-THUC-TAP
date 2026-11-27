"""outlet/order: VAT và phí phục vụ

Revision ID: 0016_vat_service_charge
Revises: 0015_outlet_qr_send_mode
Create Date: 2026-11-27

specs/003-vat-hoa-don. Outlet có thuế suất VAT, cờ giá đã gồm VAT, phí phục vụ; mặc định tắt
nên dữ liệu đang có không đổi số tiền. Đơn chốt tỉ lệ khi chuyển BILLING và chốt số phí/thuế
khi chuyển PAID. Cột trên đơn cho phép null: đơn cũ coi như tỉ lệ 0.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016_vat_service_charge"
down_revision: Union[str, None] = "0015_outlet_qr_send_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("outlet") as batch:
        batch.add_column(
            sa.Column("vat_rate", sa.Numeric(5, 2), nullable=False, server_default="0")
        )
        batch.add_column(
            sa.Column("prices_include_vat", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.add_column(
            sa.Column("service_charge_rate", sa.Numeric(5, 2), nullable=False, server_default="0")
        )
        batch.create_check_constraint("ck_outlet_vat_rate", "vat_rate >= 0 AND vat_rate <= 20")
        batch.create_check_constraint(
            "ck_outlet_service_charge_rate",
            "service_charge_rate >= 0 AND service_charge_rate <= 30",
        )

    with op.batch_alter_table("order") as batch:
        batch.add_column(sa.Column("vat_rate_applied", sa.Numeric(5, 2), nullable=True))
        batch.add_column(sa.Column("prices_include_vat_applied", sa.Boolean(), nullable=True))
        batch.add_column(sa.Column("service_charge_rate_applied", sa.Numeric(5, 2), nullable=True))
        batch.add_column(sa.Column("service_charge", sa.Numeric(12, 2), nullable=True))
        batch.add_column(sa.Column("tax_total", sa.Numeric(12, 2), nullable=True))
        batch.add_column(sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("order") as batch:
        for column in (
            "paid_at",
            "tax_total",
            "service_charge",
            "service_charge_rate_applied",
            "prices_include_vat_applied",
            "vat_rate_applied",
        ):
            batch.drop_column(column)

    with op.batch_alter_table("outlet") as batch:
        batch.drop_constraint("ck_outlet_service_charge_rate", type_="check")
        batch.drop_constraint("ck_outlet_vat_rate", type_="check")
        batch.drop_column("service_charge_rate")
        batch.drop_column("prices_include_vat")
        batch.drop_column("vat_rate")
