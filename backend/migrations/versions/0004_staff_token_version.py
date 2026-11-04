"""staff.token_version

Revision ID: 0004_staff_token_version
Revises: 0003_menu_category
Create Date: 2026-11-04

Thu hồi JWT đã cấp khi đổi mật khẩu, khóa tài khoản hoặc đổi role (quản lý nhân
viên, Pha 2). Tài khoản cũ nhận 0; token cấp trước đó không có `ver` cũng được coi
là 0 nên không ai bị đăng xuất khi deploy.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_staff_token_version"
down_revision: Union[str, None] = "0003_menu_category"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "staff", sa.Column("token_version", sa.Integer(), nullable=False, server_default="0")
    )


def downgrade() -> None:
    op.drop_column("staff", "token_version")
