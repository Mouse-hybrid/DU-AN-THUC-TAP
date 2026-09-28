"""Test Global Exception Handler (BE-S1-09).

Dung 1 FastAPI app rieng, nho, gan dung handler that (khong dung app/main.py
that) de test cach ly - khong can them route "gia" vao main.py chi de phuc vu
test, tranh lam ban production code.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from app.core.error_handlers import register_exception_handlers


def _build_test_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/boom")
    def boom() -> None:
        raise ValueError("loi gia lap chua luong truoc")

    @app.get("/boom-db")
    def boom_db() -> None:
        raise SQLAlchemyError("loi ket noi DB gia lap")

    return app


def test_unhandled_exception_returns_500_with_generic_message():
    client = TestClient(_build_test_app(), raise_server_exceptions=False)
    resp = client.get("/boom")
    assert resp.status_code == 500
    assert resp.json() == {"detail": "Lỗi hệ thống, vui lòng thử lại sau"}


def test_database_error_returns_503_with_generic_message():
    client = TestClient(_build_test_app(), raise_server_exceptions=False)
    resp = client.get("/boom-db")
    assert resp.status_code == 503
    assert resp.json() == {"detail": "Không thể kết nối cơ sở dữ liệu, vui lòng thử lại sau"}


def test_unhandled_exception_is_logged_as_error(caplog):
    client = TestClient(_build_test_app(), raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="app.errors"):
        client.get("/boom")
    error_records = [r for r in caplog.records if r.name == "app.errors"]
    assert len(error_records) == 1
    assert error_records[0].levelno == logging.ERROR
    assert error_records[0].exc_info is not None


def test_existing_http_exception_flow_untouched(client, seed):
    """Regression: handler moi khong duoc nuot/doi format cac HTTPException
    (403/404/409...) dang co san trong cac router that (dung app/main.py
    that qua fixture `client`, khong phai app rieng o tren)."""
    resp = client.post(
        "/api/v1/orders",
        json={"table_session_id": "00000000-0000-0000-0000-000000000000"},
        headers={"Idempotency-Key": "eh-regression-1"},
    )
    assert resp.status_code == 401
    assert "detail" in resp.json()
