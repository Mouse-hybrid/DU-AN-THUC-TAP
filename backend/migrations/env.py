"""Alembic env.py — import chung app/db/base.py + app/db/models.py để autogenerate
đọc được đúng metadata, và chung app/core/config.py để lấy DATABASE_URL — không
khai báo sqlalchemy.url riêng trong alembic.ini để tránh 2 nguồn cấu hình lệch nhau.
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Cho phép chạy `alembic` từ thư mục backend/ mà không cần cài package trước.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import DATABASE_URL  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db import models  # noqa: E402,F401  (import để đăng ký hết model vào Base.metadata)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

if DATABASE_URL:
    config.set_main_option("sqlalchemy.url", DATABASE_URL)
elif not config.get_main_option("sqlalchemy.url"):
    raise RuntimeError(
        "DATABASE_URL chưa được cấu hình (env var DATABASE_URL hoặc "
        "DB_HOST/DB_NAME/DB_USER/DB_PASSWORD) — xem backend/README.md"
    )


def run_migrations_offline() -> None:
    """Sinh SQL script (không cần kết nối DB thật) — dùng khi cần review SQL trước khi chạy."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Kết nối DB thật và apply migration — chế độ dùng hàng ngày (alembic upgrade head)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
