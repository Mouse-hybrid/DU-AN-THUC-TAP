# Dữ liệu mẫu test API — thêm / sửa / xóa

Dành cho QA. Mọi payload dưới đây đã được chạy thử trên DB vừa migrate và seed (50/50 bước đúng mã trạng thái mong đợi, ngày 08/10/2026).

- API contract đầy đủ: [`openapi.json`](openapi.json) (import vào Postman/Swagger).
- Chạy cả luồng tự động: import [`pos-api.postman_collection.json`](pos-api.postman_collection.json) vào Postman → đặt biến `baseUrl` và `password` → **Run collection** (chạy theo thứ tự, id tự lấy từ bước trước).

## 1. Chuẩn bị

**Dữ liệu seed** (`backend/scripts/seed_dev_data.py`): staging **tự seed sau mỗi lần deploy** (CI/CD), chạy lại nhiều lần không tạo trùng. Dữ liệu QA tự tạo thêm không bị xóa.

| Loại | Dữ liệu |
|---|---|
| Tài khoản | `admin` (SUPERVISOR), `cashier` (CASHIER), `waiter` (WAITER), `kitchen` (KITCHEN). Mật khẩu chung: **staging** — BE nhắn riêng (biến `SEED_PASSWORD` trên server, không nằm trong repo); **máy local** — hằng `DEV_SEED_PASSWORD` trong file seed |
| Trạm bếp | Bếp chính, Quầy bar |
| Nhóm món | Món khai vị (1), Món chính (2), Đồ uống (3) |
| Món | Gỏi cuốn 35.000, Chả giò 40.000, Phở bò 45.000, Bún chả 50.000, Cơm tấm sườn 55.000 (Bếp chính); Trà đá 5.000, Cà phê sữa đá 25.000, Nước cam 30.000 (Quầy bar) |
| Bàn | B1, B2 (4 ghế), B3, B4 (2 ghế), B5, B6 (6 ghế) — đều AVAILABLE |

**Header bắt buộc**

| Header | Khi nào | Giá trị |
|---|---|---|
| `Authorization` | Mọi API trừ `/auth/login`, `/health`, `/ready` | `Bearer <access_token>` từ `POST /api/v1/auth/login` |
| `Idempotency-Key` | Mọi `POST` tạo mới/đổi trạng thái và `PATCH`/`DELETE` món trong order | UUID mới cho mỗi lần bấm. Gửi lại **cùng key + cùng body** → trả lại kết quả cũ, không tạo trùng. **Cùng key + khác body** → `409` |
| `Content-Type` | Request có body | `application/json` |

Không cần `Idempotency-Key`: `PATCH /menu/{id}`, `PATCH /menu/categories/{id}` (bản chất đã idempotent).

**Mã lỗi chung:** `400` thiếu `Idempotency-Key` · `401` chưa đăng nhập/token sai · `403` sai role · `404` không thấy (hoặc thuộc outlet khác) · `409` sai trạng thái/trùng · `422` dữ liệu không hợp lệ.

## 2. Nhóm món — chỉ SUPERVISOR

| Thao tác | Request | Body mẫu hợp lệ | Kết quả |
|---|---|---|---|
| Thêm | `POST /api/v1/menu/categories` | `{"name": "Tráng miệng", "sort_order": 4}` | `201` |
| Sửa | `PATCH /api/v1/menu/categories/{id}` | `{"sort_order": 5}` hoặc `{"name": "Món ngọt"}` | `200` |
| Ẩn (thay cho xóa) | `PATCH /api/v1/menu/categories/{id}` | `{"is_active": false}` | `200`, món trong nhóm giữ nguyên |
| Xem | `GET /api/v1/menu/categories?active_only=true` | — | `200` |

| Case sai | Body | Kết quả |
|---|---|---|
| Trùng tên trong cùng outlet | `{"name": "Món chính"}` | `409` |
| Tên rỗng / dài > 100 ký tự | `{"name": ""}` | `422` |
| `sort_order` âm hoặc > 10000 | `{"name": "X", "sort_order": -1}` | `422` |
| Sửa với body rỗng | `{}` | `422` |
| Role khác SUPERVISOR | bất kỳ | `403` |

## 3. Món trong menu — thêm/sửa chỉ SUPERVISOR

| Thao tác | Request | Body mẫu hợp lệ | Kết quả |
|---|---|---|---|
| Thêm | `POST /api/v1/menu` | `{"name": "Chè khúc bạch", "price": "30000", "station_id": "<id trạm>", "category_id": "<id nhóm>"}` | `201` |
| Sửa giá | `PATCH /api/v1/menu/{id}` | `{"price": "32000"}` | `200`, **order cũ giữ giá cũ** |
| Hết món | `PATCH /api/v1/menu/{id}` | `{"is_available": false}` | `200`, thêm món này vào order → `409` |
| Bỏ gán nhóm/trạm | `PATCH /api/v1/menu/{id}` | `{"category_id": null}` | `200` |
| Tìm | `GET /api/v1/menu?q=phở&category_id=<id>&available_only=true` | — | `200` |

Không có API xóa món: dùng "hết món" (`is_available: false`) để giữ lịch sử order.

| Case sai | Body | Kết quả |
|---|---|---|
| Giá ≤ 0 | `{"name": "X", "price": "0"}` | `422` |
| Giá > 2 chữ số thập phân | `{"name": "X", "price": "1000.555"}` | `422` |
| Tên rỗng / dài > 255 ký tự | `{"name": "", "price": "10000"}` | `422` |
| `station_id` / `category_id` không tồn tại | `{"name": "X", "price": "10000", "category_id": "00000000-0000-0000-0000-000000000000"}` | `404` |
| `name`/`price`/`is_available` = null khi sửa | `{"price": null}` | `422` |
| Role khác SUPERVISOR | bất kỳ | `403` |

