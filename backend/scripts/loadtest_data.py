#!/usr/bin/env python3
"""Dữ liệu cho bài test chịu tải (SDD R4): một outlet riêng "Load test", không đụng dữ liệu QA.

  prepare --tables 200   tạo outlet, trạm bếp, 5 món, bàn LT-001..LT-200 và 4 tài khoản
                         lt_cashier, lt_waiter, lt_kitchen, lt_supervisor. Mật khẩu lấy từ env
                         LOADTEST_PASSWORD (bắt buộc, tối thiểu 8 ký tự, không in ra log).
                         Chạy lại được: chỉ thêm phần còn thiếu, đưa mọi bàn về AVAILABLE.
  verify                 sau khi chạy Locust: tìm ghi trùng trong outlet Load test (phiếu bếp
                         trùng, phiên bàn mở trùng, thu tiền vượt tổng đơn). Có lỗi thì exit 1.
  cleanup                xóa đơn, phiên bàn, thanh toán, phiếu bếp, audit của outlet Load test
                         và Idempotency-Key bắt đầu bằng "lt-". Giữ outlet, bàn, món, tài khoản
                         để chạy lại. Mặc định chỉ in số dòng sẽ xóa; thêm --yes để xóa thật.

Chỉ chạy khi APP_ENV là development, staging hoặc test. Trên staging:
  docker compose --env-file .env.staging -f infra/compose/compose.staging.yml \\
    exec -e LOADTEST_PASSWORD api python scripts/loadtest_data.py prepare --tables 200
"""

from __future__ import annotations

import argparse
import os
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, func, select  # noqa: E402

from app.core.config import APP_ENV  # noqa: E402
from app.core.security import hash_password, verify_password  # noqa: E402
from app.db.models import (  # noqa: E402
    AuditLog,
    IdempotencyKey,
    KitchenQueue,
    KitchenStation,
    MenuItem,
    Order,
    OrderItem,
    OrderItemModifier,
    OrderReward,
    OrderVersion,
    Outlet,
    Payment,
    PaymentRefund,
    PointsLedger,
    RestaurantTable,
    Staff,
    TableSession,
)

ALLOWED_ENVS = ("development", "staging", "test")
OUTLET_NAME = "Load test"
TABLE_PREFIX = "LT-"
KEY_PREFIX = "lt-"
STAFF = {
    "lt_cashier": ("CASHIER", "Cashier load test"),
    "lt_waiter": ("WAITER", "Waiter load test"),
    "lt_kitchen": ("KITCHEN", "Kitchen load test"),
    "lt_supervisor": ("SUPERVISOR", "Supervisor load test"),
}
MENU = (
    ("LT Phở bò", "65000"),
    ("LT Cơm gà", "55000"),
    ("LT Bún chả", "60000"),
    ("LT Trà đá", "5000"),
    ("LT Cà phê sữa", "25000"),
)
_MIN_PASSWORD_CHARS = 8


def _outlet(session) -> Outlet | None:
    return session.execute(select(Outlet).where(Outlet.name == OUTLET_NAME)).scalar_one_or_none()


