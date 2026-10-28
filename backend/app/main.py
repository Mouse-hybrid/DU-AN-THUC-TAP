from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

# DATABASE_URL/APP_ENV va engine dung chung voi Alembic (migrations/env.py) qua
# app/core/config.py va app/db/base.py - khong duplicate logic o day nua.
from app.api.v1 import api_v1_router
from app.core.config import APP_ENV, BUILT_AT, CORS_ALLOW_ORIGINS, GIT_COMMIT
from app.core.error_handlers import register_exception_handlers
from app.db.base import engine as database_engine

app = FastAPI(
    title="POS Staging API",
    description="Backend API cho hệ thống POS nhà hàng NOVA.",
    version="0.1.0",
)
if CORS_ALLOW_ORIGINS:
    # FE (POS/KDS/QR) chạy ở domain/cổng khác API -> trình duyệt cần header CORS.
    # Header tự định nghĩa (Idempotency-Key) phải được liệt kê để preflight pass.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ALLOW_ORIGINS,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        max_age=600,
    )
app.include_router(api_v1_router)
register_exception_handlers(app)


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    """Giao diện nằm ở frontend/ (nginx phục vụ); backend chỉ trả chỉ dẫn tới API."""
    return {"service": "NOVA POS API", "docs": "/docs", "health": "/health"}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/version")
def version() -> dict[str, str]:
    """Commit và thời điểm build của bản đang chạy — đối chiếu với lịch sử `main`."""
    return {
        "commit": GIT_COMMIT,
        "short_commit": GIT_COMMIT[:7],
        "built_at": BUILT_AT,
        "environment": APP_ENV,
        "api_version": app.version,
    }


@app.get("/ready", response_model=None)
def readiness():
    if database_engine is None:
        return {
            "status": "ready",
            "environment": APP_ENV,
            "database": "not_configured",
        }

    try:
        with database_engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return JSONResponse(
            status_code=503,
            content={
                "status": "not_ready",
                "environment": APP_ENV,
                "database": "unavailable",
            },
        )

    return {"status": "ready", "environment": APP_ENV, "database": "connected"}
