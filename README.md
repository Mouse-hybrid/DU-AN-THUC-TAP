# POS System

Monorepo nền cho hệ thống POS. Stack backend đã chốt: Python 3.11, FastAPI và PostgreSQL.

## Staging foundation

Giao diện (React) nằm ở `frontend/`, API (FastAPI) ở `backend/`. Trên staging, nginx
phục vụ giao diện ở `/` và chuyển `/api`, `/docs`, `/health`, `/ready`, `/version`
xuống backend. Các trang mock của Sprint 0 (`/pos`, `/kitchen`, `/customer`, `/admin`)
đã gỡ ngày 28/10 vì giao diện thật đã thay thế.
- `/health` — liveness
- `/ready` — readiness
- `/docs` — OpenAPI

Các màn hình chỉ là shell để demo và ghép UX sau này, không phải bằng chứng hoàn thành nghiệp vụ.

## Chạy local

Xem hướng dẫn trong `backend/README.md`.

## Triển khai staging

1. Cài Docker Engine, Compose plugin và PostgreSQL client bằng `scripts/bootstrap-staging-ubuntu.sh`.
2. Sao chép `.env.staging.example` thành `.env.staging` và đặt password ngẫu nhiên.
3. Chạy `scripts/deploy-staging.sh`.
4. Kiểm tra `http://<server-ip>/`, `/health` và `/docs`.

PostgreSQL không được publish ra Internet. Nginx chạy trong container và là điểm truy cập duy nhất trên cổng 80 trước khi có domain/TLS.

### Preview tạm thời khi chưa cài Docker

Sau khi tạo `backend/.venv` và cài dependency, chạy:

```bash
bash scripts/preview-staging.sh start
bash scripts/preview-staging.sh status
```

Preview này chạy ở cổng 8000, không tự khởi động lại sau reboot và không thay thế cấu hình Docker/Nginx chính thức.
