# Test chịu tải (SDD R4)

Mục tiêu theo BRD: giờ cao điểm 200 người dùng đồng thời. **Đạt** khi:

- "thêm món" p95 ≤ 1 giây, "gửi bếp" p95 ≤ 2 giây;
- không có response 5xx;
- `loadtest_data.py verify` báo không ghi trùng (phiếu bếp, phiên bàn, tiền thu).

Bài test dùng outlet riêng **"Load test"** (bàn `LT-001`…, tài khoản `lt_cashier`, `lt_waiter`, `lt_kitchen`, `lt_supervisor`), không đụng dữ liệu QA. Chạy **ngoài giờ QA test** và báo nhóm trước, vì staging sẽ chậm trong lúc chạy.

## Luồng mỗi người dùng ảo

Một người dùng ảo giữ một bàn và lặp lại:

1. Mở bàn, tạo đơn.
2. Thêm món 2–3 lần.
3. Gửi bếp. Bếp bắt đầu nấu và báo xong; phục vụ lấy món, mang ra bàn.
4. Yêu cầu thanh toán, thu tiền mặt hoặc thẻ.
5. Dọn bàn.

Giữa các bước có xem sơ đồ bàn, hàng đợi bếp và chi tiết bàn như màn hình thật. Mỗi bước chờ 1–3 giây.

## Các bước trên staging

**1. Backup database trước.** Vào *Actions → Backup staging DB → Run workflow*, nhãn `truoc-load-test`.

**2. Tạo dữ liệu.** Chạy trên server, trong thư mục checkout mà deploy dùng. Mật khẩu `LOADTEST_PASSWORD` tự chọn, tối thiểu 8 ký tự, không ghi vào repo hay chat nhóm.

```bash
export LOADTEST_PASSWORD='...'
docker compose --env-file .env.staging -f infra/compose/compose.staging.yml \
  exec -e LOADTEST_PASSWORD api python scripts/loadtest_data.py prepare --tables 200
```

**3. Chạy Locust** từ một máy khác, không chạy trên chính server staging để kết quả không bị lẫn tải của Locust:

```bash
python -m venv .venv-load
.venv-load/bin/pip install -r backend/loadtest/requirements.txt
cd backend
LOADTEST_PASSWORD='...' ../.venv-load/bin/locust -f loadtest/locustfile.py \
  --host http://160.191.47.17 --headless -u 200 -r 10 -t 10m --csv loadtest/result
```

- Chạy xong, cuối output in p95 của "thêm món", "gửi bếp", số response 5xx và dòng `ĐẠT` hoặc `KHÔNG ĐẠT`. Không đạt thì exit code 1.
- File `loadtest/result_stats.csv` có số liệu từng bước, đính kèm vào báo cáo.
- Nên chạy thử `-u 20 -t 2m` trước khi chạy 200.

**4. Kiểm ghi trùng:**

```bash
docker compose --env-file .env.staging -f infra/compose/compose.staging.yml \
  exec api python scripts/loadtest_data.py verify
```

**5. Dọn dữ liệu.** Lệnh đầu chỉ đếm số dòng sẽ xóa; thêm `--yes` để xóa thật.

```bash
docker compose --env-file .env.staging -f infra/compose/compose.staging.yml \
  exec api python scripts/loadtest_data.py cleanup
docker compose --env-file .env.staging -f infra/compose/compose.staging.yml \
  exec api python scripts/loadtest_data.py cleanup --yes
```

- Xóa đơn, phiên bàn, thanh toán, phiếu bếp, audit của outlet Load test, và các Idempotency-Key bắt đầu bằng `lt-`.
- Giữ outlet, bàn, món và tài khoản để chạy lại lần sau.

## Xem trong lúc chạy

- `GET /api/v1/ops/metrics` (đăng nhập `lt_supervisor`): p95 và lỗi 5xx theo route. Số đo tính từ lần deploy gần nhất, gồm cả request thật.
- `docker stats`: CPU, RAM của `api` và `db`.

## Chạy thử ở máy local

Dùng SQLite, chỉ để kiểm tra kịch bản, không dùng để đánh giá hiệu năng:

```bash
cd backend
export DATABASE_URL=sqlite:///./lt.db LOADTEST_PASSWORD=lt-local-pass-1
python -c "from app.db.base import Base, engine; import app.db.models; Base.metadata.create_all(engine)"
python scripts/loadtest_data.py prepare --tables 10
uvicorn app.main:app --port 8010 &
../.venv-load/bin/locust -f loadtest/locustfile.py --host http://127.0.0.1:8010 --headless -u 5 -r 5 -t 60s
```

Kết quả chạy thử ngày 09/11 (5 người dùng, 60 giây, SQLite):

- 900 request, không lỗi;
- "thêm món" p95 79 ms, "gửi bếp" p95 100 ms;
- `verify` báo không ghi trùng.

## Khóa đồng thời (test trên Postgres của CI)

`tests/test_concurrency_postgres.py` chạy 5 vòng mỗi trường hợp:

| Trường hợp | Kết quả đúng |
|---|---|
| gửi bếp 2 lần cùng lúc | 1 phiếu bếp |
| 2 thu ngân trả hết 1 đơn | 1 lần thu |
| gộp bàn A vào B và B vào A cùng lúc | 1 thành công, 1 bị 409, không kẹt |
| chuyển 2 bàn vào cùng 1 bàn trống | 1 thành công, 1 bị 409 |
| 2 đơn cùng đổi điểm của 1 khách, số điểm chỉ đủ 1 đơn | 1 đơn trả được, 1 đơn bị 409 |
| trả 2 hóa đơn tách của cùng bàn cùng lúc | cả hai trả được, bàn sang CLEANING |

Trường hợp cuối từng có nguy cơ kẹt khóa, vì mỗi lần trả khóa đơn của mình rồi khóa đơn còn lại. Từ 09/11, mọi API thu tiền khóa phiên bàn trước (`lock_order_for_payment`).
