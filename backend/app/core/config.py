"""Cấu hình môi trường dùng chung cho app và Alembic.

Tách ra khỏi app/main.py để cả FastAPI app lẫn migrations/env.py (Alembic) đều import
được cùng một logic build DATABASE_URL, không lặp code. Theo ADR 0002 (TECH-04/05).
"""

import os
from urllib.parse import quote_plus

APP_ENV = os.getenv("APP_ENV", "development")


def build_database_url() -> str | None:
    """Ưu tiên DATABASE_URL nếu được set. Nếu không, ghép từ DB_HOST/DB_NAME/DB_USER/DB_PASSWORD.

    DB_PASSWORD được URL-encode để tránh lỗi khi password chứa ký tự đặc biệt (@, %...).
    """
    explicit_url = os.getenv("DATABASE_URL")
    if explicit_url:
        return explicit_url

    db_host = os.getenv("DB_HOST")
    db_name = os.getenv("DB_NAME")
    db_user = os.getenv("DB_USER")
    db_password = os.getenv("DB_PASSWORD")
    if not (db_host and db_name and db_user and db_password):
        return None

    db_port = os.getenv("DB_PORT", "5432")
    encoded_password = quote_plus(db_password)
    return f"postgresql+psycopg://{db_user}:{encoded_password}@{db_host}:{db_port}/{db_name}"


DATABASE_URL = build_database_url()

# --- JWT (auth cho staff — TECH quyết định trong ADR 0002: JWT cho staff, ---
# --- session token tạm cho khách QR, không cần login) ------------------------
# CẢNH BÁO: giá trị mặc định "dev-only-insecure-secret-change-me" chỉ dùng để
# chạy local/test. Production/staging BẮT BUỘC set JWT_SECRET_KEY qua env var
# (secret ngẫu nhiên đủ dài, vd `python -c "import secrets; print(secrets.token_urlsafe(48))"`).
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-only-insecure-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_ACCESS_TOKEN_EXPIRE_MINUTES = int(
    os.getenv("JWT_ACCESS_TOKEN_EXPIRE_MINUTES", "480")
)  # 8 giờ ~ 1 ca làm


# --- CORS: domain FE được phép gọi API từ trình duyệt ------------------------
# Danh sách origin cách nhau bởi dấu phẩy, vd
# "http://localhost:5173,https://pos-staging.example.com". Không dùng "*" vì API
# có đăng nhập. Development mặc định mở cho các cổng dev server phổ biến (Vite
# 5173, CRA/Next 3000); môi trường khác mặc định KHÔNG mở origin nào — phải set
# CORS_ALLOW_ORIGINS tường minh.
_DEV_CORS_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"
)


def parse_cors_origins(raw: str | None) -> list[str]:
    origins = [origin.strip().rstrip("/") for origin in (raw or "").split(",")]
    origins = [origin for origin in origins if origin]
    if "*" in origins:
        raise RuntimeError("CORS_ALLOW_ORIGINS không được chứa '*' — liệt kê từng domain FE")
    return origins


CORS_ALLOW_ORIGINS = parse_cors_origins(
    os.getenv("CORS_ALLOW_ORIGINS", _DEV_CORS_ORIGINS if APP_ENV == "development" else "")
)

# --- SLA bếp (BRD BR-KDS-SLA-001..003: timer chạy từ PREPARING tới READY) -----
# Ngưỡng phút theo bộ test BVA của QA (DSG-QA-06: 8/12/15 phút, xanh -> cam ->
# đỏ); BRD chưa ghi số cụ thể — cần PO xác nhận, nên để cấu hình qua env.
KDS_SLA_WARNING_MINUTES = int(os.getenv("KDS_SLA_WARNING_MINUTES", "8"))
KDS_SLA_DELAYED_MINUTES = int(os.getenv("KDS_SLA_DELAYED_MINUTES", "12"))
KDS_SLA_CRITICAL_MINUTES = int(os.getenv("KDS_SLA_CRITICAL_MINUTES", "15"))

if APP_ENV != "development" and JWT_SECRET_KEY == "dev-only-insecure-secret-change-me":
    raise RuntimeError(
        "JWT_SECRET_KEY chưa được set cho môi trường "
        f"'{APP_ENV}' — không được dùng secret mặc định ngoài development."
    )
