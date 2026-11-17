"""outlet: chế độ gửi món QR

Revision ID: 0015_outlet_qr_send_mode
Revises: 0014_audit_log_immutable
Create Date: 2026-11-17

Món khách gọi qua QR vào bếp ngay (DIRECT, theo luồng QR của HLR) hay chờ phục vụ xác nhận
(CONFIRM, phiếu B6 cũ). Cửa hàng đang có nhận DIRECT; Supervisor đổi ở PATCH /outlet/settings.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015_outlet_qr_send_mode"
down_revision: Union[str, None] = "0014_audit_log_immutable"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "outlet",
        sa.Column("qr_send_mode", sa.String(20), nullable=False, server_default="DIRECT"),
    )


def downgrade() -> None:
    op.drop_column("outlet", "qr_send_mode")
