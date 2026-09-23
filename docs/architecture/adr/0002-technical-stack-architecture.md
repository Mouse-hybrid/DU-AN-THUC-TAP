# ADR 0002: Nền tảng kỹ thuật và kiến trúc backend cho Release 1

- Trạng thái: Proposed — chờ Tech Lead/team xác nhận trước khi Accepted
- Ngày: 2026-09-23
- Người đề xuất: Backend Developer (soạn cùng Claude, dựa trên BRD/HLR và ADR 0001 hiện có)
- Tương ứng: TECH-01 → TECH-12 trong `Checklist_BE_2Weeks` (Project_Plan.xlsx)

## Bối cảnh

Checklist kickoff hiện có (`Checklist_BE_2Weeks`) đang để trạng thái "Đang thực hiện" cho
toàn bộ nhóm 2E. Nền tảng kỹ thuật (TECH-01 đến TECH-12). Repo staging hiện tại
(`DU-AN-THUC-TAP`) đã dùng Python 3.11 + FastAPI + PostgreSQL theo ADR 0001, nhưng đó là
bản dựng nền cho 5 màn hình mock, quy mô nhỏ hơn nhiều so với BRD đầy đủ (POS SYSTEM – FULL
BRD) với ~100 màn hình trên 8 module. ADR này chốt lại nền tảng kỹ thuật cho đúng quy mô
BRD, dựa trên yêu cầu phi chức năng đã có sẵn trong BRD/HLR:

- Stateless backend, horizontal scaling (BRD NFR: Horizontal Scalability)
- KDS/Order update ≤2s, WebSocket cho realtime (BRD Action/Target table)
- Idempotency bắt buộc cho mọi API tạo order/payment (BRD NFR: Idempotency)
- RBAC theo Permission Matrix, audit log immutable (BRD Security/Audit Requirements)
- Offline mode: POS/KDS/QR phải tiếp tục hoạt động khi mất mạng, sync lại sau (BRD module Offline Mode & Sync)

## Quyết định

### TECH-01/02 — Ngôn ngữ & runtime version
**Python 3.11.** Giữ nguyên theo ADR 0001, team đã có kinh nghiệm thực tế trên repo staging,
hỗ trợ tốt cho FastAPI/async, không có lý do kỹ thuật để đổi.

### TECH-03 — Framework
**FastAPI.** Native async (cần cho WebSocket + nhiều I/O đồng thời khi peak >=200 concurrent),
tự sinh OpenAPI (đáp ứng GIT-09 — nơi lưu OpenAPI), đã có sẵn trong repo hiện tại nên không mất
công chuyển đổi.

### TECH-04 — SQL engine & version
**PostgreSQL 16.** Khớp với `infra/compose/compose.staging.yml` hiện tại (`postgres:16-alpine`).
Hỗ trợ tốt JSON columns (cho các trường linh hoạt như modifier/combo config), transaction mạnh
(cần cho idempotency + order versioning).

### TECH-05 — Công cụ migration
**Alembic.** Đã có trong `requirements.txt` nhưng CHƯA được wire (`alembic.ini`, thư mục
`migrations/`) — cần setup ngay trong tuần 1, vì đây là việc chặn toàn bộ phần thiết kế schema
tiếp theo.

### TECH-06 — Kiến trúc ban đầu
**Modular monolith**, KHÔNG tách microservices ở Release 1. Lý do: BRD chỉ yêu cầu *stateless
backend* để có thể scale ngang bằng cách thêm instance đứng sau load balancer — không yêu cầu
tách service riêng. Với quy mô team hiện tại (dự án thực tập), microservices sẽ tăng overhead
vận hành/CI-CD không cần thiết. Ranh giới module (order, table, kitchen, payment, menu,
promotion, inventory...) vẫn phải tách rõ theo package/router để dễ tách service sau nếu cần
(multi-outlet scale lớn).

### TECH-07 — Chuẩn API & versioning
- REST cho toàn bộ CRUD, prefix `/api/v1/...`, version tăng khi có breaking change.
- WebSocket riêng theo domain thay vì 1 kênh chung: `/ws/kitchen/{station_id}`,
  `/ws/tables`, `/ws/orders/{order_id}` — để mỗi client chỉ nhận đúng dữ liệu cần, giảm tải.
- Mọi API tạo mới (order, payment, table session) bắt buộc nhận header `Idempotency-Key`.

