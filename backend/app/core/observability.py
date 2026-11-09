"""Giám sát (SDD R3, BRD "Monitoring & Alerting"): request_id, log JSON, số đo API, Sentry.

- Mỗi request có `request_id` (nhận từ header `X-Request-ID` nếu hợp lệ, không thì tự sinh),
  trả lại ở header `X-Request-ID` và có trong mọi dòng log của request đó. Lỗi 500 trả kèm
  `request_id` để QA/FE báo lỗi là tìm được log.
- Log truy cập ghi theo **mẫu route** (`/api/v1/public/qr/{token}/menu`), không ghi đường dẫn
  thật, nên không lộ mã QR; không ghi query string, body hay header.
- Số đo API giữ trong bộ nhớ của tiến trình, tính từ lúc khởi động (reset khi deploy). Chạy
  nhiều tiến trình thì mỗi tiến trình một số riêng; đủ cho staging, production làm cùng R11.
- Sentry chỉ bật khi có `SENTRY_DSN`. Không gửi body, cookie, header đăng nhập, mã QR, số
  điện thoại (`send_default_pii=False` + `scrub_event`).
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
import time
import uuid
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone

import sentry_sdk
from fastapi import FastAPI, Request
from starlette.responses import Response

from app.core.config import (
    APP_ENV,
    GIT_COMMIT,
    LOG_FORMAT,
    SENTRY_DSN,
    SENTRY_TRACES_SAMPLE_RATE,
)

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

access_logger = logging.getLogger("app.access")

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# Không đo/ghi log các đường kiểm tra sống (healthcheck Docker gọi mỗi 15 giây).
_QUIET_PATHS = frozenset({"/health", "/ready", "/version"})
_LATENCY_SAMPLES = 500


# --- Log JSON ------------------------------------------------------------------


class JsonFormatter(logging.Formatter):
    """Một dòng JSON mỗi bản ghi; trường thêm truyền qua `extra={"fields": {...}}`."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id:
            payload["request_id"] = request_id
        payload.update(getattr(record, "fields", {}) or {})
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    if LOG_FORMAT == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    app_logger = logging.getLogger("app")
    app_logger.handlers = [handler]
    app_logger.setLevel(logging.INFO)
    # Root logger không có handler (uvicorn chỉ cấu hình logger riêng), nên không in trùng.
    app_logger.propagate = True


# --- Số đo API -----------------------------------------------------------------


@dataclass
class RouteStats:
    count: int = 0
    client_errors: int = 0  # 4xx
    server_errors: int = 0  # 5xx
    latencies_ms: deque = field(default_factory=lambda: deque(maxlen=_LATENCY_SAMPLES))


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct / 100 * len(ordered)) - 1))
    return round(ordered[index], 1)


class RequestMetrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.started_at = datetime.now(timezone.utc)
        self._routes: dict[str, RouteStats] = {}

    def record(self, route: str, status_code: int, duration_ms: float) -> None:
        with self._lock:
            stats = self._routes.setdefault(route, RouteStats())
            stats.count += 1
            if 400 <= status_code < 500:
                stats.client_errors += 1
            elif status_code >= 500:
                stats.server_errors += 1
            stats.latencies_ms.append(duration_ms)

    def reset(self) -> None:
        with self._lock:
            self._routes.clear()
            self.started_at = datetime.now(timezone.utc)

    def snapshot(self) -> dict:
        with self._lock:
            routes = {
                key: (s.count, s.client_errors, s.server_errors, list(s.latencies_ms))
                for key, s in self._routes.items()
            }
            started_at = self.started_at
        total = sum(r[0] for r in routes.values())
        server_errors = sum(r[2] for r in routes.values())
        all_latencies = [ms for r in routes.values() for ms in r[3]]
        per_route = [
            {
                "route": key,
                "count": count,
                "client_errors": client_errors,
                "server_errors": server_errors,
                "p50_ms": _percentile(latencies, 50),
                "p95_ms": _percentile(latencies, 95),
            }
            for key, (count, client_errors, server_errors, latencies) in routes.items()
        ]
        per_route.sort(key=lambda r: (r["p95_ms"] or 0), reverse=True)
        return {
            "since": started_at,
            "requests": total,
            "server_errors": server_errors,
            "error_rate": round(server_errors / total, 4) if total else 0.0,
            "p50_ms": _percentile(all_latencies, 50),
            "p95_ms": _percentile(all_latencies, 95),
            "routes": per_route,
        }


metrics = RequestMetrics()


def _route_template(request: Request) -> str:
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    # Không khớp route nào (404) thì gom chung, không ghi đường dẫn khách gõ vào.
    return f"{request.method} {path}" if path else f"{request.method} <unmatched>"


def install_request_middleware(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_context(request: Request, call_next) -> Response:
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex
        token = request_id_var.set(request_id)
        # Handler lỗi 500 chạy ngoài middleware này (contextvar đã reset), nên để thêm ở state.
        request.state.request_id = request_id
        sentry_sdk.set_tag("request_id", request_id)  # không có DSN thì không làm gì
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            duration_ms = (time.perf_counter() - started) * 1000
            if request.url.path not in _QUIET_PATHS:
                route = _route_template(request)
                metrics.record(route, status_code, duration_ms)
                access_logger.info(
                    "request",
                    extra={
                        "fields": {
                            "route": route,
                            "status": status_code,
                            "duration_ms": round(duration_ms, 1),
                        }
                    },
                )
            request_id_var.reset(token)


# --- Sentry --------------------------------------------------------------------

_SENSITIVE_HEADERS = {"authorization", "cookie", "idempotency-key", "x-forwarded-for"}
_QR_TOKEN_RE = re.compile(r"(/public/qr/)[^/?#]+")
_PHONE_RE = re.compile(r"(?<!\d)(0\d{9,10})(?!\d)")


def _scrub_text(value: str) -> str:
    return _PHONE_RE.sub("[phone]", _QR_TOKEN_RE.sub(r"\1[token]", value))


def scrub_event(event: dict, hint: dict | None = None) -> dict:
    """before_send của Sentry: bỏ body/cookie/query, che header đăng nhập, mã QR, số điện thoại."""
    request = event.get("request") or {}
    request.pop("data", None)
    request.pop("cookies", None)
    request.pop("query_string", None)
    headers = request.get("headers") or {}
    for name in list(headers):
        if name.lower() in _SENSITIVE_HEADERS:
            headers[name] = "[filtered]"
    if isinstance(request.get("url"), str):
        request["url"] = _scrub_text(request["url"])
    if isinstance(event.get("transaction"), str):
        event["transaction"] = _scrub_text(event["transaction"])
    for entry in (event.get("exception") or {}).get("values") or []:
        if isinstance(entry.get("value"), str):
            entry["value"] = _scrub_text(entry["value"])
    message = event.get("logentry") or {}
    if isinstance(message.get("message"), str):
        message["message"] = _scrub_text(message["message"])
    request_id = request_id_var.get()
    if request_id:
        event.setdefault("tags", {})["request_id"] = request_id
    return event


def init_sentry() -> bool:
    if not SENTRY_DSN:
        return False
    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=APP_ENV,
        release=GIT_COMMIT,
        send_default_pii=False,
        traces_sample_rate=SENTRY_TRACES_SAMPLE_RATE,
        before_send=scrub_event,
        before_send_transaction=scrub_event,
        max_request_body_size="never",
    )
    return True
