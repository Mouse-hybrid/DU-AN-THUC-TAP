"""Schema cốt lõi cho POS System — Release 1 (modular monolith, theo ADR 0002).

13 bảng, đúng theo BRD/HLR đã review:
  outlet, restaurant_table, table_session, kitchen_station, menu_category,
  menu_item, "order", order_item, order_version, kitchen_queue, audit_log,
  staff, idempotency_key. (menu_category thêm ở migration 0003.)

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

ORDER_ITEM_SOURCE = ("POS", "QR")

POINTS_ENTRY_TYPE = ("EARN", "REDEEM", "REVERSAL", "ADJUST")

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
# TableArea — tầng/khu của nhà hàng (vd "Tầng 1", "Sân vườn"), do Supervisor cấu hình.
# ---------------------------------------------------------------------------


class TableArea(Base):
    __tablename__ = "table_area"
    __table_args__ = (UniqueConstraint("outlet_id", "name", name="uq_table_area_outlet_name"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


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
    area_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("table_area.id"), nullable=True
    )
    merged_into_table_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("restaurant_table.id"), nullable=True
    )  # khi status=MERGED, trỏ tới bàn được gộp vào
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    outlet: Mapped["Outlet"] = relationship(back_populates="tables")
    area: Mapped["TableArea | None"] = relationship()
    sessions: Mapped[list["TableSession"]] = relationship(back_populates="table")

    @property
    def area_name(self) -> str | None:
        return self.area.name if self.area else None


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
    qr_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

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
# MenuCategory — nhóm món (vd "Món chính", "Đồ uống") để POS lọc món và quản
# lý menu theo nhóm (BRD Menu Management; Figma screen-102). Migration 0003.
# ---------------------------------------------------------------------------


class MenuCategory(Base):
    __tablename__ = "menu_category"
    __table_args__ = (UniqueConstraint("outlet_id", "name", name="uq_menu_category_outlet_name"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    menu_items: Mapped[list["MenuItem"]] = relationship(back_populates="category")


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
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("menu_category.id"), nullable=True
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
    category: Mapped["MenuCategory | None"] = relationship(back_populates="menu_items")
    modifier_groups: Mapped[list["ModifierGroup"]] = relationship(
        back_populates="menu_item",
        cascade="all, delete-orphan",
        order_by="ModifierGroup.sort_order, ModifierGroup.name",
    )

    @property
    def active_modifier_groups(self) -> list["ModifierGroup"]:
        return [group for group in self.modifier_groups if group.is_active]

    @property
    def has_modifiers(self) -> bool:
        return bool(self.active_modifier_groups)


# ---------------------------------------------------------------------------
# ModifierGroup / ModifierOption — tùy chọn của 1 món (vd nhóm "Size" có "Vừa", "Lớn").
# min_select >= 1 là nhóm bắt buộc chọn. Không có xóa, chỉ ẩn, để đơn cũ vẫn tra được.
# ---------------------------------------------------------------------------


class ModifierGroup(Base):
    __tablename__ = "modifier_group"
    __table_args__ = (
        UniqueConstraint("menu_item_id", "name", name="uq_modifier_group_item_name"),
        CheckConstraint(
            "min_select >= 0 AND max_select >= 1 AND min_select <= max_select",
            name="ck_modifier_group_select_range",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    menu_item_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("menu_item.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    min_select: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_select: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    menu_item: Mapped["MenuItem"] = relationship(back_populates="modifier_groups")
    options: Mapped[list["ModifierOption"]] = relationship(
        back_populates="group",
        cascade="all, delete-orphan",
        order_by="ModifierOption.sort_order, ModifierOption.name",
    )


class ModifierOption(Base):
    __tablename__ = "modifier_option"
    __table_args__ = (
        UniqueConstraint("group_id", "name", name="uq_modifier_option_group_name"),
        CheckConstraint("price_delta >= 0", name="ck_modifier_option_price_delta"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    group_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("modifier_group.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    price_delta: Mapped[Numeric] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    is_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    group: Mapped["ModifierGroup"] = relationship(back_populates="options")


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
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("customer.id"), nullable=True
    )  # khách tích điểm, không bắt buộc
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
    __table_args__ = (
        _check(ORDER_ITEM_STATUS, "status", "ck_order_item_status"),
        _check(ORDER_ITEM_SOURCE, "source", "ck_order_item_source"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    order_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("order.id"), nullable=False)
    menu_item_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("menu_item.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="CREATED")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    unit_price: Mapped[Numeric] = mapped_column(
        Numeric(12, 2), nullable=False
    )  # snapshot giá lúc order, ĐÃ gồm giá cộng thêm của tùy chọn
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # ghi chú món, vd "không hành"
    source: Mapped[str] = mapped_column(
        String(10), nullable=False, default="POS", server_default="POS"
    )  # POS = nhân viên nhập, QR = khách tự gọi
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    order: Mapped["Order"] = relationship(back_populates="items")
    menu_item: Mapped["MenuItem"] = relationship()
    kitchen_queue_entries: Mapped[list["KitchenQueue"]] = relationship(back_populates="order_item")
    modifiers: Mapped[list["OrderItemModifier"]] = relationship(cascade="all, delete-orphan")


class OrderItemModifier(Base):
    """Tùy chọn khách đã chọn cho 1 dòng món; lưu lại tên và giá lúc gọi."""

    __tablename__ = "order_item_modifier"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    order_item_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("order_item.id"), nullable=False
    )
    option_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("modifier_option.id"), nullable=False
    )
    group_name: Mapped[str] = mapped_column(String(100), nullable=False)
    option_name: Mapped[str] = mapped_column(String(100), nullable=False)
    price_delta: Mapped[Numeric] = mapped_column(Numeric(12, 2), nullable=False)


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
# Rewards: khách hàng, luật tích/đổi điểm có phiên bản (sửa = tạo bản mới), sổ điểm chỉ
# ghi thêm. points_balance là số dư đọc nhanh, luôn bằng balance_after của dòng sổ mới nhất.
# ---------------------------------------------------------------------------


class Customer(Base):
    __tablename__ = "customer"
    __table_args__ = (
        UniqueConstraint("outlet_id", "phone", name="uq_customer_outlet_phone"),
        UniqueConstraint("member_code", name="uq_customer_member_code"),
        CheckConstraint("points_balance >= 0", name="ck_customer_points_balance"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    phone: Mapped[str] = mapped_column(String(15), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    member_code: Mapped[str] = mapped_column(String(20), nullable=False)
    points_balance: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class LoyaltyRule(Base):
    __tablename__ = "loyalty_rule"
    __table_args__ = (
        UniqueConstraint("outlet_id", "version", name="uq_loyalty_rule_outlet_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    outlet_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("outlet.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    earn_amount_per_point: Mapped[Numeric] = mapped_column(Numeric(12, 2), nullable=False)
    redeem_value_per_point: Mapped[Numeric] = mapped_column(Numeric(12, 2), nullable=False)
    max_redeem_percent: Mapped[int] = mapped_column(Integer, nullable=False)
    points_expire_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("staff.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PointsLedger(Base):
    __tablename__ = "points_ledger"
    __table_args__ = (
        # NULL khác nhau nên ADJUST (không gắn đơn) ghi được nhiều dòng.
        UniqueConstraint("order_id", "entry_type", name="uq_points_ledger_order_type"),
        _check(POINTS_ENTRY_TYPE, "entry_type", "ck_points_ledger_entry_type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=new_uuid)
    customer_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("customer.id"), nullable=False)
    entry_type: Mapped[str] = mapped_column(String(20), nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False)  # dương = cộng, âm = trừ
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    order_id: Mapped[uuid.UUID | None] = mapped_column(GUID, ForeignKey("order.id"), nullable=True)
    rule_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    staff_id: Mapped[uuid.UUID | None] = mapped_column(GUID, ForeignKey("staff.id"), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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
    # Tăng khi đổi mật khẩu/khóa/đổi role để thu hồi mọi JWT đã cấp.
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
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
