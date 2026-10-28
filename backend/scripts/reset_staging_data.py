#!/usr/bin/env python3
"""Reset dữ liệu giao dịch trên staging/local về trạng thái sạch để QA test lại
và để diễn tập/demo (sơ đồ bàn trống, hàng đợi bếp trống).

XÓA: table_session, order, order_item, order_version, kitchen_queue,
idempotency_key (tức mọi phiên bàn, đơn, món, phiếu bếp đã tạo khi test).
ĐƯA VỀ: mọi bàn AVAILABLE, mọi món menu is_available = true.
GIỮ NGUYÊN: outlet, tài khoản staff, menu/nhóm món/trạm bếp, audit_log (lịch sử
thao tác không bị xóa; script ghi thêm 1 dòng STAGING_DATA_RESET).

Tùy chọn --purge-extra-menu xóa món và nhóm món KHÔNG thuộc menu mẫu của
seed_dev_data.py (SEED_MENU), vd món do test tự động tạo qua POST /menu. Mặc
định tắt; dry-run in ra tên những món sẽ bị xóa.

Tùy chọn --with-fixtures tạo sẵn dữ liệu mẫu cho các test case cần trạng thái
khó dựng tay (refire TC_EXT_012/013, SLA TC_EXT_014):
- bàn B6: order SERVED, 2 món đã SERVED (dùng để test refire);
- bàn B5: order SENT, 3 món: 1 món chờ bếp (QUEUED), 1 món đang nấu 9 phút
  (SLA WARNING), 1 món đang nấu 16 phút (SLA CRITICAL).
- bàn Q2-1 (chi nhánh QA 2, không có menu): order NEW rỗng để test truy cập
  chéo chi nhánh.
- chi nhánh QA 3: món QA3_SOLD_OUT_ITEM (seed_dev_data.py) đặt hết hàng, để test
  gọi món hết hàng mà không đụng chi nhánh demo.
B1–B4 để trống cho test thủ công.

Không bao giờ chạy với APP_ENV=production. Mặc định chỉ in ra sẽ xóa gì
(dry-run); phải thêm --yes mới thực sự ghi.

Chạy trên staging: GitHub → Actions → "Reset staging data" → Run workflow
(không cần SSH). Chạy local (PowerShell, sau khi đã seed):
    cd backend
    $env:DATABASE_URL = "sqlite:///./test_local.db"
    python scripts/reset_staging_data.py            # xem trước
    python scripts/reset_staging_data.py --yes --with-fixtures
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, func, select, update  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.audit import write_audit_log  # noqa: E402
from app.core.config import APP_ENV  # noqa: E402
from app.db.models import (  # noqa: E402
    IdempotencyKey,
    KitchenQueue,
    MenuCategory,
    MenuItem,
    Order,
    OrderItem,
    OrderVersion,
    Outlet,
    RestaurantTable,
    Staff,
    TableSession,
)

ALLOWED_ENVS = ("development", "staging", "test")

# Xóa con trước cha để không vướng khóa ngoại.
_WIPE_ORDER = (
    ("kitchen_queue", KitchenQueue),
    ("order_version", OrderVersion),
    ("order_item", OrderItem),
    ("order", Order),
    ("table_session", TableSession),
    ("idempotency_key", IdempotencyKey),
)

# Bàn dùng cho fixture; nằm trong 6 bàn B1–B6 của seed_dev_data.py.
FIXTURE_SERVED_TABLE = "B6"
FIXTURE_KITCHEN_TABLE = "B5"
FIXTURE_OTHER_OUTLET_TABLE = "Q2-1"  # bàn của chi nhánh QA 2 (seed_dev_data.py)


@dataclass
class ResetResult:
    deleted: dict[str, int] = field(default_factory=dict)
    tables_reset: int = 0
    menu_items_reenabled: int = 0
    menu_items_purged: list[str] = field(default_factory=list)
    categories_purged: list[str] = field(default_factory=list)
    fixtures: list[str] = field(default_factory=list)


def ensure_env_allowed(app_env: str) -> None:
    if app_env not in ALLOWED_ENVS:
        raise SystemExit(
            f"Từ chối chạy: APP_ENV='{app_env}'. Script chỉ dành cho {', '.join(ALLOWED_ENVS)}."
        )


def _seed_module():
    """Nạp seed_dev_data.py để dùng chung hằng số (menu mẫu, chi nhánh QA)."""
    path = Path(__file__).resolve().with_name("seed_dev_data.py")
    spec = importlib.util.spec_from_file_location("seed_dev_data", path)
    seed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed)
    return seed


def seed_menu_names() -> tuple[set[str], set[str]]:
    """(tên món, tên nhóm món) của menu mẫu — lấy thẳng từ seed_dev_data.py để
    hai script không lệch nhau."""
    seed = _seed_module()
    items = {name for _order, dishes in seed.SEED_MENU.values() for name, _p, _s in dishes}
    return items, set(seed.SEED_MENU)


def _extra_menu(session: Session) -> tuple[list[MenuItem], list[MenuCategory]]:
    """Món/nhóm món ngoài menu mẫu. Nhóm chỉ bị xóa khi không còn món nào thuộc
    menu mẫu trỏ tới nó."""
    keep_items, keep_categories = seed_menu_names()
    items = list(
        session.scalars(
            select(MenuItem).where(MenuItem.name.not_in(keep_items)).order_by(MenuItem.name)
        )
    )
    kept_category_ids = set(
        session.scalars(
            select(MenuItem.category_id).where(
                MenuItem.name.in_(keep_items), MenuItem.category_id.is_not(None)
            )
        )
    )
    categories = [
        category
        for category in session.scalars(
            select(MenuCategory)
            .where(MenuCategory.name.not_in(keep_categories))
            .order_by(MenuCategory.name)
        )
        if category.id not in kept_category_ids
    ]
    return items, categories


def count_targets(session: Session) -> ResetResult:
    """Đếm những gì sẽ bị xóa/đổi, không ghi gì (dùng cho dry-run)."""
    result = ResetResult()
    for name, model in _WIPE_ORDER:
        result.deleted[name] = session.scalar(select(func.count()).select_from(model)) or 0
    result.tables_reset = (
        session.scalar(
            select(func.count())
            .select_from(RestaurantTable)
            .where(RestaurantTable.status != "AVAILABLE")
        )
        or 0
    )
    result.menu_items_reenabled = (
        session.scalar(
            select(func.count()).select_from(MenuItem).where(MenuItem.is_available.is_(False))
        )
        or 0
    )
    return result


def reset_transactional_data(session: Session) -> ResetResult:
    result = count_targets(session)
    for _name, model in _WIPE_ORDER:
        session.execute(delete(model))
    session.execute(update(RestaurantTable).values(status="AVAILABLE", merged_into_table_id=None))
    session.execute(update(MenuItem).values(is_available=True))
    session.flush()
    return result


def _snapshot(order: Order, items: list[OrderItem]) -> str:
    """Cùng định dạng snapshot với app/api/v1/orders.py (_snapshot_order)."""
    return json.dumps(
        {
            "order_id": str(order.id),
            "status": order.status,
            "items": [
                {
                    "id": str(item.id),
                    "menu_item_id": str(item.menu_item_id),
                    "status": item.status,
                    "quantity": item.quantity,
                    "unit_price": str(item.unit_price),
                    "note": item.note,
                }
                for item in items
            ],
        }
    )


def _open_fixture_order(
    session: Session, table: RestaurantTable, staff_id, order_status: str
) -> tuple[TableSession, Order]:
    table.status = "OCCUPIED"
    table_session = TableSession(
        table_id=table.id, status="OPEN", guest_count=2, opened_by_staff_id=staff_id
    )
    session.add(table_session)
    session.flush()
    order = Order(
        table_session_id=table_session.id,
        status=order_status,
        current_version=1,
        created_by_staff_id=staff_id,
    )
    session.add(order)
    session.flush()
    return table_session, order


def _add_item(
    session: Session,
    order: Order,
    menu_item: MenuItem,
    item_status: str,
    queue_status: str,
    started_minutes_ago: float | None,
    now: datetime,
) -> OrderItem:
    item = OrderItem(
        order_id=order.id,
        menu_item_id=menu_item.id,
        status=item_status,
        quantity=1,
        unit_price=menu_item.price,
        note="QA fixture",
    )
    session.add(item)
    session.flush()
    started_at = (
        None if started_minutes_ago is None else now - timedelta(minutes=started_minutes_ago)
    )
    session.add(
        KitchenQueue(
            order_item_id=item.id,
            station_id=menu_item.station_id,
            status=queue_status,
            queued_at=now - timedelta(minutes=(started_minutes_ago or 0) + 1),
            started_at=started_at,
            done_at=now if queue_status == "DONE" else None,
        )
    )
    return item


def create_fixtures(session: Session) -> list[str]:
    """Tạo 2 order mẫu trên B5/B6 của outlet đầu tiên có đủ bàn + món có trạm bếp."""
    tables = {
        table.code: table
        for table in session.scalars(
            select(RestaurantTable).where(
                RestaurantTable.code.in_((FIXTURE_SERVED_TABLE, FIXTURE_KITCHEN_TABLE))
            )
        )
    }
    if set(tables) != {FIXTURE_SERVED_TABLE, FIXTURE_KITCHEN_TABLE}:
        raise SystemExit(
            f"Thiếu bàn {FIXTURE_SERVED_TABLE}/{FIXTURE_KITCHEN_TABLE} — "
            "chạy seed_dev_data.py trước."
        )
    outlet_id = tables[FIXTURE_SERVED_TABLE].outlet_id
    menu = list(
        session.scalars(
            select(MenuItem)
            .where(MenuItem.outlet_id == outlet_id, MenuItem.station_id.is_not(None))
            .order_by(MenuItem.name)
        )
    )
    if len(menu) < 3:
        raise SystemExit("Cần ít nhất 3 món đã gán trạm bếp — chạy seed_dev_data.py trước.")
    staff_id = session.scalar(
        select(Staff.id).where(Staff.outlet_id == outlet_id, Staff.role == "SUPERVISOR")
    )
    now = datetime.now(timezone.utc)
    lines: list[str] = []

    _, served_order = _open_fixture_order(
        session, tables[FIXTURE_SERVED_TABLE], staff_id, order_status="SERVED"
    )
    served_items = [
        _add_item(session, served_order, menu[i], "SERVED", "DONE", 20, now) for i in (0, 1)
    ]

    _, kitchen_order = _open_fixture_order(
        session, tables[FIXTURE_KITCHEN_TABLE], staff_id, order_status="SENT"
    )
    kitchen_items = [
        _add_item(session, kitchen_order, menu[0], "SENT", "QUEUED", None, now),
        _add_item(session, kitchen_order, menu[1], "PREPARING", "IN_PROGRESS", 9, now),
        _add_item(session, kitchen_order, menu[2], "PREPARING", "IN_PROGRESS", 16, now),
    ]
    session.flush()

    for order, items in ((served_order, served_items), (kitchen_order, kitchen_items)):
        session.add(
            OrderVersion(
                order_id=order.id,
                version_number=1,
                snapshot=_snapshot(order, items),
                created_by_staff_id=staff_id,
            )
        )

    lines.append(f"{FIXTURE_SERVED_TABLE}: order SERVED (test refire) order_id={served_order.id}")
    for item in served_items:
        lines.append(f"    món SERVED item_id={item.id}")
    lines.append(f"{FIXTURE_KITCHEN_TABLE}: order SENT (test bếp/SLA) order_id={kitchen_order.id}")
    for item, label in zip(
        kitchen_items, ("chờ bếp QUEUED", "đang nấu 9' → WARNING", "đang nấu 16' → CRITICAL")
    ):
        lines.append(f"    món {label} item_id={item.id}")

    # Chi nhánh QA 2 (seed_dev_data.py tạo, không có menu): 1 order rỗng trên Q2-1 để
    # thử truy cập chéo chi nhánh (TC_EXT_019) — tài khoản chi nhánh 1 gọi phải 404.
    q2_table = session.scalar(
        select(RestaurantTable).where(RestaurantTable.code == FIXTURE_OTHER_OUTLET_TABLE)
    )
    if q2_table is not None:
        q2_staff = session.scalar(
            select(Staff.id).where(
                Staff.outlet_id == q2_table.outlet_id, Staff.role == "SUPERVISOR"
            )
        )
        _, q2_order = _open_fixture_order(session, q2_table, q2_staff, order_status="NEW")
        lines.append(
            f"{FIXTURE_OTHER_OUTLET_TABLE} (chi nhánh QA 2): order NEW rỗng order_id={q2_order.id}"
        )

    # Chi nhánh QA 3 (đủ menu): 1 món hết hàng để test gọi món hết hàng. Reset vừa
    # bật lại mọi món nên phải đặt lại sau bước đó.
    seed = _seed_module()
    sold_out = session.scalar(
        select(MenuItem)
        .join(Outlet, MenuItem.outlet_id == Outlet.id)
        .where(Outlet.name == seed.QA3_OUTLET_NAME, MenuItem.name == seed.QA3_SOLD_OUT_ITEM)
    )
    if sold_out is not None:
        sold_out.is_available = False
        lines.append(f"Chi nhánh QA 3: món hết hàng '{sold_out.name}' menu_item_id={sold_out.id}")
    return lines


def purge_extra_menu(session: Session, result: ResetResult, *, apply: bool) -> None:
    items, categories = _extra_menu(session)
    result.menu_items_purged = [item.name for item in items]
    result.categories_purged = [category.name for category in categories]
    if not apply:
        return
    # Chạy sau reset_transactional_data: order_item (khóa ngoại tới món) đã bị xóa.
    for item in items:
        session.delete(item)
    session.flush()
    for category in categories:
        session.delete(category)
    session.flush()


def run(
    session: Session, *, apply: bool, with_fixtures: bool, purge_menu: bool = False
) -> ResetResult:
    if not apply:
        result = count_targets(session)
        if purge_menu:
            purge_extra_menu(session, result, apply=False)
        return result
    result = reset_transactional_data(session)
    if purge_menu:
        purge_extra_menu(session, result, apply=True)
    if with_fixtures:
        result.fixtures = create_fixtures(session)
    outlet_id = session.scalar(select(RestaurantTable.outlet_id).limit(1))
    write_audit_log(
        session,
        outlet_id=outlet_id,
        staff_id=None,
        action="STAGING_DATA_RESET",
        entity_type="system",
        entity_id="reset",
        payload={
            "deleted": result.deleted,
            "tables_reset": result.tables_reset,
            "with_fixtures": with_fixtures,
            "menu_items_purged": result.menu_items_purged,
            "categories_purged": result.categories_purged,
        },
    )
    session.commit()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--yes", action="store_true", help="Thực sự xóa (mặc định chỉ xem trước)")
    parser.add_argument(
        "--with-fixtures", action="store_true", help="Tạo sẵn order mẫu trên B5/B6 sau khi reset"
    )
    parser.add_argument(
        "--purge-extra-menu",
        action="store_true",
        help="Xóa món/nhóm món không thuộc menu mẫu của seed_dev_data.py",
    )
    args = parser.parse_args()
    ensure_env_allowed(APP_ENV)

    from app.db.base import SessionLocal

    if SessionLocal is None:
        raise SystemExit("Chưa cấu hình database (DATABASE_URL hoặc DB_*).")

    with SessionLocal() as session:
        result = run(
            session,
            apply=args.yes,
            with_fixtures=args.with_fixtures,
            purge_menu=args.purge_extra_menu,
        )

    mode = "ĐÃ RESET" if args.yes else "XEM TRƯỚC (chưa ghi gì — thêm --yes để chạy thật)"
    print(f"[{APP_ENV}] {mode}")
    for name, count in result.deleted.items():
        print(f"  xóa {name}: {count}")
    print(f"  bàn đưa về AVAILABLE: {result.tables_reset}")
    print(f"  món bật lại is_available: {result.menu_items_reenabled}")
    if args.purge_extra_menu:
        print(f"  xóa món ngoài menu mẫu: {len(result.menu_items_purged)}")
        for name in result.menu_items_purged:
            print(f"    - {name}")
        print(f"  xóa nhóm món ngoài menu mẫu: {len(result.categories_purged)}")
        for name in result.categories_purged:
            print(f"    - {name}")
    if result.fixtures:
        print("Dữ liệu mẫu cho QA:")
        for line in result.fixtures:
            print(f"  {line}")


if __name__ == "__main__":
    main()