def prepare(session, table_count: int) -> None:
    password = os.getenv("LOADTEST_PASSWORD", "")
    if len(password) < _MIN_PASSWORD_CHARS:
        sys.exit(f"Cần env LOADTEST_PASSWORD tối thiểu {_MIN_PASSWORD_CHARS} ký tự")

    outlet = _outlet(session)
    if outlet is None:
        outlet = Outlet(name=OUTLET_NAME, address="Dữ liệu test chịu tải, không dùng cho QA")
        session.add(outlet)
        session.flush()
        print(f"+ outlet {OUTLET_NAME}: {outlet.id}")

    for username, (role, full_name) in STAFF.items():
        staff = session.execute(
            select(Staff).where(Staff.username == username)
        ).scalar_one_or_none()
        if staff is None:
            session.add(
                Staff(
                    outlet_id=outlet.id,
                    username=username,
                    password_hash=hash_password(password),
                    full_name=full_name,
                    role=role,
                )
            )
            print(f"+ tài khoản {username} ({role})")
        elif staff.outlet_id != outlet.id:
            sys.exit(f"Tài khoản {username} đã có ở outlet khác, dừng để không đụng dữ liệu thật")
        elif not verify_password(password, staff.password_hash):
            staff.password_hash = hash_password(password)
            staff.is_active = True
            staff.token_version += 1
            print(f"~ tài khoản {username}: đặt lại mật khẩu theo LOADTEST_PASSWORD")

    station = session.execute(
        select(KitchenStation).where(KitchenStation.outlet_id == outlet.id)
    ).scalars().first()
    if station is None:
        station = KitchenStation(outlet_id=outlet.id, name="Bếp load test")
        session.add(station)
        session.flush()

    existing_items = set(
        session.scalars(select(MenuItem.name).where(MenuItem.outlet_id == outlet.id))
    )
    for name, price in MENU:
        if name not in existing_items:
            session.add(
                MenuItem(
                    outlet_id=outlet.id, station_id=station.id, name=name, price=Decimal(price)
                )
            )

    existing_tables = {
        t.code: t
        for t in session.scalars(
            select(RestaurantTable).where(RestaurantTable.outlet_id == outlet.id)
        )
    }
    added = 0
    for n in range(1, table_count + 1):
        code = f"{TABLE_PREFIX}{n:03d}"
        if code not in existing_tables:
            session.add(RestaurantTable(outlet_id=outlet.id, code=code, seats=4))
            added += 1
    for table in existing_tables.values():
        table.status = "AVAILABLE"
        table.merged_into_table_id = None
    session.commit()
    total = len(existing_tables) + added
    print(f"= {total} bàn {TABLE_PREFIX}xxx (thêm {added}), 5 món, 4 tài khoản")


def verify(session) -> int:
    outlet = _outlet(session)
    if outlet is None:
        sys.exit("Chưa có outlet Load test, chạy prepare trước")
    orders_q = (
        select(Order.id)
        .join(TableSession, Order.table_session_id == TableSession.id)
        .join(RestaurantTable, TableSession.table_id == RestaurantTable.id)
        .where(RestaurantTable.outlet_id == outlet.id)
    )
    problems = 0

    dup_tickets = session.execute(
        select(KitchenQueue.order_item_id, func.count())
        .join(OrderItem, KitchenQueue.order_item_id == OrderItem.id)
        .where(OrderItem.order_id.in_(orders_q), KitchenQueue.status != "CANCELLED")
        .group_by(KitchenQueue.order_item_id)
        .having(func.count() > 1)
    ).all()
    # Món làm lại (refire) có phiếu mới; bài test không refire nên mọi món chỉ có 1 phiếu.
    print(f"Món có hơn 1 phiếu bếp: {len(dup_tickets)}")
    problems += len(dup_tickets)

    dup_sessions = session.execute(
        select(TableSession.table_id, func.count())
        .join(RestaurantTable, TableSession.table_id == RestaurantTable.id)
        .where(RestaurantTable.outlet_id == outlet.id, TableSession.status == "OPEN")
        .group_by(TableSession.table_id)
        .having(func.count() > 1)
    ).all()
    print(f"Bàn có hơn 1 phiên đang mở: {len(dup_sessions)}")
    problems += len(dup_sessions)

    item_totals = dict(
        session.execute(
            select(OrderItem.order_id, func.sum(OrderItem.unit_price * OrderItem.quantity))
            .where(OrderItem.order_id.in_(orders_q), OrderItem.status != "VOIDED")
            .group_by(OrderItem.order_id)
        ).all()
    )
    collected = session.execute(
        select(Payment.order_id, func.sum(Payment.amount), func.count())
        .where(
            Payment.outlet_id == outlet.id, Payment.status.in_(("SUCCEEDED", "REFUNDED"))
        )
        .group_by(Payment.order_id)
    ).all()
    overpaid = [
        order_id
        for order_id, amount, _ in collected
        if Decimal(amount) > Decimal(item_totals.get(order_id) or 0)
    ]
    print(f"Đơn thu tiền vượt tổng món: {len(overpaid)}")
    problems += len(overpaid)

    paid = session.scalar(
        select(func.count()).where(Order.id.in_(orders_q), Order.status.in_(("PAID", "CLOSED")))
    )
    total = session.scalar(select(func.count()).where(Order.id.in_(orders_q)))
    stuck = session.scalar(
        select(func.count()).where(
            RestaurantTable.outlet_id == outlet.id, RestaurantTable.status != "AVAILABLE"
        )
    )
    print(f"Đơn đã thanh toán: {paid}/{total}; bàn chưa về AVAILABLE: {stuck} (Locust dừng giữa")
    print("chừng thì còn bàn đang dở, không tính là lỗi)")
    print("KẾT QUẢ:", "KHÔNG có ghi trùng" if problems == 0 else f"{problems} lỗi ghi trùng")
    return 0 if problems == 0 else 1


