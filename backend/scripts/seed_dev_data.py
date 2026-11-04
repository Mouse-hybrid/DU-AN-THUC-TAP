#!/usr/bin/env python3
"""Seed dữ liệu tối thiểu để test thủ công các luồng API (Swagger/Postman/curl)
trên DB local (SQLite hoặc Postgres, tùy DATABASE_URL).

Tạo đủ 4 tài khoản staff theo đúng 4 role thật trong BRD (Cashier/Waiter/
Kitchen/Supervisor) để test được ranh giới RBAC, không chỉ 1 tài khoản "admin"
có toàn quyền; cùng menu mẫu (3 nhóm, 8 món, 2 trạm bếp) và 14 bàn B1–B14 chia 3 khu.
Kèm 2 khu dữ liệu thử cho QA (outlet riêng, KHÔNG phải chi nhánh thật — dự án là
1 nhà hàng nhiều tầng): QA 2 (không menu, thử cách ly) và khu thử nghiệm QA 3 (đủ
menu, chạy trọn luồng có ghi dữ liệu mà không đụng dữ liệu demo).

Trên staging: scripts/deploy-staging.sh tự chạy script này sau mỗi lần migrate
(CI/CD, không cần SSH). Mật khẩu 4 tài khoản lấy từ biến SEED_PASSWORD trong
.env.staging trên server — ngoài development KHÔNG dùng mật khẩu mặc định trong
file này (repo public). Thiếu SEED_PASSWORD thì vẫn seed menu/bàn, bỏ qua tạo
tài khoản. Có SEED_PASSWORD thì tài khoản seed luôn được đưa về đúng mật khẩu đó
(dùng để đổi mật khẩu staging: sửa .env.staging rồi deploy lại).

Chạy (PowerShell, sau khi đã `alembic upgrade head`):
    cd backend
    .venv\\Scripts\\Activate.ps1
    $env:DATABASE_URL = "sqlite:///./test_local.db"
    python scripts/seed_dev_data.py

Idempotent theo tên: chạy lại nhiều lần không tạo trùng (check tồn tại trước khi insert).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.core.config import APP_ENV  # noqa: E402
from app.core.security import hash_password, verify_password  # noqa: E402
from app.db.base import SessionLocal  # noqa: E402
from app.db.models import (  # noqa: E402
    KitchenStation,
    LoyaltyRule,
    MenuCategory,
    MenuItem,
    ModifierGroup,
    ModifierOption,
    Outlet,
    RestaurantTable,
    Reward,
    Staff,
    TableArea,
)

SEED_OUTLET_NAME = "Chi nhánh Demo"

# Menu mẫu dùng chung cho BE/QA/FE (menu soạn sẵn, không có luồng thêm món dần).
# Sẽ thay bằng bộ Master Menu của QA (DAT-QA-01) khi có file.
SEED_STATIONS = ("Bếp chính", "Quầy bar")
# category -> (sort_order, [(tên món, giá, trạm)])
SEED_MENU: dict[str, tuple[int, list[tuple[str, str, str]]]] = {
    "Món khai vị": (
        1,
        [("Gỏi cuốn", "35000.00", "Bếp chính"), ("Chả giò", "40000.00", "Bếp chính")],
    ),
    "Món chính": (
        2,
        [
            ("Phở bò", "45000.00", "Bếp chính"),
            ("Bún chả", "50000.00", "Bếp chính"),
            ("Cơm tấm sườn", "55000.00", "Bếp chính"),
        ],
    ),
    "Đồ uống": (
        3,
        [
            ("Trà đá", "5000.00", "Quầy bar"),
            ("Cà phê sữa đá", "25000.00", "Quầy bar"),
            ("Nước cam", "30000.00", "Quầy bar"),
        ],
    ),
}
# món -> [(nhóm, min_select, max_select, [(tùy chọn, giá cộng thêm)])]. Bản demo chỉ dùng
# nhóm tùy ý: nhóm bắt buộc sẽ làm luồng gọi món hiện tại (chưa gửi tùy chọn) nhận 422.
SEED_MODIFIERS: dict[str, list[tuple[str, int, int, list[tuple[str, str]]]]] = {
    "Phở bò": [("Thêm topping", 0, 2, [("Thêm trứng", "5000.00"), ("Thêm thịt", "15000.00")])],
    "Cà phê sữa đá": [("Độ ngọt", 0, 1, [("Ít đường", "0.00"), ("Không đường", "0.00")])],
}
# Riêng khu QA 3 có thêm nhóm bắt buộc để test thiếu tùy chọn.
QA3_MODIFIERS: dict[str, list[tuple[str, int, int, list[tuple[str, str]]]]] = {
    **SEED_MODIFIERS,
    "Trà đá": [("Size", 1, 1, [("Vừa", "0.00"), ("Lớn", "3000.00")])],
}
# 10.000đ = 1 điểm, 1 điểm = 100đ, đổi tối đa 50% đơn, điểm hết hạn sau 12 tháng.
SEED_LOYALTY_RULE = {
    "earn_amount_per_point": "10000.00",
    "redeem_value_per_point": "100.00",
    "max_redeem_percent": 50,
    "points_expire_days": 365,
}
SEED_REWARDS = (
    {"name": "Đổi điểm", "reward_type": "POINTS"},
    {
        "name": "Giảm 10% đơn từ 200.000đ",
        "reward_type": "PERCENT",
        "value": "10.00",
        "min_order_amount": "200000.00",
        "max_discount": "50000.00",
    },
)
# (mã bàn, số ghế)
SEED_TABLES = (
    ("B1", 4),
    ("B2", 4),
    ("B3", 2),
    ("B4", 2),
    ("B5", 6),
    ("B6", 6),
    ("B7", 4),
    ("B8", 4),
    ("B9", 4),
    ("B10", 6),
    ("B11", 6),
    ("B12", 4),
    ("B13", 4),
    ("B14", 2),
)
# tên khu -> (sort_order, mã bàn). Sơ đồ minh họa theo Figma màn 03, không phải sơ đồ
# thật; bố trí thật cấu hình qua /api/v1/areas và PATCH /api/v1/tables/{id}.
SEED_AREAS: dict[str, tuple[int, tuple[str, ...]]] = {
    "Tầng 1": (1, ("B1", "B2", "B3", "B4", "B5", "B6")),
    "Tầng 2": (2, ("B7", "B8", "B9", "B10", "B11")),
    "Sân vườn": (3, ("B12", "B13", "B14")),
}

# username -> (role, full_name). "admin" giữ nguyên tên đăng nhập cũ cho quen,
# role thật là SUPERVISOR (full access, không phải role riêng "admin").
SEED_STAFF: dict[str, tuple[str, str]] = {
    "admin": ("SUPERVISOR", "Supervisor Demo"),
    "cashier": ("CASHIER", "Cashier Demo"),
    "waiter": ("WAITER", "Waiter Demo"),
    "kitchen": ("KITCHEN", "Kitchen Demo"),
}
# Chi nhánh thứ 2 chỉ để QA kiểm cách ly dữ liệu giữa chi nhánh; cố ý không có menu.
QA_OUTLET_NAME = "Chi nhánh QA 2 (không menu)"
QA_OUTLET_TABLES = (("Q2-1", 4),)
QA_OUTLET_STAFF: dict[str, tuple[str, str]] = {
    "qa2_admin": ("SUPERVISOR", "Supervisor QA chi nhánh 2"),
    "qa2_cashier": ("CASHIER", "Cashier QA chi nhánh 2"),
}
# Khu thử nghiệm QA 3 (outlet riêng, không phải chi nhánh thật): QA chạy trọn luồng
# POS -> bếp -> thanh toán mà không đụng dữ liệu demo: đủ menu mẫu, 2 trạm bếp, 4 vai.
# Outlet QA 2 giữ KHÔNG có menu (TC_API_03_004). Món QA3_SOLD_OUT_ITEM được reset
# --with-fixtures đặt hết hàng.
QA3_OUTLET_NAME = "Khu thử nghiệm QA (luồng đầy đủ)"
QA3_OUTLET_TABLES = (("Q3-1", 4), ("Q3-2", 4), ("Q3-3", 2))
QA3_AREAS: dict[str, tuple[int, tuple[str, ...]]] = {
    "Tầng 1": (1, ("Q3-1", "Q3-2")),
    "Sân vườn": (2, ("Q3-3",)),
}
QA3_OUTLET_STAFF: dict[str, tuple[str, str]] = {
    "qa3_admin": ("SUPERVISOR", "Supervisor QA khu thử nghiệm"),
    "qa3_cashier": ("CASHIER", "Cashier QA khu thử nghiệm"),
    "qa3_waiter": ("WAITER", "Waiter QA khu thử nghiệm"),
    "qa3_kitchen": ("KITCHEN", "Kitchen QA khu thử nghiệm"),
}
QA3_SOLD_OUT_ITEM = "Nước cam"
# CHỈ dùng khi APP_ENV=development (máy local). Môi trường khác bắt buộc env SEED_PASSWORD.
DEV_SEED_PASSWORD = "password123"
# Độ dài tối thiểu ngoài development. Tên hằng cố ý không chứa chữ "password":
# CodeQL (py/clear-text-logging-sensitive-data) nhận diện theo tên biến và báo
# nhầm khi in con số này ra log.
# Hạ từ 12 xuống 6 ngày 21/10 theo quyết định của nhóm (dễ nhớ cho demo). Rủi ro đã
# biết: staging mở công khai qua IP, login chưa giới hạn số lần thử sai (SEC-02,
# Pha 2) — nên nâng lại hoặc thêm giới hạn thử sai trước khi dùng dữ liệu thật.
_MIN_CHARS_NON_DEV = 6


def resolve_seed_password() -> tuple[str | None, bool]:
    """Trả (mật khẩu, có_set_tường_minh). None = không tạo/đổi tài khoản."""
    explicit = os.getenv("SEED_PASSWORD")
    if explicit:
        if APP_ENV != "development" and len(explicit) < _MIN_CHARS_NON_DEV:
            print(f"! SEED_PASSWORD quá ngắn (< {_MIN_CHARS_NON_DEV} ký tự), bỏ qua tài khoản")
            return None, False
        return explicit, True
    if APP_ENV == "development":
        return DEV_SEED_PASSWORD, False
    print(f"! Chưa set SEED_PASSWORD cho APP_ENV={APP_ENV} — bỏ qua tạo/đổi tài khoản seed")
    return None, False


def _ensure_staff(session, outlet, username, role, full_name, password, explicit) -> None:
    """Tạo tài khoản nếu chưa có; có SEED_PASSWORD thì đưa mật khẩu về đúng giá trị đó."""
    staff = session.execute(select(Staff).where(Staff.username == username)).scalar_one_or_none()
    if password is None:
        if staff is None:
            print(f"- bỏ qua tạo staff {role} (username={username})")
        return
    if staff is None:
        staff = Staff(
            outlet_id=outlet.id,
            username=username,
            password_hash=hash_password(password),
            full_name=full_name,
            role=role,
        )
        session.add(staff)
        session.flush()
        print(f"+ staff {role}: {staff.id} (username={username})")
    elif explicit and not verify_password(password, staff.password_hash):
        staff.password_hash = hash_password(password)
        print(f"~ staff {role}: đặt lại mật khẩu theo SEED_PASSWORD (username={username})")
    else:
        print(f"= staff {role} đã tồn tại: {staff.id} (username={username})")


def _ensure_qa_second_outlet(session, password, explicit) -> None:
    """Chi nhánh thứ 2 cho QA: KHÔNG có menu/trạm bếp (TC_API_03_004: GET /menu rỗng)
    và có tài khoản + bàn riêng để thử truy cập chéo chi nhánh (TC_EXT_019). Order
    mẫu trên bàn Q2-1 do reset_staging_data.py --with-fixtures tạo."""
    outlet = session.execute(
        select(Outlet).where(Outlet.name == QA_OUTLET_NAME)
    ).scalar_one_or_none()
    if outlet is None:
        outlet = Outlet(name=QA_OUTLET_NAME, address="Dữ liệu kiểm thử QA")
        session.add(outlet)
        session.flush()
        print(f"+ outlet QA 2: {outlet.id}")
    for username, (role, full_name) in QA_OUTLET_STAFF.items():
        _ensure_staff(session, outlet, username, role, full_name, password, explicit)
    for code, seats in QA_OUTLET_TABLES:
        exists = session.execute(
            select(RestaurantTable).where(
                RestaurantTable.outlet_id == outlet.id, RestaurantTable.code == code
            )
        ).scalar_one_or_none()
        if exists is None:
            session.add(RestaurantTable(outlet_id=outlet.id, code=code, seats=seats))
            session.flush()
            print(f"+ restaurant_table {code} (outlet QA 2)")


def _ensure_menu_and_tables(session, outlet, tables, label: str = "") -> None:
    """Trạm bếp, menu mẫu (SEED_MENU) và bàn cho một chi nhánh. Idempotent theo tên."""
    stations: dict[str, KitchenStation] = {}
    for station_name in SEED_STATIONS:
        station = session.execute(
            select(KitchenStation).where(
                KitchenStation.outlet_id == outlet.id, KitchenStation.name == station_name
            )
        ).scalar_one_or_none()
        if station is None:
            station = KitchenStation(outlet_id=outlet.id, name=station_name)
            session.add(station)
            session.flush()
            print(f"+ kitchen_station {station_name}: {station.id}")
        stations[station_name] = station

    for category_name, (sort_order, items) in SEED_MENU.items():
        category = session.execute(
            select(MenuCategory).where(
                MenuCategory.outlet_id == outlet.id, MenuCategory.name == category_name
            )
        ).scalar_one_or_none()
        if category is None:
            category = MenuCategory(outlet_id=outlet.id, name=category_name, sort_order=sort_order)
            session.add(category)
            session.flush()
            print(f"+ menu_category {category_name}: {category.id}")

        for item_name, price, station_name in items:
            menu_item = session.execute(
                select(MenuItem).where(MenuItem.outlet_id == outlet.id, MenuItem.name == item_name)
            ).scalar_one_or_none()
            if menu_item is None:
                menu_item = MenuItem(
                    outlet_id=outlet.id,
                    station_id=stations[station_name].id,
                    category_id=category.id,
                    name=item_name,
                    price=price,
                )
                session.add(menu_item)
                session.flush()
                print(f"+ menu_item {item_name}: {menu_item.id}")
            elif menu_item.category_id is None:
                # Món seed từ bản cũ (trước khi có nhóm món) -> gán nhóm.
                menu_item.category_id = category.id

    for code, seats in tables:
        table = session.execute(
            select(RestaurantTable).where(
                RestaurantTable.outlet_id == outlet.id, RestaurantTable.code == code
            )
        ).scalar_one_or_none()
        if table is None:
            table = RestaurantTable(outlet_id=outlet.id, code=code, seats=seats, status="AVAILABLE")
            session.add(table)
            session.flush()
            print(f"+ restaurant_table {code}{label}: {table.id}")


def _ensure_areas(session, outlet, areas) -> None:
    """Tạo khu và gán bàn. Bàn đã có khu thì giữ nguyên: seed chạy sau mỗi lần deploy,
    không được ghi đè bố trí Supervisor đã cấu hình."""
    for area_name, (sort_order, codes) in areas.items():
        area = session.execute(
            select(TableArea).where(TableArea.outlet_id == outlet.id, TableArea.name == area_name)
        ).scalar_one_or_none()
        if area is None:
            area = TableArea(outlet_id=outlet.id, name=area_name, sort_order=sort_order)
            session.add(area)
            session.flush()
            print(f"+ table_area {area_name}: {area.id}")
        tables = session.scalars(
            select(RestaurantTable).where(
                RestaurantTable.outlet_id == outlet.id,
                RestaurantTable.code.in_(codes),
                RestaurantTable.area_id.is_(None),
            )
        )
        for table in tables:
            table.area_id = area.id
    session.flush()


def _ensure_modifiers(session, outlet, spec) -> None:
    """Chỉ tạo nhóm chưa có theo tên; không sửa nhóm đã tồn tại vì Supervisor có thể đã
    cấu hình lại, và seed chạy sau mỗi lần deploy."""
    for item_name, groups in spec.items():
        item = session.execute(
            select(MenuItem).where(MenuItem.outlet_id == outlet.id, MenuItem.name == item_name)
        ).scalar_one_or_none()
        if item is None:
            continue
        existing = {group.name for group in item.modifier_groups}
        for sort_order, (name, min_select, max_select, options) in enumerate(groups):
            if name in existing:
                continue
            item.modifier_groups.append(
                ModifierGroup(
                    name=name,
                    min_select=min_select,
                    max_select=max_select,
                    sort_order=sort_order,
                    options=[
                        ModifierOption(name=option, price_delta=price, sort_order=index)
                        for index, (option, price) in enumerate(options)
                    ],
                )
            )
            print(f"+ modifier_group {item_name} / {name}")
    session.flush()


def _ensure_loyalty_rule(session, outlet) -> None:
    """Luật và ưu đãi mặc định tạm, chờ PO chốt. Đã có thì giữ nguyên."""
    exists = session.scalars(
        select(LoyaltyRule.id).where(LoyaltyRule.outlet_id == outlet.id).limit(1)
    ).first()
    if exists is None:
        session.add(LoyaltyRule(outlet_id=outlet.id, version=1, **SEED_LOYALTY_RULE))
        session.flush()
        print(f"+ loyalty_rule v1 ({outlet.name})")
    for spec in SEED_REWARDS:
        found = session.scalars(
            select(Reward.id).where(Reward.outlet_id == outlet.id, Reward.name == spec["name"])
        ).first()
        if found is None:
            session.add(Reward(outlet_id=outlet.id, **spec))
            session.flush()
            print(f"+ reward {spec['name']} ({outlet.name})")


def _ensure_qa_third_outlet(session, password, explicit) -> None:
    """Khu thử nghiệm QA 3: đủ menu mẫu, trạm bếp, bàn Q3-1..Q3-3 và 4 vai, để QA chạy
    trọn luồng có ghi dữ liệu mà không đụng dữ liệu demo."""
    outlet = session.execute(
        select(Outlet).where(Outlet.name == QA3_OUTLET_NAME)
    ).scalar_one_or_none()
    if outlet is None:
        outlet = Outlet(name=QA3_OUTLET_NAME, address="Dữ liệu kiểm thử QA")
        session.add(outlet)
        session.flush()
        print(f"+ outlet khu thử nghiệm QA 3: {outlet.id}")
    for username, (role, full_name) in QA3_OUTLET_STAFF.items():
        _ensure_staff(session, outlet, username, role, full_name, password, explicit)
    _ensure_menu_and_tables(session, outlet, QA3_OUTLET_TABLES, label=" (khu thử nghiệm QA 3)")
    _ensure_areas(session, outlet, QA3_AREAS)
    _ensure_modifiers(session, outlet, QA3_MODIFIERS)
    _ensure_loyalty_rule(session, outlet)


def main() -> None:
    if SessionLocal is None:
        raise RuntimeError("DATABASE_URL chưa được set — xem docstring đầu file")

    with SessionLocal() as session:
        outlet = session.execute(
            select(Outlet).where(Outlet.name == SEED_OUTLET_NAME)
        ).scalar_one_or_none()
        if outlet is None:
            outlet = Outlet(name=SEED_OUTLET_NAME, address="123 Đường Demo, Q.1, TP.HCM")
            session.add(outlet)
            session.flush()
            print(f"+ outlet: {outlet.id}")
        else:
            print(f"= outlet đã tồn tại: {outlet.id}")

        # Không in password ra log/console: CodeQL bắt đúng
        # (py/clear-text-logging-sensitive-data) — output lọt vào CI log của deploy.
        password, explicit = resolve_seed_password()
        for username, (role, full_name) in SEED_STAFF.items():
            _ensure_staff(session, outlet, username, role, full_name, password, explicit)

        _ensure_menu_and_tables(session, outlet, SEED_TABLES)
        _ensure_areas(session, outlet, SEED_AREAS)
        _ensure_modifiers(session, outlet, SEED_MODIFIERS)
        _ensure_loyalty_rule(session, outlet)

        _ensure_qa_second_outlet(session, password, explicit)
        _ensure_qa_third_outlet(session, password, explicit)

        session.commit()

        print("\n--- Dùng để test API ---")
        print("Lấy id bàn/món/nhóm/trạm qua GET /api/v1/tables, /menu, /menu/categories,")
        print("/kitchen/stations (Postman tự lấy: docs/api/pos-api.postman_collection.json).")
        print(
            "Tất cả tài khoản dùng chung 1 password: local = DEV_SEED_PASSWORD trong file này; "
            "staging = SEED_PASSWORD trong .env.staging trên server."
        )
        for username, (role, _) in SEED_STAFF.items():
            print(f'  {role:<10} -> POST /api/v1/auth/login  {{"username": "{username}"}}')
        for username, (role, _) in QA_OUTLET_STAFF.items():
            print(f'  {role:<10} (chi nhánh QA 2) -> {{"username": "{username}"}}')
        for username, (role, _) in QA3_OUTLET_STAFF.items():
            print(f'  {role:<10} (khu thử nghiệm QA 3) -> {{"username": "{username}"}}')


if __name__ == "__main__":
    main()
