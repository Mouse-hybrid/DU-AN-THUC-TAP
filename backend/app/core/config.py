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

# QR Ordering: hạn dùng của mã QR, và số món khách gọi được chờ phục vụ xác nhận trong
# một phiên bàn (chống đặt bậy; phục vụ xác nhận xong thì khách gọi tiếp được).
QR_SESSION_TTL_MINUTES = int(os.getenv("QR_SESSION_TTL_MINUTES", "240"))
QR_MAX_PENDING_ITEMS = int(os.getenv("QR_MAX_PENDING_ITEMS", "30"))
# Rewards đợt 3: số lần khách được gửi số điện thoại trong một phiên QR (chống dò số).
QR_MEMBER_MAX_ATTEMPTS = int(os.getenv("QR_MEMBER_MAX_ATTEMPTS", "5"))

# --- VNPay (SDD R2, specs/001-vnpay-sandbox) ------------------------------------
# Mã merchant và khóa ký chỉ đặt trong .env.staging trên server, không vào repo. Thiếu một
# trong hai thì API VNPay trả 503, các hình thức thanh toán khác vẫn chạy.
VNPAY_TMN_CODE = os.getenv("VNPAY_TMN_CODE", "").strip()
VNPAY_HASH_SECRET = os.getenv("VNPAY_HASH_SECRET", "").strip()
VNPAY_PAY_URL = os.getenv(
    "VNPAY_PAY_URL", "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html"
)
VNPAY_API_URL = os.getenv(
    "VNPAY_API_URL", "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction"
)
VNPAY_RETURN_URL = os.getenv("VNPAY_RETURN_URL", "").strip()
VNPAY_LINK_TTL_MINUTES = int(os.getenv("VNPAY_LINK_TTL_MINUTES", "15"))
VNPAY_TIMEOUT_SECONDS = float(os.getenv("VNPAY_TIMEOUT_SECONDS", "10"))
# IPN chỉ bật khi server có HTTPS (VNPay gọi vào); staging http thì để false.
VNPAY_IPN_ENABLED = os.getenv("VNPAY_IPN_ENABLED", "false").lower() == "true"

# --- Bản đang chạy (GET /version) ---------------------------------------------
# Gắn lúc build image (Dockerfile ARG GIT_COMMIT/BUILT_AT, deploy-staging.sh truyền
# vào) để QA/mentor biết staging đang chạy đúng commit nào.
GIT_COMMIT = os.getenv("GIT_COMMIT", "unknown")
BUILT_AT = os.getenv("BUILT_AT", "unknown")

# --- Giám sát (SDD R3) -----------------------------------------------------------
# Sentry chỉ bật khi có DSN (lấy ở trang dự án Sentry, đặt trong .env.staging, không vào repo).
SENTRY_DSN = os.getenv("SENTRY_DSN", "").strip()
SENTRY_TRACES_SAMPLE_RATE = float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1"))
# "json" cho staging/production (docker logs đọc được bằng máy), "text" cho chạy local.
LOG_FORMAT = os.getenv("LOG_FORMAT", "text" if APP_ENV in ("development", "test") else "json")

# Ngưỡng cảnh báo của GET /api/v1/ops/metrics. BRD chưa có số; PO chốt thì đổi qua env.
ALERT_API_ERROR_RATE = float(os.getenv("ALERT_API_ERROR_RATE", "0.05"))
ALERT_PAYMENT_SUCCESS_RATE = float(os.getenv("ALERT_PAYMENT_SUCCESS_RATE", "0.95"))
ALERT_KITCHEN_LATE_RATE = float(os.getenv("ALERT_KITCHEN_LATE_RATE", "0.2"))
# Dưới số mẫu này thì chưa cảnh báo, tránh báo động khi mới có vài request.
ALERT_MIN_SAMPLES = int(os.getenv("ALERT_MIN_SAMPLES", "20"))

if APP_ENV != "development" and JWT_SECRET_KEY == "dev-only-insecure-secret-change-me":
    raise RuntimeError(
        "JWT_SECRET_KEY chưa được set cho môi trường "
        f"'{APP_ENV}' — không được dùng secret mặc định ngoài development."
    )
