"""Declarative Base + engine/session dùng chung cho toàn bộ models.

TECH-04/05 (ADR 0002): PostgreSQL 16 + Alembic. Engine ở đây tách khỏi app/main.py
để migrations/env.py import được mà không phải khởi tạo cả FastAPI app.
"""

from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.types import CHAR, TypeDecorator

from app.core.config import DATABASE_URL


class GUID(TypeDecorator):
    """UUID lưu dạng CHAR(36) — chạy được trên cả PostgreSQL lẫn SQLite (test/offline-dev).

    Dùng UUID sinh phía client (POS/KDS/QR) thay vì auto-increment ID, vì BRD yêu cầu
    offline-first: một thiết bị offline phải tạo được order/order_item với ID hợp lệ
    trước khi đồng bộ lên server, tránh xung đột ID khi nhiều thiết bị cùng offline.
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        return str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        return uuid.UUID(value)


def new_uuid() -> uuid.UUID:
    return uuid.uuid4()


class Base(DeclarativeBase):
    pass


# echo=False mặc định; bật SQL_ECHO=1 khi cần debug query lúc dev local.
import os  # noqa: E402

engine = (
    create_engine(
        DATABASE_URL, pool_pre_ping=True, pool_recycle=300, echo=bool(os.getenv("SQL_ECHO"))
    )
    if DATABASE_URL
    else None
)
SessionLocal = (
    sessionmaker(bind=engine, autoflush=False, expire_on_commit=False) if engine else None
)


def get_session():
    """FastAPI dependency: yield 1 DB session/request, luôn đóng sau khi xong."""
    if SessionLocal is None:
        raise RuntimeError("DATABASE_URL chưa được cấu hình — xem backend/README.md")
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
