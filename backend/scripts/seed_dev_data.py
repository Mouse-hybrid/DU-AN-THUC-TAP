#!/usr/bin/env python3
"""Seed dữ liệu tối thiểu để test thủ công các luồng API (Swagger/Postman/curl)
trên DB local (SQLite hoặc Postgres, tùy DATABASE_URL).

Tạo đủ 4 tài khoản staff theo đúng 4 role thật trong BRD (Cashier/Waiter/
Kitchen/Supervisor) để test được ranh giới RBAC, không chỉ 1 tài khoản "admin"
có toàn quyền.

Chạy (PowerShell, sau khi đã `alembic upgrade head`):
    cd backend
    .venv\\Scripts\\Activate.ps1
    $env:DATABASE_URL = "sqlite:///./test_local.db"
    python scripts/seed_dev_data.py

Idempotent theo tên: chạy lại nhiều lần không tạo trùng (check tồn tại trước khi insert).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.core.security import hash_password  # noqa: E402
from app.db.base import SessionLocal  # noqa: E402
from app.db.models import KitchenStation, MenuItem, Outlet, RestaurantTable, Staff  # noqa: E402

SEED_OUTLET_NAME = "Chi nhánh Demo"

# username -> (role, full_name). Password CHỈ dùng cho dev local, đổi ngay
# nếu seed lên môi trường khác. "admin" giữ nguyên tên đăng nhập cũ cho quen,
# role thật là SUPERVISOR (full access, không phải role riêng "admin").
SEED_STAFF: dict[str, tuple[str, str]] = {
    "admin": ("SUPERVISOR", "Supervisor Demo"),
    "cashier": ("CASHIER", "Cashier Demo"),
    "waiter": ("WAITER", "Waiter Demo"),
    "kitchen": ("KITCHEN", "Kitchen Demo"),
}
SEED_PASSWORD = "password123"


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

        for username, (role, full_name) in SEED_STAFF.items():
            staff = session.execute(
                select(Staff).where(Staff.username == username)
            ).scalar_one_or_none()
            if staff is None:
                staff = Staff(
                    outlet_id=outlet.id,
                    username=username,
                    password_hash=hash_password(SEED_PASSWORD),
                    full_name=full_name,
                    role=role,
                )
                session.add(staff)
                session.flush()
                # Không in password ra log/console dù chỉ dev-only: CodeQL bắt đúng
                # (py/clear-text-logging-sensitive-data) — output có thể lọt vào lịch sử
                # terminal/CI log. Dev tự xem hằng số SEED_PASSWORD trong file này.
                print(f"+ staff {role}: {staff.id} (username={username})")
            else:
                print(f"= staff {role} đã tồn tại: {staff.id} (username={username})")

        station = session.execute(
            select(KitchenStation).where(
                KitchenStation.outlet_id == outlet.id, KitchenStation.name == "Bếp chính"
            )
        ).scalar_one_or_none()
        if station is None:
            station = KitchenStation(outlet_id=outlet.id, name="Bếp chính")
            session.add(station)
            session.flush()
            print(f"+ kitchen_station: {station.id}")
        else:
            print(f"= kitchen_station đã tồn tại: {station.id}")

        menu_item = session.execute(
            select(MenuItem).where(MenuItem.outlet_id == outlet.id, MenuItem.name == "Phở bò")
        ).scalar_one_or_none()
        if menu_item is None:
            menu_item = MenuItem(
                outlet_id=outlet.id, station_id=station.id, name="Phở bò", price="45000.00"
            )
            session.add(menu_item)
            session.flush()
            print(f"+ menu_item: {menu_item.id}")
        else:
            print(f"= menu_item đã tồn tại: {menu_item.id}")

        table = session.execute(
            select(RestaurantTable).where(
                RestaurantTable.outlet_id == outlet.id, RestaurantTable.code == "B1"
            )
        ).scalar_one_or_none()
        if table is None:
            table = RestaurantTable(outlet_id=outlet.id, code="B1", seats=4, status="AVAILABLE")
            session.add(table)
            session.flush()
            print(f"+ restaurant_table: {table.id}")
        else:
            print(f"= restaurant_table đã tồn tại: {table.id}")

        session.commit()

        print("\n--- Dùng để test API ---")
        print(f"table_id     = {table.id}")
        print(f"menu_item_id = {menu_item.id}")
        # Không in giá trị password thật ra log (xem lý do ở comment phía trên) — xem
        # hằng số SEED_PASSWORD trong file này để lấy password dùng chung cho dev/test.
        print("Tất cả tài khoản dùng chung 1 password — xem SEED_PASSWORD trong file này.")
        for username, (role, _) in SEED_STAFF.items():
            print(f'  {role:<10} -> POST /api/v1/auth/login  {{"username": "{username}"}}')


if __name__ == "__main__":
    main()
