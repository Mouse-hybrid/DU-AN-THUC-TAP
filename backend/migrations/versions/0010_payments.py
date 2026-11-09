"""payment + payment_refund

Revision ID: 0010_payments
Revises: 0009_rewards_offers
Create Date: 2026-11-09

Thanh toán v2: một đơn trả được nhiều lần, nhiều hình thức (tiền mặt, thẻ; VNPay ở R2), có
hủy lần thanh toán ghi nhầm và hoàn tiền một phần. Đơn đã PAID trước migration này không có
dòng payment; báo cáo doanh thu cũ vẫn đọc từ audit ORDER_PAID.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010_payments"
down_revision: Union[str, None] = "0009_rewards_offers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    op.create_table(
        "payment",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("order_id", GUID_TYPE, sa.ForeignKey("order.id"), nullable=False),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("method", sa.String(20), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="SUCCEEDED"),
        sa.Column("refunded_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("cash_received", sa.Numeric(12, 2), nullable=True),
        sa.Column("change_due", sa.Numeric(12, 2), nullable=True),
        sa.Column("provider_ref", sa.String(100), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("cancelled_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("method IN ('CASH', 'CARD', 'VNPAY')", name="ck_payment_method"),
        sa.CheckConstraint(
            "status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'EXPIRED', 'CANCELLED', "
            "'REFUNDED')",
            name="ck_payment_status",
        ),
    )
    op.create_index("ix_payment_order_id", "payment", ["order_id"])
    op.create_index("ix_payment_outlet_created", "payment", ["outlet_id", "created_at"])

    op.create_table(
        "payment_refund",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("payment_id", GUID_TYPE, sa.ForeignKey("payment.id"), nullable=False),
        sa.Column("order_id", GUID_TYPE, sa.ForeignKey("order.id"), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_payment_refund_payment_id", "payment_refund", ["payment_id"])


def downgrade() -> None:
    op.drop_index("ix_payment_refund_payment_id", table_name="payment_refund")
    op.drop_table("payment_refund")
    op.drop_index("ix_payment_outlet_created", table_name="payment")
    op.drop_index("ix_payment_order_id", table_name="payment")
    op.drop_table("payment")
