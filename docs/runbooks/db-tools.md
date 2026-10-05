# Công cụ làm việc với DB (TOOL-S1-03)

DB staging chạy PostgreSQL 16 trong container `db` của `infra/compose/compose.staging.yml`
(database `pos_staging`, user `pos_app`). Compose **không publish cổng 5432** ra ngoài, nên
truy cập qua container hoặc SSH tunnel — không mở cổng DB công khai.

## 1. psql trong container (nhanh nhất)

```bash
cd infra/compose
docker compose -f compose.staging.yml exec db psql -U pos_app -d pos_staging
```

Lệnh hay dùng: `\dt` (liệt kê bảng), `\d "order"` (cấu trúc bảng; `order` là từ khóa nên phải
đặt trong dấu nháy kép), `\q` (thoát).

## 2. GUI (DBeaver / DataGrip / pgAdmin) qua SSH tunnel

1. Trên server staging, tạm thời cho DB nghe ở localhost, hoặc dùng tunnel tới IP container.
2. Mở tunnel: `ssh -L 5433:127.0.0.1:5432 <user>@<staging-host>` (host/user: xem
   `docs/runbooks/server-inventory-staging.md`).
3. Trong GUI kết nối `localhost:5433`, database `pos_staging`, user `pos_app`.
   Mật khẩu lấy từ `POSTGRES_PASSWORD` trong `.env.staging` (không commit file này).

> Lưu ý: bước 1 cần sửa compose (ví dụ `ports: ["127.0.0.1:5432:5432"]`) — nhờ mentor/DevOps
> duyệt trước khi áp dụng lên staging.

## 3. Migration (Alembic)

```bash
cd backend
alembic upgrade head        # áp dụng migration mới nhất
alembic current             # xem phiên bản hiện tại
alembic revision --autogenerate -m "mo ta ngan"   # tạo migration mới từ thay đổi model
```

Luôn đọc lại file migration được sinh ra trước khi commit (autogenerate không bắt được hết
thay đổi, nhất là CHECK constraint).

## 4. Quy tắc an toàn

- Không chạy `DROP`/`DELETE`/`TRUNCATE` tay trên staging nếu chưa báo mentor.
- Không dán mật khẩu DB vào chat, commit hay screenshot.
- Dữ liệu thử nghiệm: dùng DB local hoặc SQLite in-memory như test (`backend/tests/conftest.py`).
