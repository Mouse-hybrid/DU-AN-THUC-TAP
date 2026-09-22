# Backend FastAPI

Backend nền của dự án POS sử dụng Python 3.11, FastAPI và PostgreSQL. Bản hiện tại phục vụ giao diện staging mock; chưa chứa nghiệp vụ POS thật.

## Cài đặt trên Windows

Chạy tất cả các lệnh dưới đây từ thư mục `backend`. Không cần `Activate.ps1` —
gọi thẳng `python.exe` bên trong venv.

```powershell
cd backend
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

## Chạy server

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Mở `http://127.0.0.1:8000/` hoặc `http://127.0.0.1:8000/docs`.

## Kiểm tra

```powershell
.\.venv\Scripts\python.exe -m pytest
```

```powershell
.\.venv\Scripts\python.exe -m ruff check .
```

## Biến môi trường

- `APP_ENV`: `development`, `staging` hoặc `production`.
- `DATABASE_URL`: PostgreSQL URL đầy đủ (ưu tiên nếu được đặt). Không commit secret thật.
- Hoặc đặt riêng `DB_HOST`, `DB_PORT` (mặc định `5432`), `DB_NAME`, `DB_USER`, `DB_PASSWORD` — app tự
  URL-encode `DB_PASSWORD` trước khi ghép connection string, tránh lỗi khi password chứa ký tự đặc
  biệt như `@` hoặc `%`.
