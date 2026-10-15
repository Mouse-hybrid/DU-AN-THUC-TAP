# Danh mục API — POS System

Cập nhật 12/10/2026, staging commit `a92ed34` (`GET /version`). Nguồn: `docs/api/openapi.json`
(sinh từ code), test QA trên nhánh `ONLY_TESTING`, POS Rollout Board (4 pha), BRD/HLR, Figma Pha 1.

**Cách đọc cột trạng thái**

| Ký hiệu | Nghĩa |
|---|---|
| ✅ Staging | Đã code, có test BE, đang chạy trên `http://160.191.47.17` |
| 🧪 QA | QA đã gọi trong Postman/Cypress/Playwright (nhánh `ONLY_TESTING`) |
| 🖥️ FE | Giao diện FE đã nối API thật (không phải dữ liệu mock) |
| 📝 Đề xuất | Chưa code; tên endpoint là đề xuất của BE, chốt khi thiết kế pha đó |

**Tổng quan**

| | Số lượng |
|---|---|
| API đã có trên staging | 35 REST + 1 WebSocket (thêm 2 API tra cứu audit/version ngày 15/10) |
| QA đã gọi trong test | 33/33 REST; WebSocket mới test phần từ chối khi thiếu token (TC_EXT_015) |
| FE đã nối API thật (trên staging) | **3** (`POST /auth/login`, `GET /tables`, `POST /tables/{id}/open-session`) |
| API đề xuất cho Pha 1 còn thiếu | 0 bắt buộc; 3 tùy chọn (mục C) |
| API đề xuất Pha 2–3 | ~55 endpoint (mục D) |

---

## A. API Pha 1 — đã có trên staging

Phân quyền: S = Supervisor, C = Cashier, W = Waiter, K = Kitchen. Mọi POST/PATCH/DELETE bắt buộc
header `Idempotency-Key`. Màn hình theo mã Figma NOVA POS.

### A1. Xác thực và vận hành

| # | Method | Endpoint | Quyền | Màn hình dùng | Trạng thái |
|---|---|---|---|---|---|
| 1 | POST | `/api/v1/auth/login` | công khai | 01 Đăng nhập POS, 29 Đăng nhập bếp | ✅ 🧪 🖥️ |
| 2 | GET | `/health` | công khai | — (giám sát, CI) | ✅ 🧪 |
| 3 | GET | `/ready` | công khai | — (deploy chờ DB sẵn sàng) | ✅ 🧪 |
| 4 | GET | `/version` | công khai | — (biết staging chạy commit nào) | ✅ 🧪 |
| 5 | WS | `/api/v1/ws?token=&channel=tables\|kitchen` | mọi role | 04 Sơ đồ bàn, 31–34 Hàng đợi bếp | ✅ 🧪 một phần (mới test từ chối khi thiếu token; event và reconnect chưa test — TC_EXT_016–017) |

### A2. Bàn

| # | Method | Endpoint | Quyền | Màn hình dùng | Trạng thái |
|---|---|---|---|---|---|
| 6 | GET | `/api/v1/tables` | mọi role | 04 Sơ đồ bàn | ✅ 🧪 🖥️ |
| 7 | GET | `/api/v1/tables/{id}` | mọi role | 05 Chi tiết bàn | ✅ 🧪 |
| 8 | POST | `/api/v1/tables/{id}/open-session` | S C W | 06 Mở bàn | ✅ 🧪 🖥️ |
| 9 | POST | `/api/v1/tables/{id}/mark-clean` | S W | 04 Sơ đồ bàn (bàn CLEANING → AVAILABLE) | ✅ 🧪 |

### A3. Menu

| # | Method | Endpoint | Quyền | Màn hình dùng | Trạng thái |
|---|---|---|---|---|---|
| 10 | GET | `/api/v1/menu?q=&category_id=&available_only=` | mọi role | 09 Gọi món, 12 Tìm món, 103 | ✅ 🧪 |
| 11 | POST | `/api/v1/menu` | S | 103 Thêm/sửa món | ✅ 🧪 |
| 12 | PATCH | `/api/v1/menu/{id}` | S | 103 (sửa giá, trạm, bật/tắt hết món) | ✅ 🧪 |
| 13 | GET | `/api/v1/menu/categories` | mọi role | 09, 12, 102 | ✅ 🧪 |
| 14 | POST | `/api/v1/menu/categories` | S | 102 Quản lý nhóm món | ✅ 🧪 |
| 15 | PATCH | `/api/v1/menu/categories/{id}` | S | 102 | ✅ 🧪 |

### A4. Order và gọi món

