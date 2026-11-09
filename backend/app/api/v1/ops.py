"""Báo cáo giám sát cho Supervisor (SDD R3, BRD "Monitoring & Alerting").

GET /api/v1/ops/metrics?hours=24
  - api: số request, tỉ lệ lỗi 5xx, độ trễ p50/p95 theo route, tính từ lúc tiến trình khởi
    động (deploy là reset);
  - kitchen: trong `hours` giờ gần nhất, số món nấu xong, số món trễ (nấu lâu hơn ngưỡng
    DELAYED), tỉ lệ trễ, và số món đang nấu đã quá ngưỡng;
  - payments: trong `hours` giờ gần nhất, số lần theo trạng thái, tỉ lệ thành công;
  - alerts: các chỉ số vượt ngưỡng (cấu hình qua env ALERT_*).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import (
    ALERT_API_ERROR_RATE,
    ALERT_KITCHEN_LATE_RATE,
    ALERT_MIN_SAMPLES,
    ALERT_PAYMENT_SUCCESS_RATE,
    KDS_SLA_DELAYED_MINUTES,
)
from app.core.deps import CurrentStaff, require_permission
from app.core.observability import metrics
from app.core.permissions import Permission
from app.db.base import get_session
from app.db.models import KitchenQueue, KitchenStation, Payment
from app.schemas.ops import (
    AlertOut,
    ApiMetricsOut,
    KitchenMetricsOut,
    OpsMetricsOut,
    PaymentMetricsOut,
)

router = APIRouter(prefix="/ops", tags=["ops"])

# Lần hủy là thu ngân sửa ghi nhầm, không phải thanh toán thất bại; PENDING chưa có kết quả.
_PAYMENT_FAILED = ("FAILED", "UNKNOWN", "EXPIRED")
_PAYMENT_SUCCEEDED = ("SUCCEEDED", "REFUNDED")


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:  # SQLite trả datetime naive (UTC)
        return value.replace(tzinfo=timezone.utc)
    return value


def _rate(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


def _kitchen(session: Session, outlet_id, since: datetime, now: datetime) -> KitchenMetricsOut:
    late_after = timedelta(minutes=KDS_SLA_DELAYED_MINUTES)
    rows = session.execute(
        select(KitchenQueue.status, KitchenQueue.started_at, KitchenQueue.done_at)
        .join(KitchenStation, KitchenQueue.station_id == KitchenStation.id)
        .where(
            KitchenStation.outlet_id == outlet_id,
            KitchenQueue.started_at.is_not(None),
            (KitchenQueue.done_at >= since) | (KitchenQueue.status == "IN_PROGRESS"),
        )
    ).all()
    finished = late = cooking_late = 0
    for queue_status, started_at, done_at in rows:
        started_at, done_at = _aware(started_at), _aware(done_at)
        if queue_status == "DONE" and done_at is not None:
            finished += 1
            late += done_at - started_at > late_after
        elif queue_status == "IN_PROGRESS":
            cooking_late += now - started_at > late_after
    return KitchenMetricsOut(
        late_after_minutes=KDS_SLA_DELAYED_MINUTES,
        finished=finished,
        late=late,
        late_rate=_rate(late, finished),
        cooking_over_threshold=cooking_late,
    )


def _payments(session: Session, outlet_id, since: datetime) -> PaymentMetricsOut:
    by_status = dict(
        session.execute(
            select(Payment.status, func.count())
            .where(Payment.outlet_id == outlet_id, Payment.created_at >= since)
            .group_by(Payment.status)
        )
        .tuples()
        .all()
    )
    succeeded = sum(by_status.get(s, 0) for s in _PAYMENT_SUCCEEDED)
    failed = sum(by_status.get(s, 0) for s in _PAYMENT_FAILED)
    return PaymentMetricsOut(
        by_status=by_status,
        succeeded=succeeded,
        failed=failed,
        success_rate=_rate(succeeded, succeeded + failed),
    )


def _alerts(api: dict, kitchen: KitchenMetricsOut, payments: PaymentMetricsOut) -> list[AlertOut]:
    alerts: list[AlertOut] = []
    if api["requests"] >= ALERT_MIN_SAMPLES and api["error_rate"] > ALERT_API_ERROR_RATE:
        alerts.append(
            AlertOut(
                code="API_ERROR_RATE",
                message="Tỉ lệ lỗi hệ thống (5xx) của API cao",
                value=api["error_rate"],
                threshold=ALERT_API_ERROR_RATE,
            )
        )
    attempts = payments.succeeded + payments.failed
    if (
        attempts >= ALERT_MIN_SAMPLES
        and payments.success_rate is not None
        and payments.success_rate < ALERT_PAYMENT_SUCCESS_RATE
    ):
        alerts.append(
            AlertOut(
                code="PAYMENT_SUCCESS_RATE",
                message="Tỉ lệ thanh toán thành công thấp",
                value=payments.success_rate,
                threshold=ALERT_PAYMENT_SUCCESS_RATE,
            )
        )
    if (
        kitchen.finished >= ALERT_MIN_SAMPLES
        and kitchen.late_rate is not None
        and kitchen.late_rate > ALERT_KITCHEN_LATE_RATE
    ):
        alerts.append(
            AlertOut(
                code="KITCHEN_LATE_RATE",
                message="Tỉ lệ món trễ ở bếp cao",
                value=kitchen.late_rate,
                threshold=ALERT_KITCHEN_LATE_RATE,
            )
        )
    return alerts


@router.get("/metrics", response_model=OpsMetricsOut)
def ops_metrics(
    hours: int = Query(24, ge=1, le=168, description="Số giờ gần nhất cho số liệu bếp, thanh toán"),
    current: CurrentStaff = Depends(require_permission(Permission.AUDIT_READ)),
    session: Session = Depends(get_session),
) -> OpsMetricsOut:
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=hours)
    api = metrics.snapshot()
    kitchen = _kitchen(session, current.outlet_id, since, now)
    payments = _payments(session, current.outlet_id, since)
    return OpsMetricsOut(
        generated_at=now,
        window_hours=hours,
        api=ApiMetricsOut(**{**api, "routes": api["routes"][:20]}),
        kitchen=kitchen,
        payments=payments,
        alerts=_alerts(api, kitchen, payments),
    )
