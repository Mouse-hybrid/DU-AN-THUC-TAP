#!/usr/bin/env python3
"""Seed dữ liệu tối thiểu để test thủ công các luồng API (Swagger/Postman/curl)
trên DB local (SQLite hoặc Postgres, tùy DATABASE_URL).

Tạo đủ 4 tài khoản staff theo đúng 4 role thật trong BRD (Cashier/Waiter/
Kitchen/Supervisor) để test được ranh giới RBAC, không chỉ 1 tài khoản "admin"
có toàn quyền; cùng menu mẫu (3 nhóm, 8 món, 2 trạm bếp) và 6 bàn B1–B6.

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
    MenuCategory,
    MenuItem,
    Outlet,
    RestaurantTable,
    Staff,
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
# (mã bàn, số ghế)
SEED_TABLES = (("B1", 4), ("B2", 4), ("B3", 2), ("B4", 2), ("B5", 6), ("B6", 6))

# username -> (role, full_name). "admin" giữ nguyên tên đăng nhập cũ cho quen,
# role thật là SUPERVISOR (full access, không phải role riêng "admin").
SEED_STAFF: dict[str, tuple[str, str]] = {
    "admin": ("SUPERVISOR", "Supervisor Demo"),
    "cashier": ("CASHIER", "Cashier Demo"),
    "waiter": ("WAITER", "Waiter Demo"),
    "kitchen": ("KITCHEN", "Kitchen Demo"),
}
# CHỈ dùng khi APP_ENV=development (máy local). Môi trường khác bắt buộc env SEED_PASSWORD.
DEV_SEED_PASSWORD = "password123"
# Độ dài tối thiểu ngoài development. Tên hằng cố ý không chứa chữ "password":
# CodeQL (py/clear-text-logging-sensitive-data) nhận diện theo tên biến và báo
# nhầm khi in con số này ra log.
_MIN_CHARS_NON_DEV = 12


def resolve_seed_password() -> tuple[str | None, bool]:
    """Trả (mật khẩu, có_set_tường_minh). None = không tạo/đổi tài khoản."""
    explicit = os.getenv("SEED_PASSWORD")
    if explicit:
        if APP_ENV != "development" and len(explicit) < _MIN_CHARS_NON_DEV:
            print(f"! SEED_PASSWORD quá ngắn (tối thiểu {_MIN_CHARS_NON_DEV} ký tự) — bỏ qua tài khoản")
            return None, False
        return explicit, True
    if APP_ENV == "development":
        return DEV_SEED_PASSWORD, False
    print(f"! Chưa set SEED_PASSWORD cho APP_ENV={APP_ENV} — bỏ qua tạo/đổi tài khoản seed")
    return None, False


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
            staff = session.execute(
                select(Staff).where(Staff.username == username)
            ).scalar_one_or_none()
            if password is None:
                if staff is None:
                    print(f"- bỏ qua tạo staff {role} (username={username})")
                continue
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
                category = MenuCategory(
                    outlet_id=outlet.id, name=category_name, sort_order=sort_order
                )
                session.add(category)
                session.flush()
                print(f"+ menu_category {category_name}: {category.id}")

            for item_name, price, station_name in items:
                menu_item = session.execute(
                    select(MenuItem).where(
                        MenuItem.outlet_id == outlet.id, MenuItem.name == item_name
                    )
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

        for code, seats in SEED_TABLES:
            table = session.execute(
                select(RestaurantTable).where(
                    RestaurantTable.outlet_id == outlet.id, RestaurantTable.code == code
                )
            ).scalar_one_or_none()
            if table is None:
                table = RestaurantTable(
                    outlet_id=outlet.id, code=code, seats=seats, status="AVAILABLE"
                )
                session.add(table)
                session.flush()
                print(f"+ restaurant_table {code}: {table.id}")

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


if __name__ == "__main__":
    main()
