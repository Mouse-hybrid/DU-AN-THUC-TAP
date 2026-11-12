"""payment: cột cho VNPay

Revision ID: 0013_payment_vnpay
Revises: 0012_rewards_dot3
Create Date: 2026-11-12

Spec: specs/001-vnpay-sandbox. Thêm link thanh toán, hạn link và kết quả phía VNPay vào bảng
payment (đều cho phép null, tiền mặt/thẻ để trống), và chỉ mục cho script đối soát.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013_payment_vnpay"
down_revision: Union[str, None] = "0012_rewards_dot3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("payment_url", sa.Text()),
    ("expires_at", sa.DateTime(timezone=True)),
    ("vnp_create_date", sa.String(14)),
    ("provider_txn_no", sa.String(50)),
    ("provider_code", sa.String(10)),
    ("provider_paid_at", sa.DateTime(timezone=True)),
    ("last_checked_at", sa.DateTime(timezone=True)),
)


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        op.add_column("payment", sa.Column(name, type_, nullable=True))
    op.create_index("ix_payment_pending_expires", "payment", ["status", "expires_at"])


def downgrade() -> None:
    op.drop_index("ix_payment_pending_expires", table_name="payment")
    for name, _ in reversed(_COLUMNS):
        op.drop_column("payment", name)
