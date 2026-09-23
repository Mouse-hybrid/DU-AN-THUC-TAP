"""initial schema — 12 bảng cốt lõi POS (outlet, restaurant_table, table_session,
kitchen_station, menu_item, order, order_item, order_version, kitchen_queue,
audit_log, staff, idempotency_key)

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-09-23

Viết tay (không dùng `alembic revision --autogenerate`) vì môi trường hiện tại
không có DB thật để autogenerate so sánh — nội dung được đối chiếu thủ công,
cột-theo-cột, với app/db/models.py. TRƯỚC KHI CHẠY LÊN MÔI TRƯỜNG CÓ DỮ LIỆU
THẬT: chạy `alembic upgrade head` trên DB rỗng ở máy local/staging trước,
kiểm tra bằng `alembic check` hoặc so sánh `\d` từng bảng với models.py.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

GUID_TYPE = sa.CHAR(36)


def upgrade() -> None:
    # -- outlet ------------------------------------------------------------
    op.create_table(
        "outlet",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # -- kitchen_station -----------------------------------------------------
    op.create_table(
        "kitchen_station",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.UniqueConstraint("outlet_id", "name", name="uq_kitchen_station_outlet_name"),
    )

    # -- menu_item -----------------------------------------------------------
    op.create_table(
        "menu_item",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("station_id", GUID_TYPE, sa.ForeignKey("kitchen_station.id"), nullable=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("is_available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # -- staff -----------------------------------------------------------------
    op.create_table(
        "staff",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("username", sa.String(100), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("username", name="uq_staff_username"),
        sa.CheckConstraint(
            "role IN ('ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST')",
            name="ck_staff_role",
        ),
    )

    # -- restaurant_table --------------------------------------------------
    op.create_table(
        "restaurant_table",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, sa.ForeignKey("outlet.id"), nullable=False),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("seats", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("status", sa.String(20), nullable=False, server_default="AVAILABLE"),
        sa.Column("merged_into_table_id", GUID_TYPE, sa.ForeignKey("restaurant_table.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("outlet_id", "code", name="uq_restaurant_table_outlet_code"),
        sa.CheckConstraint(
            "status IN ('AVAILABLE', 'OCCUPIED', 'BILLING', 'PAID', 'CLEANING', 'RESERVED', 'DELAYED', 'MERGED')",
            name="ck_restaurant_table_status",
        ),
    )

    # -- table_session -------------------------------------------------------
    op.create_table(
        "table_session",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("table_id", GUID_TYPE, sa.ForeignKey("restaurant_table.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="OPEN"),
        sa.Column("guest_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("opened_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("qr_session_token", sa.String(255), nullable=True),
        sa.UniqueConstraint("qr_session_token", name="uq_table_session_qr_token"),
        sa.CheckConstraint("status IN ('OPEN', 'CLOSED')", name="ck_table_session_status"),
    )

    # -- order (quoted — reserved word trong SQL) -----------------------------
    op.create_table(
        "order",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("table_session_id", GUID_TYPE, sa.ForeignKey("table_session.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="NEW"),
        sa.Column("current_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('NEW', 'SENT', 'SERVED', 'BILLING', 'PAID', 'CLOSED')",
            name="ck_order_status",
        ),
    )

    # -- order_item ------------------------------------------------------------
    op.create_table(
        "order_item",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("order_id", GUID_TYPE, sa.ForeignKey("order.id"), nullable=False),
        sa.Column("menu_item_id", GUID_TYPE, sa.ForeignKey("menu_item.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="CREATED"),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("unit_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('CREATED', 'SENT', 'ACCEPTED', 'PREPARING', 'READY', "
            "'PICKED_UP', 'SERVED', 'RECALLED', 'VOIDED', 'REFIRED')",
            name="ck_order_item_status",
        ),
    )

    # -- order_version ---------------------------------------------------------
    op.create_table(
        "order_version",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("order_id", GUID_TYPE, sa.ForeignKey("order.id"), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("snapshot", sa.Text(), nullable=False),
        sa.Column("created_by_staff_id", GUID_TYPE, sa.ForeignKey("staff.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("order_id", "version_number", name="uq_order_version_order_number"),
    )

    # -- kitchen_queue -----------------------------------------------------
    op.create_table(
        "kitchen_queue",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("order_item_id", GUID_TYPE, sa.ForeignKey("order_item.id"), nullable=False),
        sa.Column("station_id", GUID_TYPE, sa.ForeignKey("kitchen_station.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="QUEUED"),
        sa.Column("queued_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('QUEUED', 'IN_PROGRESS', 'DONE', 'CANCELLED')",
            name="ck_kitchen_queue_status",
        ),
    )

    # -- audit_log (append-only, không FK cứng) -----------------------------
    op.create_table(
        "audit_log",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("outlet_id", GUID_TYPE, nullable=True),
        sa.Column("staff_id", GUID_TYPE, nullable=True),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("entity_type", sa.String(50), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("payload", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_audit_log_entity", "audit_log", ["entity_type", "entity_id"])
    op.create_index("ix_audit_log_created_at", "audit_log", ["created_at"])

    # -- idempotency_key ---------------------------------------------------
    op.create_table(
        "idempotency_key",
        sa.Column("id", GUID_TYPE, primary_key=True),
        sa.Column("key", sa.String(255), nullable=False),
        sa.Column("endpoint", sa.String(255), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("response_status", sa.Integer(), nullable=True),
        sa.Column("response_body", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("key", name="uq_idempotency_key_key"),
    )


def downgrade() -> None:
    # Xóa theo thứ tự ngược lại thứ tự tạo, vì các bảng sau tham chiếu FK tới bảng trước.
    op.drop_table("idempotency_key")
    op.drop_index("ix_audit_log_created_at", table_name="audit_log")
    op.drop_index("ix_audit_log_entity", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_table("kitchen_queue")
    op.drop_table("order_version")
    op.drop_table("order_item")
    op.drop_table("order")
    op.drop_table("table_session")
    op.drop_table("restaurant_table")
    op.drop_table("staff")
    op.drop_table("menu_item")
    op.drop_table("kitchen_station")
    op.drop_table("outlet")
