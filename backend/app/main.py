from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

# DATABASE_URL/APP_ENV va engine dung chung voi Alembic (migrations/env.py) qua
# app/core/config.py va app/db/base.py - khong duplicate logic o day nua.
from app.api.v1 import api_v1_router
from app.core.config import APP_ENV
from app.db.base import engine as database_engine

APP_DIR = Path(__file__).resolve().parent

app = FastAPI(
    title="POS Staging API",
    description="Backend foundation and mock screens for the POS project.",
    version="0.1.0",
)
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
templates = Jinja2Templates(directory=APP_DIR / "templates")
app.include_router(api_v1_router)

PAGES = {
    "landing": {
        "title": "POS System staging",
        "eyebrow": "Project foundation",
        "description": "Giao diện nền để mentor và nhóm theo dõi tiến độ tích hợp.",
        "primary_label": "Open POS mock",
        "primary_href": "/pos",
        "metrics": [("5", "mock screens"), ("1", "FastAPI service"), ("0", "production data")],
    },
    "pos": {
        "title": "Staff POS",
        "eyebrow": "Order workspace mock",
        "description": "Màn hình thao tác bán hàng mẫu, chưa có nghiệp vụ đặt món thật.",
        "primary_label": "View API status",
        "primary_href": "/health",
        "metrics": [("12", "tables"), ("3", "open orders"), ("Mock", "payment state")],
    },
    "kitchen": {
        "title": "Kitchen queue",
        "eyebrow": "Kitchen display mock",
        "description": "Hàng đợi bếp mẫu để chuẩn bị cho luồng nhận và cập nhật món.",
        "primary_label": "View mock data",
        "primary_href": "/api/v1/mock/summary",
        "metrics": [("4", "new tickets"), ("2", "preparing"), ("1", "ready")],
    },
    "customer": {
        "title": "Customer menu",
        "eyebrow": "QR ordering mock",
        "description": "Trang menu responsive mẫu; chưa nhận đơn hàng hoặc thanh toán thật.",
        "primary_label": "Browse API docs",
        "primary_href": "/docs",
        "metrics": [("8", "categories"), ("36", "sample items"), ("Mock", "cart")],
    },
    "admin": {
        "title": "Admin dashboard",
        "eyebrow": "Back office mock",
        "description": (
            "Dashboard quản trị nền, định hướng bố cục AdminLTE nhưng chưa dùng dữ liệu thật."
        ),
        "primary_label": "Check readiness",
        "primary_href": "/ready",
        "metrics": [("4", "locations"), ("18", "staff accounts"), ("5", "pending tasks")],
    },
}


def render_page(request: Request, page: str) -> HTMLResponse:
    template_name = {
        "landing": "landing.html",
        "admin": "admin.html",
    }.get(page, "shell.html")
    return templates.TemplateResponse(
        request=request,
        name=template_name,
        context={"page": page, "content": PAGES[page], "environment": APP_ENV},
    )


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def landing(request: Request) -> HTMLResponse:
    return render_page(request, "landing")


@app.get("/pos", response_class=HTMLResponse, include_in_schema=False)
def pos_page(request: Request) -> HTMLResponse:
    return render_page(request, "pos")


@app.get("/kitchen", response_class=HTMLResponse, include_in_schema=False)
def kitchen_page(request: Request) -> HTMLResponse:
    return render_page(request, "kitchen")


@app.get("/customer", response_class=HTMLResponse, include_in_schema=False)
def customer_page(request: Request) -> HTMLResponse:
    return render_page(request, "customer")


@app.get("/admin", response_class=HTMLResponse, include_in_schema=False)
def admin_page(request: Request) -> HTMLResponse:
    return render_page(request, "admin")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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


@app.get("/api/v1/mock/summary")
def mock_summary() -> dict[str, object]:
    return {
        "environment": APP_ENV,
        "data_mode": "mock",
        "screens": ["landing", "pos", "kitchen", "customer", "admin"],
        "message": "No production data is used on this staging foundation.",
    }