def cleanup(session, really: bool) -> None:
    outlet = _outlet(session)
    if outlet is None:
        sys.exit("Chưa có outlet Load test")
    sessions_q = (
        select(TableSession.id)
        .join(RestaurantTable, TableSession.table_id == RestaurantTable.id)
        .where(RestaurantTable.outlet_id == outlet.id)
    )
    orders_q = select(Order.id).where(Order.table_session_id.in_(sessions_q))
    items_q = select(OrderItem.id).where(OrderItem.order_id.in_(orders_q))
    steps = (
        ("payment_refund", delete(PaymentRefund).where(PaymentRefund.order_id.in_(orders_q))),
        ("payment", delete(Payment).where(Payment.order_id.in_(orders_q))),
        ("points_ledger", delete(PointsLedger).where(PointsLedger.order_id.in_(orders_q))),
        ("order_reward", delete(OrderReward).where(OrderReward.order_id.in_(orders_q))),
        ("kitchen_queue", delete(KitchenQueue).where(KitchenQueue.order_item_id.in_(items_q))),
        ("order_version", delete(OrderVersion).where(OrderVersion.order_id.in_(orders_q))),
        (
            "order_item_modifier",
            delete(OrderItemModifier).where(OrderItemModifier.order_item_id.in_(items_q)),
        ),
        ("order_item", delete(OrderItem).where(OrderItem.order_id.in_(orders_q))),
        ("order", delete(Order).where(Order.id.in_(orders_q))),
        ("table_session", delete(TableSession).where(TableSession.id.in_(sessions_q))),
        ("audit_log", delete(AuditLog).where(AuditLog.outlet_id == outlet.id)),
        (
            "idempotency_key",
            delete(IdempotencyKey).where(IdempotencyKey.key.like(f"{KEY_PREFIX}%")),
        ),
    )
    for name, stmt in steps:
        count = session.scalar(select(func.count()).select_from(stmt.table).where(stmt.whereclause))
        print(f"{'-' if really else '?'} {name}: {count} dòng")
        if really:
            session.execute(stmt.execution_options(synchronize_session=False))
    if really:
        for table in session.scalars(
            select(RestaurantTable).where(RestaurantTable.outlet_id == outlet.id)
        ):
            table.status = "AVAILABLE"
            table.merged_into_table_id = None
        session.commit()
        print("Đã xóa dữ liệu giao dịch của outlet Load test")
    else:
        print("Chưa xóa gì. Thêm --yes để xóa thật")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--tables", type=int, default=200)
    sub.add_parser("verify")
    c = sub.add_parser("cleanup")
    c.add_argument("--yes", action="store_true", help="xóa thật (mặc định chỉ đếm)")
    args = parser.parse_args()

    if APP_ENV not in ALLOWED_ENVS:
        sys.exit(f"APP_ENV={APP_ENV}: chỉ chạy trên {', '.join(ALLOWED_ENVS)}")
    from app.db.base import SessionLocal

    if SessionLocal is None:
        sys.exit("Chưa cấu hình database (DATABASE_URL hoặc DB_*)")
    with SessionLocal() as session:
        if args.command == "prepare":
            if not 1 <= args.tables <= 500:
                sys.exit("--tables trong khoảng 1..500")
            prepare(session, args.tables)
        elif args.command == "verify":
            sys.exit(verify(session))
        else:
            cleanup(session, args.yes)


if __name__ == "__main__":
    main()
