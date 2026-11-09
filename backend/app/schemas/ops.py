from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class RouteMetricsOut(BaseModel):
    route: str
    count: int
    client_errors: int
    server_errors: int
    p50_ms: float | None = None
    p95_ms: float | None = None


class ApiMetricsOut(BaseModel):
    """Tính từ `since` (lúc tiến trình API khởi động, deploy là reset). `routes` là 20 route
    chậm nhất theo p95."""

    since: datetime
    requests: int
    server_errors: int
    error_rate: float
    p50_ms: float | None = None
    p95_ms: float | None = None
    routes: list[RouteMetricsOut]


class KitchenMetricsOut(BaseModel):
    """Món trễ = nấu (PREPARING tới READY) lâu hơn `late_after_minutes` (ngưỡng DELAYED)."""

    late_after_minutes: int
    finished: int
    late: int
    late_rate: float | None = None
    cooking_over_threshold: int


class PaymentMetricsOut(BaseModel):
    """`success_rate` = thành công / (thành công + thất bại). Lần hủy (thu ngân sửa ghi nhầm)
    và lần đang chờ không tính."""

    by_status: dict[str, int]
    succeeded: int
    failed: int
    success_rate: float | None = None


class AlertOut(BaseModel):
    code: str
    message: str
    value: float
    threshold: float


class OpsMetricsOut(BaseModel):
    generated_at: datetime
    window_hours: int
    api: ApiMetricsOut
    kitchen: KitchenMetricsOut
    payments: PaymentMetricsOut
    alerts: list[AlertOut]