| # | Method | Endpoint | Quyền | Màn hình dùng | Trạng thái |
|---|---|---|---|---|---|
| 16 | POST | `/api/v1/orders` | S C W | 09 Gọi món | ✅ 🧪 |
| 17 | GET | `/api/v1/orders/{id}` | mọi role | 09, 19 Tóm tắt order, 05 | ✅ 🧪 |
| 18 | GET | `/api/v1/orders?status=&table_id=&created_from=&created_to=&limit=&offset=` | mọi role | — (xem mục B) | ✅ 🧪 |
| 19 | POST | `/api/v1/orders/{id}/items` | S C W (gọi thêm sau gửi bếp được; bàn BILLING → 409) | 09 | ✅ 🧪 |
| 20 | PATCH | `/api/v1/orders/{id}/items/{item_id}` | S C W, món CREATED | 09, 19 | ✅ 🧪 |
| 21 | DELETE | `/api/v1/orders/{id}/items/{item_id}` | S C W, món CREATED | 09, 19 | ✅ 🧪 |
| 22 | POST | `/api/v1/orders/{id}/send-to-kitchen` | S C W | 09, 19 | ✅ 🧪 |

### A5. Bếp (KDS)

| # | Method | Endpoint | Quyền | Màn hình dùng | Trạng thái |
|---|---|---|---|---|---|
| 23 | GET | `/api/v1/kitchen/queue?station_id=&status=&delayed_only=` | S K | 31 Món mới, 32 Đang nấu, 33 Món trễ (SLA 8/12/15'), 34 Chờ lấy | ✅ 🧪 |
| 24 | GET | `/api/v1/kitchen/stations` | mọi role | 31–34 (lọc theo trạm), 103 (gán trạm) | ✅ 🧪 |
| 25 | POST | `/api/v1/orders/{id}/items/{item_id}/start-cooking` | S K | 31 | ✅ 🧪 |
| 26 | POST | `/api/v1/orders/{id}/items/{item_id}/mark-ready` | S K | 32, 33 | ✅ 🧪 |
| 27 | POST | `/api/v1/orders/{id}/items/{item_id}/pickup` | S W | 34 | ✅ 🧪 |
| 28 | POST | `/api/v1/orders/{id}/items/{item_id}/served` | S W | 34 / 05 | ✅ 🧪 |

### A6. Thanh toán và ngoại lệ

| # | Method | Endpoint | Quyền | Màn hình dùng | Trạng thái |
|---|---|---|---|---|---|
| 29 | POST | `/api/v1/orders/{id}/request-billing` (order + bàn → BILLING) | S C W | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 30 | POST | `/api/v1/orders/{id}/pay` | S C | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 31 | POST | `/api/v1/orders/{id}/close` | S C | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 32 | POST | `/api/v1/orders/{id}/items/{item_id}/void` | S | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 33 | POST | `/api/v1/orders/{id}/items/{item_id}/refire` | S | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 34 | GET | `/api/v1/mock/summary` (+ trang `/pos`, `/kitchen`, `/customer`, `/admin`) | công khai | trang mock cũ | ✅ (sẽ bỏ) |

### A7. Tra cứu nhật ký (chỉ Supervisor)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 35 | GET | `/api/v1/audit-logs?order_id=&entity_id=&entity_type=&action=&staff_id=&created_from=&created_to=&limit=&offset=` | S | QA lấy bằng chứng actor/thời điểm; `order_id` gồm cả thao tác trên các món của order | ✅ |
| 36 | GET | `/api/v1/orders/{id}/versions` | S | Lịch sử snapshot order_version + người tạo | ✅ |

**Event WebSocket** (không phải endpoint, liệt kê để FE/QA đối chiếu):
`TABLE_SESSION_OPENED`, `TABLE_STATUS_CHANGED` (kênh `tables`); `KITCHEN_QUEUE_UPDATED`,
`ORDER_ITEM_STATUS_CHANGED`, `ORDER_ITEM_VOIDED`, `ORDER_ITEM_REFIRED` (kênh `kitchen`).
Chưa có event khi tạo order/thêm-sửa-bỏ món — FE gọi lại REST sau thao tác của chính mình.

---

## B. API đã có nhưng FE Pha 1 chưa dùng

| API | Vì sao chưa dùng | Sẽ dùng ở đâu / pha nào |
|---|---|---|
| **27 API nghiệp vụ còn lại** (trừ login, sơ đồ bàn, mở bàn) | FE mới làm đợt 1 (PR #23, lên staging 12/10): đăng nhập, sơ đồ bàn, mở bàn, khung màn bếp | **Pha 1**, theo kế hoạch 13–20/10 |
| `request-billing`, `pay` | 15 màn Figma Pha 1 không có màn thanh toán | **Pha 1 (demo 23/10)**: tạm 1 nút "Thanh toán" ở màn 19 hoặc 05 để kết thúc luồng. **Pha 2**: màn thanh toán đa phương thức thay thế |
| `close` | Bước chốt sổ sau khi in hóa đơn; Pha 1 không in hóa đơn | **Pha 2**, cùng màn thanh toán/hóa đơn |
| `void`, `refire` | Thao tác override của Supervisor; màn 35 Item detail để sau Pha 1 | **Pha 1**: QA test qua API. **Pha 2**: nút trên màn chi tiết món / chi tiết bàn cho Supervisor |
| `GET /orders` (danh sách) | Không có màn tra cứu order trong Pha 1 | **Pha 1**: QA tìm order làm fixture. **Pha 2**: màn tra cứu order, Audit/Report |
| `GET /kitchen/queue?delayed_only=true` | Thuộc màn 33 Món trễ — FE làm sau cùng | **Pha 1** (19/10 theo kế hoạch) |
| `/health`, `/ready`, `/version` | API vận hành, không dành cho giao diện | CI/CD, giám sát (đang dùng) |
| `mock/summary` + trang mock | Trang giả từ Sprint 0, sẽ bị giao diện FE thay ở `/` | **Bỏ** sau khi FE deploy ổn định (Pha 1, sau 23/10) |

---

## C. Pha 1 — đề xuất bổ sung (không bắt buộc cho demo)

| Đề xuất | Lý do | Ưu tiên |
|---|---|---|
| `GET /api/v1/auth/me` | FE tải lại trang vẫn biết role/outlet mà không phải đọc lại localStorage | Thấp — FE đang lưu `staff` từ response login |
| Event WS `ORDER_UPDATED` trên kênh `tables` | Máy POS khác thấy order đổi mà không cần tải lại | Trung bình — chỉ cần khi demo 2 máy POS cùng lúc |
| Kiểm tra xung đột version (`expected_version` → 409) | QA hỏi (TC version conflict); SRS chưa rõ có bắt buộc | Chờ QA chỉ mục SRS |
| CRUD trạm bếp `/api/v1/kitchen/stations` (POST/PATCH) | QA cần 6 trạm; hiện trạm tạo bằng seed | Chờ PO chốt 6 trạm/Expeditor |

Không phải API nhưng phục vụ Pha 1: script reset dữ liệu staging + tạo dữ liệu mẫu (`backend/scripts/reset_staging_data.py`, chạy từ GitHub Actions → "Reset staging data"), đã có từ 12/10.

---

## D. API các pha sau — đề xuất (📝 chưa code)

### Pha 2 · Sprint 3–4 (26/10 – 20/11)

| Nhóm (Board) | Endpoint đề xuất | Vì sao chưa làm |
|---|---|---|
| **Thanh toán đa phương thức** (BRD Payment) | `POST /orders/{id}/payments` (CASH/CARD/QR, số tiền), `GET /orders/{id}/payments`, `POST /payments/{id}/cancel`, `POST /payments/webhooks/{provider}` (callback có chữ ký), `POST /orders/{id}/split-bill` | Cần sandbox cổng thanh toán và quyết định gateway (SEC-05 đang bị chặn). Pha 1 `/pay` chỉ ghi nhận đã trả |
| **Merge / Split / Transfer bàn** | `POST /tables/{id}/transfer` (chuyển sang bàn khác), `POST /tables/merge`, `POST /orders/{id}/split` | BRD Permission Matrix có (W, S); không thuộc luồng gọi món cơ bản; HLR yêu cầu chuyển kèm order, bếp, thanh toán, audit |
| **Quản lý nhân sự / phân quyền** | `GET/POST /staff`, `PATCH /staff/{id}`, `POST /staff/{id}/lock`, `POST /staff/{id}/unlock`, `POST /staff/{id}/reset-password` | Pha 1 tài khoản tạo bằng seed; cần màn admin (Pha 2) |
| **Bảo mật đăng nhập** (SEC-02) | `POST /auth/pin-login`, khóa tài khoản sau N lần sai (không thêm endpoint), `POST /auth/refresh` | PIN policy/lockout chưa được BA/Security chốt |
| **Audit search / report** | Phần đọc đã có từ 15/10 (mục A7). Pha 2 còn: màn hình tra cứu, xuất báo cáo | Bảng `audit_log` đã ghi từ Pha 1; chỉ thiếu API đọc + màn hình |
| **QR Ordering** (Key Focus BRD) | `POST /tables/{id}/qr-session` (cấp `qr_session_token`), `GET /public/qr/{token}/menu`, `POST /public/qr/{token}/orders`, `GET /public/qr/{token}/orders/{id}`, `POST /public/qr/{token}/request-bill` | Module mới hoàn toàn, API công khai không đăng nhập → phải rà Permission Matrix và chống lạm dụng trước |
| **Modifier cơ bản** (cho QR + POS) | `GET /menu/{id}/modifiers`, `POST/PATCH /menu/{id}/modifiers`, field `modifiers[]` trong `POST /orders/{id}/items` | Chưa có schema; QA/PO hỏi về combo/size/topping, chờ PO chốt |
| **Rewards / CRM** (Key Focus BRD) | `GET /customers?phone=`, `POST /customers`, `GET /customers/{id}/rewards`, `POST /orders/{id}/apply-reward`, `DELETE /orders/{id}/rewards/{reward_id}` | Cần bảng khách hàng/điểm thưởng mới (migration), PO chốt luật tích/đổi điểm |

### Pha 3 · SIT/UAT (23/11 – 04/12) — chỉ làm nếu còn thời gian

| Nhóm | Endpoint đề xuất | Vì sao để Pha 3 |
|---|---|---|
| **Menu đầy đủ** (combo, giá theo thời gian, version) | `GET/POST/PATCH /combos`, `GET/POST /menu/{id}/prices`, `GET /menu/versions`, `POST /menu/publish` | Board xếp Pha 3 "nếu còn thời gian" |
| **Inventory / BOM** (HLR P2, **PO chưa quyết**) | `GET/POST/PATCH /ingredients`, `GET/PUT /menu/{id}/recipe` (BOM), `GET /stock-levels`, `POST /stock-movements` (nhập/điều chỉnh), tự trừ kho khi gửi bếp + tự báo hết món | Phạm vi chưa chốt (GOV-02, GAP-01). Hiện "hết món" bật/tắt tay qua `PATCH /menu/{id}` |
| **Offline sync** (stub) | `POST /sync/orders` (gửi lô thao tác kèm `Idempotency-Key` từ máy POS), `GET /sync/status` | Board: chỉ stub điểm nối, đề xuất lùi sau go-live. Pha 1 đã chống trùng nhờ `Idempotency-Key` |
| **ERP / E-invoice** (stub) | `POST /orders/{id}/e-invoice`, `GET /orders/{id}/e-invoice`, `GET /integrations/status` | Board: chỉ stub, chưa tích hợp thật; cần thông tin hệ thống ngoài |
| **Báo cáo** (HLR Reporting) | `GET /reports/sales?from=&to=`, `GET /reports/kitchen-sla`, `GET /reports/table-turnover` | HLR có module Reporting nhưng Board chưa xếp pha — **cần PO xếp** |
| **Course / hold / recall** (Figma 13–15) | `POST /orders/{id}/items/{item_id}/hold`, `.../recall`, field `course` khi thêm món | Figma có màn nhưng ngoài 15 màn Pha 1 |

### Màn Figma để sau Pha 1 (chưa xếp pha, cần PO)

| Màn | Endpoint đề xuất | Ghi chú |
|---|---|---|
| 02 Chọn outlet | `GET /outlets`, `POST /auth/switch-outlet` | Pha 1 mỗi nhân viên gắn sẵn 1 outlet |
| 03 Khu vực (floor area) | `GET/POST /areas`, `GET /tables?area_id=` | Schema chưa có khái niệm khu vực |
| 07 Đặt bàn, 08 Hàng chờ khách | `GET/POST/PATCH /reservations`, `GET/POST /waitlist` | HLR có, Board chưa xếp |
| 30 Dashboard bếp, 35 Chi tiết món | dùng lại `GET /kitchen/queue`, `GET /orders/{id}` + `void`/`refire` | Gần như không cần API mới |

### Pha 4 · Go-live (07/12 – 18/12)

Không thêm API nghiệp vụ. Việc hạ tầng: domain + HTTPS, `compose.prod.yml`, backup DB trước
migration, rollback tự động, Sentry/structured log. `/health`, `/ready`, `/version` đã sẵn cho
giám sát.

---

## E. Việc cần quyết để chốt API các pha sau

| Quyết định | Ảnh hưởng API | Ai |
|---|---|---|
| State machine bàn/order/món | Trạng thái và chuyển trạng thái của mục A4–A6 | PO |
| Inventory/BOM có trong Release 1? | Toàn bộ nhóm Inventory/BOM (mục D, Pha 3) | PO |
| Combo / modifier / size ở pha nào | Schema món + `POST /orders/{id}/items` | PO |
| 6 trạm bếp, Expeditor | CRUD trạm, luật định tuyến | PO + QA (nguồn SRS) |
| Cổng thanh toán | Nhóm Payment Pha 2 | PO + Finance |
| Reporting, Reservation, Floor area xếp pha nào | Mục D | PO |