## 4. Bàn & order — thêm / sửa / bỏ món

| Bước | Request | Role | Body mẫu | Kết quả |
|---|---|---|---|---|
| Mở bàn | `POST /api/v1/tables/{table_id}/open-session` | CASHIER, WAITER, SUPERVISOR | `{"guest_count": 2}` | `201`, bàn → OCCUPIED |
| Tạo order | `POST /api/v1/orders` | CASHIER, WAITER, SUPERVISOR | `{"table_session_id": "<id>"}` | `201`, order NEW |
| Thêm món | `POST /api/v1/orders/{order_id}/items` | CASHIER, WAITER, SUPERVISOR | `{"items": [{"menu_item_id": "<id>", "quantity": 2, "note": "ít đường"}, {"menu_item_id": "<id>", "quantity": 1}]}` | `201`, món CREATED |
| **Sửa món** (chưa gửi bếp) | `PATCH /api/v1/orders/{order_id}/items/{item_id}` | CASHIER, WAITER, SUPERVISOR | `{"quantity": 3, "note": "không đá"}` · chỉ ghi chú: `{"note": "thêm chanh"}` · xóa ghi chú: `{"note": null}` | `200` |
| **Bỏ món** (chưa gửi bếp) | `DELETE /api/v1/orders/{order_id}/items/{item_id}` | CASHIER, WAITER, SUPERVISOR | — | `200`, món → VOIDED (vẫn hiện trong order, không tính tiền) |
| Xem order | `GET /api/v1/orders/{order_id}` | mọi role | — | `200`, có `menu_item_name`, `line_total`, `subtotal` |
| Gửi bếp | `POST /api/v1/orders/{order_id}/send-to-kitchen` | CASHIER, WAITER, SUPERVISOR | — | `200`, món CREATED → SENT |
| Hủy món đã gửi bếp | `POST /api/v1/orders/{order_id}/items/{item_id}/void` | SUPERVISOR | `{"reason": "khách đổi ý"}` | `200`, món → VOIDED |
| Làm lại món đã phục vụ | `POST /api/v1/orders/{order_id}/items/{item_id}/refire` | SUPERVISOR | — | `200` |

| Case sai | Body / điều kiện | Kết quả |
|---|---|---|
| Mở bàn đang có khách | bàn OCCUPIED | `409` |
| `guest_count` = 0 hoặc > 100 | `{"guest_count": 0}` | `422` |
| `quantity` = 0 hoặc > 50 | `{"items": [{"menu_item_id": "<id>", "quantity": 0}]}` | `422` |
| `items` rỗng | `{"items": []}` | `422` |
| Thêm món đang hết | món `is_available=false` | `409` |
| Sửa món body rỗng / `quantity: null` | `{}` | `422` |
| Sửa/bỏ món **đã gửi bếp** | món SENT trở đi | `409` (phải dùng void) |
| Thêm/sửa/bỏ món khi order đã gửi bếp, role CASHIER hoặc WAITER | món mới thêm sau khi gửi | `403` (chỉ SUPERVISOR) |
| KITCHEN mở bàn / tạo order / thêm-sửa-bỏ món / gửi bếp | bất kỳ | `403` |
| Thêm/sửa món khi order BILLING/PAID/CLOSED | — | `409` |
| Thiếu `Idempotency-Key` | — | `400` |

## 5. Bếp, thanh toán, dọn bàn

| Bước | Request | Role | Điều kiện | Kết quả |
|---|---|---|---|---|
| Xem hàng đợi | `GET /api/v1/kitchen/queue?station_id=&status=&delayed_only=` | KITCHEN, SUPERVISOR | — | `200`, có `sla_status` |
| Bắt đầu nấu | `POST .../items/{item_id}/start-cooking` | KITCHEN, SUPERVISOR | món SENT | `200` → PREPARING |
| Nấu xong | `POST .../items/{item_id}/mark-ready` | KITCHEN, SUPERVISOR | món PREPARING | `200` → READY |
| Lấy món | `POST .../items/{item_id}/pickup` | WAITER, SUPERVISOR | món READY | `200` → PICKED_UP |
| Mang ra bàn | `POST .../items/{item_id}/served` | WAITER, SUPERVISOR | món PICKED_UP | `200` → SERVED |
| Yêu cầu thanh toán | `POST /api/v1/orders/{id}/request-billing` | CASHIER, WAITER, SUPERVISOR | order SENT/SERVED | `200` → BILLING |
| Thanh toán | `POST /api/v1/orders/{id}/pay` | CASHIER, SUPERVISOR (WAITER → `403`) | order BILLING | `200` → PAID, bàn → CLEANING |
| Đóng order | `POST /api/v1/orders/{id}/close` | CASHIER, SUPERVISOR | order PAID | `200` → CLOSED |
| Dọn bàn xong | `POST /api/v1/tables/{id}/mark-clean` | WAITER, SUPERVISOR | bàn CLEANING | `200` → AVAILABLE |

**SLA bếp** (món đang nấu, tính từ `started_at` theo giờ server): < 8 phút NORMAL · ≥ 8 WARNING · ≥ 12 DELAYED · ≥ 15 CRITICAL. Ngưỡng lấy từ bộ test BVA DSG-QA-06, chờ PO xác nhận. Món chưa bắt đầu nấu luôn NORMAL, `elapsed_minutes = null`.
