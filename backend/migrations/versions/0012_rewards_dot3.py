"""Rewards đợt 3: EXPIRE trong sổ điểm, số điện thoại khách nhập trên QR

Revision ID: 0012_rewards_dot3
Revises: 0011_role_permission_override
Create Date: 2026-11-12

Spec: specs/002-rewards-dot-3. Thêm loại bút toán EXPIRE (điểm hết hạn); thêm vào
table_session số điện thoại khách nhập trên QR chờ thu ngân xử lý và số lần đã gửi.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_rewards_dot3"
down_revision: Union[str, None] = "0011_role_permission_override"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_TYPES = "('EARN', 'REDEEM', 'REVERSAL', 'ADJUST')"
_NEW_TYPES = "('EARN', 'REDEEM', 'REVERSAL', 'ADJUST', 'EXPIRE')"


def upgrade() -> None:
    op.drop_constraint("ck_points_ledger_entry_type", "points_ledger", type_="check")
    op.create_check_constraint(
        "ck_points_ledger_entry_type", "points_ledger", f"entry_type IN {_NEW_TYPES}"
    )
    op.add_column("table_session", sa.Column("pending_member_phone", sa.String(15)))
    op.add_column(
        "table_session",
        sa.Column("qr_member_attempts", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    expired = bind.execute(
        sa.text("SELECT COUNT(*) FROM points_ledger WHERE entry_type = 'EXPIRE'")
    ).scalar()
    if expired:
        raise RuntimeError(
            f"Đã có {expired} dòng EXPIRE trong sổ điểm; hạ cấp sẽ làm sai số dư khách hàng"
        )
    op.drop_column("table_session", "qr_member_attempts")
    op.drop_column("table_session", "pending_member_phone")
    op.drop_constraint("ck_points_ledger_entry_type", "points_ledger", type_="check")
    op.create_check_constraint(
        "ck_points_ledger_entry_type", "points_ledger", f"entry_type IN {_OLD_TYPES}"
    )
