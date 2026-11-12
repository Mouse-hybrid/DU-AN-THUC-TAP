#!/usr/bin/env python3
"""Đối soát VNPay (SDD R2, specs/001-vnpay-sandbox US2): hỏi VNPay cho các lần thanh toán
VNPay đang chờ đã quá hạn link (PENDING) hoặc chưa rõ kết quả (UNKNOWN), rồi ghi kết quả qua
cùng hàm xác nhận với Return URL và nút "Kiểm tra lại" (app/api/v1/vnpay.py).

  PENDING quá hạn + VNPay báo đã trả      → SUCCEEDED (chốt đơn nếu đủ tiền)
  PENDING quá hạn + chưa trả / không có GD → EXPIRED
  PENDING quá hạn + không hỏi được VNPay   → UNKNOWN (lần sau hỏi lại)
  UNKNOWN                                   → hỏi lại tới khi có kết quả

Chạy 10 phút một lần bằng .github/workflows/reconcile-vnpay.yml. VNPay chưa cấu hình thì thoát.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import or_, select  # noqa: E402

from app.api.v1.vnpay import (  # noqa: E402
    confirm_vnpay_payment,
    publish_confirmation,
    query_payment,
    system_actor,
)
from app.core import vnpay  # noqa: E402
from app.db.models import Payment  # noqa: E402

BATCH_LIMIT = 200


def due_payments(session, now: datetime) -> list[Payment]:
    return list(
        session.scalars(
            select(Payment)
            .where(
                Payment.method == "VNPAY",
                or_(
                    (Payment.status == "PENDING") & (Payment.expires_at < now),
                    Payment.status == "UNKNOWN",
                ),
            )
            .order_by(Payment.expires_at)
            .limit(BATCH_LIMIT)
        )
    )


def run(session, now: datetime) -> dict[str, int]:
    counts: dict[str, int] = {}
    for payment in due_payments(session, now):
        result = query_payment(payment)
        actor = system_actor(payment)
        outcome = confirm_vnpay_payment(session, payment.id, result, "reconcile", actor, now)
        session.commit()
        publish_confirmation(actor, outcome)
        counts[outcome.payment.status] = counts.get(outcome.payment.status, 0) + 1
    return counts


def main() -> None:
    if not vnpay.is_configured():
        print("VNPay chưa cấu hình, bỏ qua")
        return
    from app.db.base import SessionLocal

    if SessionLocal is None:
        sys.exit("Chưa cấu hình database (DATABASE_URL hoặc DB_*)")
    with SessionLocal() as session:
        counts = run(session, datetime.now(timezone.utc))
    summary = ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) or "không có lần nào"
    print(f"Đối soát VNPay: {summary}")


if __name__ == "__main__":
    main()
