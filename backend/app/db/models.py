"""Schema cốt lõi cho POS System — Release 1 (modular monolith, theo ADR 0002).

12 bảng, đúng theo BRD/HLR đã review:
  outlet, restaurant_table, table_session, kitchen_station, menu_item,
  "order", order_item, order_version, kitchen_queue, audit_log, staff,
  idempotency_key.

Quy ước áp dụng cho toàn bộ file:
- PK = GUID (uuid4 sinh phía client hoặc server) — KHÔNG dùng auto-increment,
  vì BRD yêu cầu offline-first: POS/KDS/QR có thể tạo record khi mất mạng,
  ID phải hợp lệ trước khi sync lên server (tránh đụng ID giữa nhiều thiết bị).
- Các cột "status" dùng String + CHECK constraint liệt kê giá trị hợp lệ,
  KHÔNG dùng PostgreSQL native ENUM — MVP-stage: đổi enum (thêm trạng thái
  mới) chỉ cần 1 migration ALTER CHECK, không cần CREATE TYPE/DROP TYPE/
  ALTER TYPE ADD VALUE (không transaction-safe với ENUM native).
- created_at/updated_at: server_default=func.now(); updated_at cập nhật qua
  onupdate=func.now() (áp dụng khi update qua ORM — sync job cần tự set lại
  nếu update bằng raw SQL/bulk).
- audit_log là append-only: KHÔNG có updated_at, KHÔNG có FK ràng buộc cứng
  (chỉ lưu id dạng string) để không bao giờ bị chặn ghi log vì FK lỗi, và để
  giữ được log ngay cả khi record gốc đã bị xóa/đổi.

Các enum trạng thái lấy đúng theo bảng đã trích xuất từ BRD trong lúc review
yêu cầu (không tự bịa thêm giá trị). Nếu BRD có state không khớp 100% với
danh sách dưới, phải đối chiếu lại BRD gốc trước khi chạy migration lên môi
trường có dữ liệu thật.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import GUID, Base, new_uuid

# ---------------------------------------------------------------------------
# Enum trạng thái (CHECK constraint values) — theo đúng BRD đã trích xuất
# ---------------------------------------------------------------------------

TABLE_STATUS = (
    "AVAILABLE",
    "OCCUPIED",
    "BILLING",
    "PAID",
    "CLEANING",
    "RESERVED",
    "DELAYED",
    "MERGED",
)

TABLE_SESSION_STATUS = ("OPEN", "CLOSED")

ORDER_STATUS = ("NEW", "SENT", "SERVED", "BILLING", "PAID", "CLOSED")

ORDER_ITEM_STATUS = (
    "CREATED",
    "SENT",
    "ACCEPTED",
    "PREPARING",
    "READY",
    "PICKED_UP",
    "SERVED",
    "RECALLED",
    "VOIDED",
    "REFIRED",
)

KITCHEN_QUEUE_STATUS = ("QUEUED", "IN_PROGRESS", "DONE", "CANCELLED")

# Đúng theo bảng Role trong BRD (mục "Role || Description || Key
# Responsibilities || System Access || Restrictions") — CHỈ có 4 role nội bộ
# này, không có ADMIN/MANAGER/HOST. "Customer" trong BRD là người dùng QR bên
# ngoài, không phải staff nên không có mặt ở đây (khách QR dùng qr_session_token
# trên table_session, không có tài khoản staff).
STAFF_ROLE = ("CASHIER", "WAITER", "KITCHEN", "SUPERVISOR")


def _check(values: tuple[str, ...], col: str, name: str) -> CheckConstraint:
    quoted = ", ".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{col} IN ({quoted})", name=name)


# ---------------------------------------------------------------------------
# Outlet — 1 chi nhánh/cửa hàng. Mọi bảng nghiệp vụ khác đều scope theo outlet
# để về sau mở rộng multi-outlet không phải đổi schema.
# ---------------------------------------------------------------------------


class Outlet(Base):
    __tablename__ = "outlet"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    tables: Mapped[list["RestaurantTable"]] = relationship(back_populates="outlet")
    kitchen_stations: Mapped[list["KitchenStation"]] = relationship(back_populates="outlet")
    menu_items: Mapped[list["MenuItem"]] = relationship(back_populates="outlet")
    staff: Mapped[list["Staff"]] = relationship(back_populates="outlet")


# ---------------------------------------------------------------------------
# RestaurantTable — bàn vật lý trong outlet.
# ---------------------------------------------------------------------------


class RestaurantTable(Base):
    __tablename__ = "restaurant_table"
    __table_args__ = (
        _check(TABLE_STATUS, "status", "ck_restaurant_table_status"),
        UniqueConstraint("outlet_id", "code", name="uq_restaurant_table_outlet_code"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    code: Mapped[str] = mapped_column(String(50), nullable=False)  # số bàn hiển thị, vd "B12"
    seats: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="AVAILABLE")
    merged_into_table_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("restaurant_table.id"), nullable=True
    )  # khi status=MERGED, trỏ tới bàn được gộp vào
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    outlet: Mapped["Outlet"] = relationship(back_populates="tables")
    sessions: Mapped[list["TableSession"]] = relationship(back_populates="table")


# ---------------------------------------------------------------------------
# TableSession — 1 lượt khách ngồi tại 1 bàn, từ lúc mở bàn tới lúc thanh
# toán xong + dọn bàn. order/order_item luôn thuộc về 1 table_session.
# ---------------------------------------------------------------------------


class TableSession(Base):
    __tablename__ = "table_session"
    __table_args__ = (_check(TABLE_SESSION_STATUS, "status", "ck_table_session_status"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    table_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("restaurant_table.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    guest_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    opened_by_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("staff.id"), nullable=True
    )
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # session token tạm cho khách quét QR gọi món — không cần login (theo BRD auth)
    qr_session_token: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)

    table: Mapped["RestaurantTable"] = relationship(back_populates="sessions")
    orders: Mapped[list["Order"]] = relationship(back_populates="table_session")


# ---------------------------------------------------------------------------
# KitchenStation — trạm bếp (vd: bếp nóng, bếp lạnh, bar) — order_item được
# route tới đúng station theo menu_item.station_id.
# ---------------------------------------------------------------------------


class KitchenStation(Base):
    __tablename__ = "kitchen_station"
    __table_args__ = (UniqueConstraint("outlet_id", "name", name="uq_kitchen_station_outlet_name"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)  # vd "Bếp nóng", "Bar"
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    outlet: Mapped["Outlet"] = relationship(back_populates="kitchen_stations")
    menu_items: Mapped[list["MenuItem"]] = relationship(back_populates="station")


# ---------------------------------------------------------------------------
# MenuItem — món trong menu, gắn với 1 kitchen_station để biết gửi bếp nào.
# ---------------------------------------------------------------------------


class MenuItem(Base):
    __tablename__ = "menu_item"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    station_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("kitchen_station.id"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    price: Mapped[Numeric] = mapped_column(Numeric(12, 2), nullable=False)
    is_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    outlet: Mapped["Outlet"] = relationship(back_populates="menu_items")
    station: Mapped["KitchenStation | None"] = relationship(back_populates="menu_items")


# ---------------------------------------------------------------------------
# Order — 1 đơn hàng thuộc 1 table_session. order_version tăng mỗi lần có
# thay đổi (thêm/xóa món) — dùng cho optimistic concurrency + đồng bộ offline.
# ---------------------------------------------------------------------------


class Order(Base):
    __tablename__ = "order"
    __table_args__ = (_check(ORDER_STATUS, "status", "ck_order_status"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    table_session_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("table_session.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="NEW")
    current_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("staff.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    table_session: Mapped["TableSession"] = relationship(back_populates="orders")
    items: Mapped[list["OrderItem"]] = relationship(back_populates="order")
    versions: Mapped[list["OrderVersion"]] = relationship(back_populates="order")


# ---------------------------------------------------------------------------
# OrderItem — 1 dòng món trong order. Trạng thái riêng theo từng món vì mỗi
# món có thể ở giai đoạn bếp khác nhau (món A đã SERVED, món B vẫn PREPARING).
# ---------------------------------------------------------------------------


class OrderItem(Base):
    __tablename__ = "order_item"
    __table_args__ = (_check(ORDER_ITEM_STATUS, "status", "ck_order_item_status"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    order_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("order.id"), nullable=False)
    menu_item_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("menu_item.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="CREATED")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    unit_price: Mapped[Numeric] = mapped_column(
        Numeric(12, 2), nullable=False
    )  # snapshot giá lúc order
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # ghi chú món, vd "không hành"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    order: Mapped["Order"] = relationship(back_populates="items")
    menu_item: Mapped["MenuItem"] = relationship()
    kitchen_queue_entries: Mapped[list["KitchenQueue"]] = relationship(back_populates="order_item")


# ---------------------------------------------------------------------------
# OrderVersion — snapshot mỗi lần order thay đổi. Dùng để: (a) đồng bộ giữa
# thiết bị offline và server không bị mất/đè thay đổi, (b) hiển thị lịch sử
# "gửi bếp lần mấy" cho KDS.
# ---------------------------------------------------------------------------


class OrderVersion(Base):
    __tablename__ = "order_version"
    __table_args__ = (
        UniqueConstraint("order_id", "version_number", name="uq_order_version_order_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    order_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("order.id"), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot: Mapped[str] = mapped_column(
        Text, nullable=False
    )  # JSON serialize toàn bộ order+items tại thời điểm này
    created_by_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("staff.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    order: Mapped["Order"] = relationship(back_populates="versions")


# ---------------------------------------------------------------------------
# KitchenQueue — hàng đợi bếp thực tế theo từng station (KDS đọc bảng này,
# không đọc thẳng order_item, để 1 order_item có thể re-fire tạo entry mới
# mà không mất lịch sử entry cũ).
# ---------------------------------------------------------------------------


class KitchenQueue(Base):
    __tablename__ = "kitchen_queue"
    __table_args__ = (_check(KITCHEN_QUEUE_STATUS, "status", "ck_kitchen_queue_status"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    order_item_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("order_item.id"), nullable=False
    )
    station_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("kitchen_station.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="QUEUED")
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    order_item: Mapped["OrderItem"] = relationship(back_populates="kitchen_queue_entries")
    station: Mapped["KitchenStation"] = relationship()


# ---------------------------------------------------------------------------
# Staff — nhân viên, dùng cho JWT auth + RBAC theo Permission Matrix trong BRD.
# ---------------------------------------------------------------------------


class Staff(Base):
    __tablename__ = "staff"
    __table_args__ = (
        _check(STAFF_ROLE, "role", "ck_staff_role"),
        UniqueConstraint("username", name="uq_staff_username"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    username: Mapped[str] = mapped_column(String(100), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    outlet: Mapped["Outlet"] = relationship(back_populates="staff")


# ---------------------------------------------------------------------------
# AuditLog — append-only, KHÔNG FK cứng (chỉ lưu id dạng string) để log
# không bao giờ bị chặn ghi vì lỗi ràng buộc, và giữ được sau khi record gốc
# bị xóa/thay đổi. Theo BRD NFR: mọi thao tác quan trọng (mở bàn, hủy món,
# thanh toán, đổi giá...) phải ghi lại được ai làm, khi nào, làm gì.
# ---------------------------------------------------------------------------


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID | None] = mapped_column(GUID, nullable=True)
    staff_id: Mapped[uuid.UUID | None] = mapped_column(GUID, nullable=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False)  # vd "ORDER_ITEM_VOIDED"
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)  # vd "order_item"
    entity_id: Mapped[str] = mapped_column(String(36), nullable=False)
    payload: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # JSON: before/after hoặc chi tiết thao tác
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# IdempotencyKey — bắt buộc theo BRD NFR: mọi API tạo mới (order, payment...)
# phải nhận header Idempotency-Key, lưu lại response đầu tiên để trả lại y
# hệt nếu client gọi lại do timeout/retry, tránh tạo trùng đơn/trùng thanh toán.
# ---------------------------------------------------------------------------


class IdempotencyKey(Base):
    __tablename__ = "idempotency_key"
    __table_args__ = (UniqueConstraint("key", name="uq_idempotency_key_key"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    key: Mapped[str] = mapped_column(String(255), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(255), nullable=False)  # vd "POST /api/v1/orders"
    request_hash: Mapped[str] = mapped_column(
        String(64), nullable=False
    )  # SHA-256 của request body
    response_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
