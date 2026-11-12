#!/usr/bin/env python3
"""Trừ điểm hết hạn (Rewards đợt 3, specs/002-rewards-dot-3 US2).

Duyệt các khách có dòng tích điểm (EARN) đã quá hạn, trừ phần chưa dùng theo thứ tự lô cũ
trước (app/core/loyalty.py: expire_points_for_customer), mỗi khách một dòng EXPIRE và một
dòng audit POINTS_EXPIRED. Chạy lại ngay sau đó không trừ thêm.

  python scripts/expire_points.py            # trừ thật
  python scripts/expire_points.py --dry-run  # chỉ in số điểm sẽ trừ

Chạy hằng ngày lúc 03:00 giờ Việt Nam bằng .github/workflows/expire-points.yml.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.core.audit import write_audit_log  # noqa: E402
from app.core.config import APP_ENV  # noqa: E402
from app.core.loyalty import expire_points_for_customer, expiring_points  # noqa: E402
from app.db.models import Customer, PointsLedger  # noqa: E402

ALLOWED_ENVS = ("development", "staging", "test", "production")
BATCH_SIZE = 500


def customers_with_expired_lots(session, now: datetime) -> list:
    return list(
        session.scalars(
            select(PointsLedger.customer_id)
            .where(
                PointsLedger.entry_type == "EARN",
                PointsLedger.expires_at.is_not(None),
                PointsLedger.expires_at <= now,
            )
            .distinct()
        )
    )


def run(session, now: datetime, dry_run: bool) -> tuple[int, int]:
    """Trả (số khách bị trừ, tổng điểm trừ)."""
    customers = total = 0
    ids = customers_with_expired_lots(session, now)
    for index, customer_id in enumerate(ids, start=1):
        if dry_run:
            customer = session.get(Customer, customer_id)
            amount = expiring_points(session, customer, now)
            if amount:
                print(f"? khách {customer.member_code}: trừ {amount} điểm")
        else:
            entry = expire_points_for_customer(session, customer_id, now)
            amount = -entry.points if entry else 0
            if entry is not None:
                customer = session.get(Customer, customer_id)
                write_audit_log(
                    session,
                    outlet_id=customer.outlet_id,
                    staff_id=None,
                    action="POINTS_EXPIRED",
                    entity_type="customer",
                    entity_id=customer_id,
                    payload={"points": amount, "balance_after": entry.balance_after},
                )
        if amount:
            customers += 1
            total += amount
        if not dry_run and index % BATCH_SIZE == 0:
            session.commit()
    if not dry_run:
        session.commit()
    return customers, total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="chỉ in, không ghi")
    args = parser.parse_args()
    if APP_ENV not in ALLOWED_ENVS:
        sys.exit(f"APP_ENV={APP_ENV}: chỉ chạy trên {', '.join(ALLOWED_ENVS)}")
    from app.db.base import SessionLocal

    if SessionLocal is None:
        sys.exit("Chưa cấu hình database (DATABASE_URL hoặc DB_*)")
    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        customers, total = run(session, now, args.dry_run)
    verb = "Sẽ trừ" if args.dry_run else "Đã trừ"
    print(f"{verb} {total} điểm hết hạn của {customers} khách")


if __name__ == "__main__":
    main()
