# Giám sát staging (SDD R3)

Bốn phần, đều đã có trong code từ 09/11. Phần cần người làm tay đánh dấu **[tay]**.

## 1. Log và request_id

- API ghi log JSON ra stdout, mỗi request một dòng `"message": "request"` có `route` (mẫu route, không phải đường dẫn thật), `status`, `duration_ms`, `request_id`. Không ghi query string, body, header.
- Mọi response có header `X-Request-ID`. Lỗi 500 trả thêm `request_id` trong body.
- Tìm log của một lỗi QA báo (chạy trên server, trong thư mục checkout mà deploy dùng):

  ```bash
  docker compose --env-file .env.staging -f infra/compose/compose.staging.yml logs api --since 2h | grep '<request_id>'
  ```

- Chạy local: log dạng text. Muốn xem dạng JSON thì đặt `LOG_FORMAT=json`.

## 2. Sentry (lỗi và độ trễ)

- Chỉ bật khi có `SENTRY_DSN`; không có thì app chạy bình thường, không gửi gì.
- **[tay]** Tạo dự án Sentry loại FastAPI, lấy DSN ở *Settings → Client Keys*, thêm `SENTRY_DSN=...` vào `~/secrets/pos-staging/.env.staging` trên server rồi chạy lại deploy. Không commit DSN, không dán vào chat nhóm.
- Gửi kèm `environment` (staging) và `release` (commit đang chạy) để biết lỗi thuộc bản nào. Lấy mẫu 10% request để đo độ trễ (`SENTRY_TRACES_SAMPLE_RATE`).
- Không gửi: body, cookie, query string, header `Authorization`, `Idempotency-Key`, mã QR trong URL, số điện thoại trong thông báo lỗi.
- **[tay]** Trong Sentry, bật *Alerts → Issue alert* "khi có lỗi mới" và "khi một lỗi xảy ra hơn 10 lần trong 1 giờ", gửi email cho nhóm BE.

## 3. Báo cáo GET /api/v1/ops/metrics (Supervisor)

| Nhóm | Chỉ số | Khoảng thời gian |
|---|---|---|
| `api` | số request, tỉ lệ lỗi 5xx, p50/p95, 20 route chậm nhất | từ lúc API khởi động (deploy là reset) |
| `kitchen` | món nấu xong, món trễ (nấu lâu hơn ngưỡng DELAYED 12 phút), tỉ lệ trễ, món đang nấu đã quá ngưỡng | `hours` giờ gần nhất (mặc định 24) |
| `payments` | số lần theo trạng thái, tỉ lệ thành công (không tính lần hủy) | `hours` giờ gần nhất |
| `alerts` | chỉ số vượt ngưỡng | — |

Ngưỡng cảnh báo mặc định (đổi qua env, chờ PO chốt số):

| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `ALERT_API_ERROR_RATE` | 0.05 | lỗi 5xx trên 5% số request |
| `ALERT_PAYMENT_SUCCESS_RATE` | 0.95 | thanh toán thành công dưới 95% |
| `ALERT_KITCHEN_LATE_RATE` | 0.2 | món trễ trên 20% số món nấu xong |
| `ALERT_MIN_SAMPLES` | 20 | chưa đủ số mẫu này thì không cảnh báo |

Hạn chế: số đo API giữ trong bộ nhớ từng tiến trình. Staging chạy 1 tiến trình nên đủ; chạy nhiều tiến trình ở production thì cần đưa sang Redis hoặc Prometheus (làm cùng R11).

## 4. Báo khi staging ngừng

- Workflow `.github/workflows/uptime-staging.yml` chạy 15 phút một lần trên máy của GitHub, gọi `/health` qua nginx. Thử 3 lần cách nhau 30 giây, vẫn lỗi thì job đỏ và GitHub gửi email cho người sửa lịch chạy gần nhất.
- Chạy tay: *Actions → Uptime staging → Run workflow*.
- Đổi địa chỉ (khi có domain): *Settings → Secrets and variables → Actions → Variables*, đặt `STAGING_URL`.
- GitHub tự tắt lịch chạy nếu repo không có hoạt động 60 ngày; khi đó bật lại ở tab Actions.
