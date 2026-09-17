# Backend (thử nghiệm)

Khung backend tối giản dùng FastAPI để thử nghiệm nền tảng POS. Đây là bản thử,
chưa được duyệt làm stack chính thức. Chưa có PostgreSQL, chưa có UI, chưa có
nghiệp vụ nào ngoài endpoint kiểm tra sức khỏe.

## Yêu cầu

- Python 3.11 (đã kiểm tra thực tế: 3.11.9 trên Windows).
- Windows + PowerShell

## Cài đặt (PowerShell)

Chạy tất cả các lệnh dưới đây từ thư mục `backend`. Không cần `Activate.ps1` —
gọi thẳng `python.exe` bên trong venv.

```powershell
cd backend
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Chạy server

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Kiểm tra: mở `http://127.0.0.1:8000/health`, kỳ vọng phản hồi `{"status":"ok"}`.

## Chạy test

```powershell
.\.venv\Scripts\python.exe -m pytest
```

## Lint

```powershell
.\.venv\Scripts\python.exe -m ruff check .
```