### TECH-08 — Cách authentication
- Staff (POS/Kitchen/Admin): JWT, thời hạn ngắn + refresh token.
- QR customer: không bắt buộc login — cấp token tạm gắn với `table_session` khi quét QR hợp
  lệ, không có JWT tài khoản thật trừ khi khách nhập số điện thoại để nhận thưởng (theo đúng
  BRD: "No login required for QR, optional phone for rewards").

### TECH-09 — Nguyên tắc phân quyền
**RBAC** theo đúng Permission Matrix đã có trong BRD (Kitchen không sửa order, Customer không
hủy sau khi gửi, Waiter không override payment, Supervisor bắt buộc cho exception). Implement
dưới dạng middleware/dependency injection của FastAPI, kiểm tra role trước khi vào handler,
không kiểm tra rải rác trong business logic.

### TECH-10 — Logging & audit tối thiểu
- Logging kỹ thuật: structured JSON log (level, timestamp, request_id) để dễ đưa vào
  ELK/Loki sau này.
- Audit log nghiệp vụ: bảng `audit_log` riêng, **append-only** (không cho UPDATE/DELETE ở tầng
  DB permission), ghi mọi order change, payment event, table action (merge/split), reward
  usage — đúng yêu cầu "Logs must be immutable" trong BRD.

### TECH-11 — WebSocket / event / queue
**Dùng WebSocket** cho mọi cập nhật realtime tới client (KDS, table map, order tracking) —
bắt buộc vì NFR yêu cầu update ≤2s. **Chưa dùng message broker riêng** (Kafka/RabbitMQ) ở
Release 1 — Offline Mode & Sync trong BRD được thiết kế theo kiểu local queue (client giữ
`sync_status: PENDING/SYNCED/FAILED` và tự retry), không cần broker phía server. Khi cần scale
nhiều instance backend cho WebSocket fan-out, dùng Redis pub-sub (đã có trong checklist hạ
tầng, nhóm E) thay vì đầu tư broker nặng ngay từ đầu.

### TECH-12 — Phương án chạy local
Giữ nguyên 2 lựa chọn đã có trong repo hiện tại, dùng tuỳ mục đích:
- **venv trực tiếp** (`backend/.venv`, `python -m uvicorn app.main:app --reload`) — cho vòng
  lặp code nhanh hàng ngày, không cần Docker.
- **Docker Compose** (`infra/compose/compose.staging.yml`) — khi cần test gần giống staging
  thật (có Postgres + Nginx), hoặc trước khi mở PR lớn.

## Hệ quả

### Tích cực
- Không phải học công nghệ mới — tận dụng toàn bộ kinh nghiệm và code đã có từ repo staging.
- Modular monolith giữ tốc độ phát triển nhanh cho team nhỏ, vẫn để ngỏ đường tách service sau.
- Idempotency + audit log immutable giải quyết trực tiếp 2 rủi ro lớn nhất trong BRD (double
  payment, mất order).

### Hạn chế / rủi ro cần theo dõi
- WebSocket fan-out khi nhiều outlet cùng lúc cần Redis pub-sub — chưa setup ở Release 1, phải
  làm trước khi multi-outlet thật sự online (NFR: >=1000 concurrent multi-outlet).
- Modular monolith có thể trở thành nút thắt nếu một module (vd Kitchen) cần scale riêng —
  chấp nhận rủi ro này ở Release 1, review lại ở ADR riêng nếu xảy ra.
- Chưa chốt được liệu Inventory/BOM có vào Release 1 (đang "Chưa bắt đầu" ở INV-01 trong
  checklist kickoff) — nếu vào, cần bổ sung ADR con cho thiết kế schema Inventory riêng vì
  BRD/HLR chưa mô tả field chi tiết cho module này.

## Điều kiện để thay đổi quyết định

ADR này chỉ áp dụng cho Release 1. Đổi framework/ngôn ngữ/kiến trúc sau khi đã bắt đầu code
cần một ADR mới nêu rõ lý do kỹ thuật cụ thể (không đổi vì sở thích cá nhân), vì chi phí đổi
giữa chừng rất cao với một dự án nhiều module như POS này.

## Việc cần làm ngay sau khi ADR được duyệt

1. Wire Alembic (`alembic init`, cấu hình `alembic.ini` trỏ đúng `DATABASE_URL`).
2. Tạo router structure theo module: `app/modules/{order,table,kitchen,payment,menu,...}`.
3. Setup middleware RBAC + JWT auth skeleton.
4. Tạo bảng `audit_log` với DB permission chặn UPDATE/DELETE.
5. Update trạng thái TECH-01 → TECH-12 trong `Checklist_BE_2Weeks` từ "Đang thực hiện" sang
   "Hoàn tất" sau khi Tech Lead xác nhận ADR này.
