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
| 87 | GET | `/api/v1/ops/metrics?hours=24` | S | Giám sát (từ 09/11): độ trễ, lỗi 5xx theo route; tỉ lệ món trễ bếp; tỉ lệ thanh toán thành công; `alerts` khi vượt ngưỡng. Xem `docs/runbooks/monitoring.md` | ✅ |
| 5 | WS | `/api/v1/ws?token=&channel=tables\|kitchen` | mọi role | 04 Sơ đồ bàn, 31–34 Hàng đợi bếp | ✅ 🧪 một phần (mới test từ chối khi thiếu token; event và reconnect chưa test — TC_EXT_016–017) |

Từ 09/11 mọi response có header `X-Request-ID` (FE gửi kèm header này thì server dùng lại, tối đa 64 ký tự chữ, số, `. _ -`). Lỗi 500 trả `{"detail", "request_id"}`: khi báo lỗi gửi kèm `request_id` để tìm đúng dòng log.

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
| 23 | GET | `/api/v1/kitchen/queue?station_id=&status=&delayed_only=&item_status=` | S K | 31 Món mới (`status=QUEUED`), 32 Đang nấu (`status=IN_PROGRESS`), 33 Món trễ (`delayed_only=true`, SLA 8/12/15'), 34 Chờ lấy (**`item_status=READY`**, từ 19/10) | ✅ 🧪 |
| 24 | GET | `/api/v1/kitchen/stations` | mọi role | 31–34 (lọc theo trạm), 103 (gán trạm) | ✅ 🧪 |
| 25 | POST | `/api/v1/orders/{id}/items/{item_id}/start-cooking` | S K | 31 | ✅ 🧪 |
| 26 | POST | `/api/v1/orders/{id}/items/{item_id}/mark-ready` | S K | 32, 33 | ✅ 🧪 |
| 27 | POST | `/api/v1/orders/{id}/items/{item_id}/pickup` | S W | 34 | ✅ 🧪 |
| 28 | POST | `/api/v1/orders/{id}/items/{item_id}/served` | S W | 34 / 05 | ✅ 🧪 |

### A6. Thanh toán và ngoại lệ

| # | Method | Endpoint | Quyền | Màn hình dùng | Trạng thái |
|---|---|---|---|---|---|
| 29 | POST | `/api/v1/orders/{id}/request-billing` (order + bàn → BILLING) | S C W | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 30 | POST | `/api/v1/orders/{id}/pay` (từ 09/11: lối tắt trả nốt bằng tiền mặt, xem A17) | S C | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 31 | POST | `/api/v1/orders/{id}/close` | S C | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 32 | POST | `/api/v1/orders/{id}/items/{item_id}/void` | S | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 33 | POST | `/api/v1/orders/{id}/items/{item_id}/refire` | S | **không có trong 15 màn** — xem mục B | ✅ 🧪 |
| 34 | ~~GET~~ | ~~`/api/v1/mock/summary` (+ trang `/pos`, `/kitchen`, `/customer`, `/admin`)~~ | — | trang mock cũ | **Đã gỡ 28/10** |

### A7. Tra cứu nhật ký (chỉ Supervisor)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 35 | GET | `/api/v1/audit-logs?order_id=&entity_id=&entity_type=&action=&staff_id=&created_from=&created_to=&limit=&offset=` | S | QA lấy bằng chứng actor/thời điểm; `order_id` gồm cả thao tác trên các món của order | ✅ |
| 36 | GET | `/api/v1/orders/{id}/versions` | S | Lịch sử snapshot order_version + người tạo | ✅ |
| 81 | GET | `/api/v1/audit-logs/summary` (cùng bộ lọc với danh sách) | S | Báo cáo: `total`, `exception_total`, `by_action`, `by_staff`, `by_day`. Mặc định 7 ngày gần nhất, tối đa 93 ngày (422 nếu vượt) | ✅ từ 09/11 |
| 82 | GET | `/api/v1/audit-logs/export` (cùng bộ lọc với danh sách) | S | Tải CSV (UTF-8 có BOM để mở bằng Excel), giờ Việt Nam, tối đa 10.000 dòng (`X-Truncated: true` nếu bị cắt) | ✅ từ 09/11 |

Từ 09/11 danh sách `GET /audit-logs` có header `X-Total-Count` (tổng số dòng khớp bộ lọc) và `sort=asc|desc` (mặc định `asc`, cũ nhất trước).

**Thao tác ngoại lệ** (`is_exception`, cột `exception` trong CSV): `ORDER_ITEM_VOIDED`, `ORDER_ITEM_REFIRED`, `ORDER_REWARD_OVERRIDDEN`, `POINTS_ADJUSTED`, `STAFF_LOCKED`, `STAFF_PASSWORD_RESET`, `STAFF_UPDATED`, `MENU_ITEM_UPDATED`, `LOYALTY_RULE_CREATED`, `STAGING_DATA_RESET`. Danh sách đặt trong `backend/app/api/v1/audit.py`, cần PO xác nhận.

`by_staff` có một dòng `staff_id: null` cho thao tác của khách QR và của hệ thống. `by_day` tính theo ngày giờ Việt Nam (UTC+7). CSV chặn ô bắt đầu bằng `= + - @` để Excel không chạy như công thức.

### A8. Phân quyền và quản lý nhân viên (từ 04/11)

Ma trận quyền **mặc định** nằm ở `backend/app/core/permissions.py`. Từ 09/11 Supervisor sửa được từng ô trên màn Vai trò; quyền thực tế = mặc định + các ô đã sửa, lưu theo outlet (`app/core/rbac.py`).

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 37 | GET | `/api/v1/auth/me` | đã đăng nhập | Thông tin kèm `permissions[]`, để FE ẩn/hiện nút | ✅ |
| 38 | POST | `/api/v1/auth/change-password` | đã đăng nhập | Tự đổi mật khẩu; trả token mới, các phiên cũ hết hiệu lực | ✅ |
| 39 | GET | `/api/v1/staff?role=&is_active=` | S | 93 Tài khoản nhân viên | ✅ |
| 40 | POST | `/api/v1/staff` (cần `Idempotency-Key`) | S | Tạo tài khoản; mật khẩu tối thiểu 8 ký tự, tối đa 72 byte | ✅ |
| 41 | GET | `/api/v1/staff/{id}` | S | Chi tiết nhân viên | ✅ |
| 42 | PATCH | `/api/v1/staff/{id}` | S | Đổi `full_name`, `role`; đổi role thì người đó phải đăng nhập lại | ✅ |
| 43 | POST | `/api/v1/staff/{id}/lock`, `/unlock` | S | Khóa có hiệu lực ngay; không có API xóa nhân viên | ✅ |
| 44 | POST | `/api/v1/staff/{id}/reset-password` | S | Đặt lại mật khẩu; các phiên cũ hết hiệu lực | ✅ |
| 45 | GET | `/api/v1/staff/permissions` | S | 94 Vai trò & quyền. Mỗi dòng: `roles` (đang áp dụng), `default_roles`, `locked_roles` (ô không bỏ được), `customized` | ✅ |
| 88 | PUT | `/api/v1/staff/permissions/{permission}` (cần `Idempotency-Key`) | S | Tick/bỏ tick một dòng: body `{"roles": ["CASHIER", "SUPERVISOR"]}` là danh sách **đầy đủ** sau khi sửa; trả lại cả ma trận | ✅ từ 09/11 |
| 89 | POST | `/api/v1/staff/permissions/reset` (cần `Idempotency-Key`) | S | Khôi phục toàn bộ về mặc định; trả lại cả ma trận | ✅ từ 09/11 |

Không ai được tự đổi role, tự khóa hay tự đặt lại mật khẩu của chính mình qua `/staff` (trả 409). Token bị thu hồi trả 401 như token hết hạn.

**Sửa quyền (từ 09/11):**
- Có hiệu lực ngay ở request kế tiếp của mọi nhân viên, không cần đăng nhập lại.
- Không bỏ được quyền `STAFF_MANAGE` của Supervisor (409), để luôn còn người vào sửa lại được.
- Mỗi lần sửa ghi audit `ROLE_PERMISSION_UPDATED` (vai trò thêm, bớt); khôi phục ghi `ROLE_PERMISSIONS_RESET`. Cả hai là thao tác ngoại lệ trong báo cáo audit.
- **FE cần ẩn/hiện nút theo `permissions[]` của `GET /auth/me`, không theo tên vai trò**; nếu không, quyền vừa sửa sẽ không hiện đúng trên giao diện (BE vẫn chặn đúng).

### A9. Tầng/khu (từ 04/11)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 46 | GET | `/api/v1/areas?active_only=` | mọi role | 03 Tổng quan khu vực: mỗi khu có `table_count`, `status_counts` | ✅ |
| 47 | POST | `/api/v1/areas` (cần `Idempotency-Key`) | S | Thêm khu, trùng tên trả 409 | ✅ |
| 48 | PATCH | `/api/v1/areas/{id}` | S | Đổi tên, thứ tự, ẩn khu; khu còn bàn thì không ẩn được (409) | ✅ |
| 49 | PATCH | `/api/v1/tables/{id}` | S | Gán bàn vào khu, `{"area_id": null}` để bỏ ra | ✅ |

`GET /api/v1/tables` có thêm bộ lọc `?area_id=`; bàn trả về có `area_id`, `area_name` và xếp theo số trong mã (B2 trước B10). Chưa có API thêm/xóa bàn.

### A10. QR Ordering (từ 04/11)

Khách không đăng nhập; token trong URL là quyền truy cập duy nhất. Quyền `C, W, S` là Cashier, Waiter, Supervisor.

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 50 | POST | `/api/v1/tables/{id}/qr-session` (cần `Idempotency-Key`) | C, W, S | 107 Mã QR theo bàn. Bàn chưa mở phiên trả 409; cấp lại thì mã cũ hết dùng. Trả `token`, `expires_at`, `path` (`/qr/{token}`) | ✅ |
| 51 | GET | `/api/v1/tables/{id}/qr-session` | C, W, S | Xem lại mã còn hạn; không có trả 404 | ✅ |
| 52 | DELETE | `/api/v1/tables/{id}/qr-session` | C, W, S | Thu hồi mã, trả 204 | ✅ |
| 53 | GET | `/api/v1/public/qr/{token}` | token | 40 Xác nhận bàn: `table_code`, `area_name`, `expires_at`, `ordering_locked` | ✅ |
| 54 | GET | `/api/v1/public/qr/{token}/menu` | token | 41, 42 Thực đơn; có cả món hết hàng (`is_available: false`) | ✅ |
| 55 | POST | `/api/v1/public/qr/{token}/orders` (cần `Idempotency-Key`) | token | 44, 47 Gửi món: tối đa 20 dòng, mỗi dòng 1–20 phần, ghi chú 200 ký tự | ✅ |
| 56 | GET | `/api/v1/public/qr/{token}/order` | token | 48, 53 Món của cả phiên bàn | ✅ |

**Quy tắc** (phiếu quyết định B6: đơn QR chờ phục vụ xác nhận):
- Món của khách nằm ở `CREATED`, `source: "QR"`, trong đơn đang mở của bàn; bàn chỉ có 1 hóa đơn, dùng chung với POS.
- Xác nhận: phục vụ gọi `POST /orders/{id}/send-to-kitchen` như món POS. Từ chối: `DELETE /orders/{id}/items/{item_id}`, món thành `VOIDED`. Khách không sửa/xóa được sau khi gửi.
- Mỗi lần khách gửi, kênh `tables` có event `ORDER_UPDATED` với `reason: "QR_ITEMS_SUBMITTED"`. Phía khách không có WebSocket, gọi lại `GET .../order` định kỳ.

| Mã | Khi nào |
|---|---|
| `401` | Token sai, đã thu hồi, hoặc đã bị thay bằng mã mới |
| `410` | Token hết hạn (mặc định 4 giờ, `QR_SESSION_TTL_MINUTES`) hoặc phiên bàn đã đóng; hiện màn 54 |
| `400` | Thiếu `Idempotency-Key` |
| `404` | Món không có trong thực đơn của nhà hàng |
| `409` | Món hết hàng; bàn đang chờ thanh toán; quá 30 phần đang chờ xác nhận (`QR_MAX_PENDING_ITEMS`); cùng `Idempotency-Key` khác nội dung |
| `422` | Dữ liệu không hợp lệ |
| `429` | Vượt giới hạn request theo IP (Nginx: 10 request/giây, burst 40) |

Chưa có: khách tự yêu cầu thanh toán và thanh toán QR (49–51, làm cùng VNPay), định danh hội viên (làm cùng Rewards).

### A11. Tùy chọn món (từ 04/11)

Theo phiếu B7: size và topping có giá cộng thêm, chưa có combo. Tùy chọn gắn theo từng món.

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 57 | GET | `/api/v1/menu/{id}/modifiers?active_only=` | mọi role | 10 Tùy chọn món; `GET /menu` có `has_modifiers` để biết có cần gọi không | ✅ |
| 58 | POST | `/api/v1/menu/{id}/modifiers` (cần `Idempotency-Key`) | S | 104 Thêm nhóm kèm tùy chọn: `name`, `min_select`, `max_select`, `options[]` | ✅ |
| 59 | PATCH | `/api/v1/menu/modifiers/{group_id}` | S | Sửa nhóm, ẩn bằng `is_active: false` | ✅ |
| 60 | POST | `/api/v1/menu/modifiers/{group_id}/options` (cần `Idempotency-Key`) | S | Thêm tùy chọn: `name`, `price_delta` | ✅ |
| 61 | PATCH | `/api/v1/menu/modifier-options/{id}` | S | Sửa tùy chọn, hết hàng bằng `is_available: false` | ✅ |

**Khi gọi món:** thêm `modifier_option_ids` vào từng dòng của `POST /orders/{id}/items` và `POST /public/qr/{token}/orders`. Không có nhóm bắt buộc thì không cần gửi, luồng cũ vẫn chạy.

- `unit_price` của dòng món **đã gồm** giá cộng thêm, các tổng tiền tính như cũ. Dòng món, phiếu bếp và API QR có thêm `modifiers[]` (`group_name`, `option_name`, `price_delta`), lưu theo lúc gọi nên sửa tùy chọn sau đó không đổi đơn cũ.
- Thực đơn QR (`GET /public/qr/{token}/menu`) có sẵn `modifier_groups` trong từng món.
- `min_select` ≥ 1 là nhóm bắt buộc. Muốn đổi tùy chọn của dòng đã gọi thì bỏ dòng rồi gọi lại, `PATCH` món chỉ đổi số lượng và ghi chú.
- FE không được cộng dồn 2 dòng cùng món nhưng khác tùy chọn.

| Mã | Khi nào |
|---|---|
| `409` | Tùy chọn hết hàng; trùng tên nhóm hoặc tùy chọn |
| `422` | Thiếu nhóm bắt buộc, chọn quá `max_select`, chọn trùng, tùy chọn không thuộc món hoặc thuộc nhóm đang ẩn; `min_select` > `max_select` |

**Lưu ý khi bật nhóm bắt buộc:** FE chưa gửi `modifier_option_ids` thì gọi món đó sẽ nhận `422`. Seed món demo chỉ dùng nhóm tùy ý; món `Trà đá` của khu QA 3 có `Size` bắt buộc để test.

### A12. Rewards đợt 1 (từ 04/11)

Khách hàng, luật điểm và tích điểm khi thanh toán. Ưu đãi và đổi điểm ở mục A13; mã thành viên trên QR và hoàn điểm là đợt 3. Quyền `C, S` là Cashier, Supervisor.

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 62 | GET | `/api/v1/customers?phone=&limit=&offset=` | C, S | Tra đúng 1 số. Không truyền `phone`: chỉ S, C nhận 403 | ✅ |
| 63 | POST | `/api/v1/customers` (cần `Idempotency-Key`) | C, S | Tạo khách, bắt buộc `consent: true`; trùng số trả 409 | ✅ |
| 64 | GET | `/api/v1/customers/{id}` | C, S | 80 Tra cứu hội viên, số dư | ✅ |
| 65 | GET | `/api/v1/customers/{id}/points?limit=&offset=` | C, S | Lịch sử điểm, mới nhất trước | ✅ |
| 66 | PATCH | `/api/v1/customers/{id}` | S | Sửa tên, khóa bằng `is_active: false`; không có API xóa | ✅ |
| 67 | POST | `/api/v1/customers/{id}/points/adjust` (cần `Idempotency-Key`) | S | Điều chỉnh điểm, bắt buộc `reason`; không đủ điểm trả 409 | ✅ |
| 68 | GET | `/api/v1/loyalty-rules` | S | Phiên bản mới nhất đứng đầu và đang áp dụng | ✅ |
| 69 | POST | `/api/v1/loyalty-rules` (cần `Idempotency-Key`) | S | 79 Tạo phiên bản luật mới, không sửa bản cũ | ✅ |
| 70 | POST | `/api/v1/orders/{id}/customer` (cần `Idempotency-Key`) | C, S | Gắn khách vào đơn, `{"customer_id": null}` để bỏ; đơn đã PAID/CLOSED hoặc khách bị khóa trả 409 | ✅ |

**Quy tắc:**
- Số điện thoại chuẩn hóa về `0xxxxxxxxx`, sai dạng trả 422. Waiter, Kitchen không xem được dữ liệu khách. Audit log không ghi số điện thoại hay tên.
- `POST /orders/{id}/pay` tích điểm theo **luật mới nhất lúc thanh toán**, làm tròn xuống, không tính món `VOIDED`, trong cùng transaction với thanh toán, mỗi đơn đúng 1 lần.
- Đơn không gắn khách, khách bị khóa, chưa có luật hoặc chưa đủ tiền cho 1 điểm: thanh toán vẫn thành công, không tích.
- `expires_at` chỉ được lưu trên dòng tích điểm, **chưa có job tự trừ điểm hết hạn**.
- Luật mặc định lúc seed (tạm, chờ PO chốt): 10.000đ = 1 điểm, 1 điểm = 100đ, đổi tối đa 50% đơn, điểm hết hạn sau 365 ngày.

### A13. Rewards đợt 2: ưu đãi và đổi điểm (từ 04/11)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 71 | GET | `/api/v1/rewards?active_only=` | C, S | Danh sách ưu đãi | ✅ |
| 72 | POST | `/api/v1/rewards` (cần `Idempotency-Key`) | S | `reward_type`: `PERCENT`, `FIXED`, `POINTS`; `value`, `min_order_amount`, `max_discount`, `valid_from`, `valid_to`, `max_uses` | ✅ |
| 73 | PATCH | `/api/v1/rewards/{id}` | S | Sửa, tắt bằng `is_active: false`; không có API xóa | ✅ |
| 74 | GET | `/api/v1/orders/{id}/eligible-rewards` | C, S | 22, 81: dùng được hay không, `reason_code`, `reason`, `discount_amount`, `max_points` | ✅ |
| 75 | POST | `/api/v1/orders/{id}/rewards` (cần `Idempotency-Key`) | C, S | Áp ưu đãi: `reward_id`, `points` (chỉ đổi điểm), `override_reason` (chỉ S). Trả chi tiết đơn | ✅ |
| 76 | DELETE | `/api/v1/orders/{id}/rewards/{order_reward_id}` (cần `Idempotency-Key`) | C, S | Gỡ trước khi thanh toán | ✅ |
| 77 | GET | `/api/v1/customers/{id}/reward-usage` | C, S | Lịch sử dùng ưu đãi đã thanh toán | ✅ |

**Quy tắc:**
- `GET /orders/{id}` và `GET /tables/{id}` có thêm `discount_total`, `total`, `applied_reward`. **`total` là số phải trả**, `subtotal` vẫn là tổng món. API thanh toán lấy tiền theo `total`. `GET /orders` (danh sách) vẫn chỉ có `subtotal`.
- Tiền giảm do server tính, gửi kèm số tiền trả 422. Mỗi đơn 1 ưu đãi, chưa cộng dồn.
- **Trước khi thanh toán, tiền giảm được tính lại theo hóa đơn hiện tại.** Không còn hợp lệ thì `discount_total = 0`, `applied_reward.invalid_reason` có mã lý do, và `/pay` trả 409 tới khi gỡ ưu đãi.
- **Điểm chỉ bị trừ khi thanh toán**, không giữ chỗ lúc áp. Hai đơn cùng đổi một số điểm: đơn trả sau nhận 409. Giá trị điểm theo phiên bản luật lúc áp; điểm tích theo số tiền thực trả.
- Đổi điểm: tối đa theo `max_redeem_percent` của luật và `max_discount` của ưu đãi. Vượt lúc áp trả 409 kèm số tối đa; hóa đơn giảm sau đó thì tự giảm số điểm dùng theo trần mới.
- `override_reason`: chỉ Supervisor, bỏ qua thời hạn, đơn tối thiểu, số lượt, có ghi audit. Không bỏ qua được số dư và trần đổi điểm.
- Đang đổi điểm thì không đổi hoặc bỏ khách được (409).
- Đã thanh toán thì `COMMITTED`: số giảm, điểm và tên ưu đãi không đổi khi sửa ưu đãi, không gỡ được. Đơn được hoàn tiền hết thì thành `REVERSED` (xem mục A18); hóa đơn vẫn giữ số tiền đã giảm.

`reason_code`: `INACTIVE`, `NOT_STARTED`, `EXPIRED`, `MIN_ORDER`, `USAGE_LIMIT`, `NO_CUSTOMER`, `CUSTOMER_LOCKED`, `NO_RULE`, `INSUFFICIENT_POINTS`, `ZERO_DISCOUNT`.

Seed: `Đổi điểm` và `Giảm 10% đơn từ 200.000đ` (tối đa 50.000đ) ở khu demo và khu QA 3. Số liệu tạm, chờ PO chốt.

### A18. Rewards đợt 3: hoàn điểm, hết hạn điểm, số điện thoại trên QR (từ 12/11)

Spec: `specs/002-rewards-dot-3/`.

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 90 | POST | `/api/v1/public/qr/{token}/member` (cần `Idempotency-Key`) | token | Khách nhập số điện thoại để tích điểm: body `{"phone"}`; luôn trả `{"status": "RECEIVED", "phone_masked": "090****567"}` | ✅ |
| 91 | GET | `/api/v1/orders/{id}/pending-member` | C, S | Thu ngân xem số khách đã nhập: `{"phone", "member_customer_id"}` | ✅ |

**Số điện thoại trên QR:**
- Số của thành viên đang hoạt động: tự gắn vào các đơn chưa thanh toán, chưa có khách của bàn. Thanh toán xong khách được tích điểm như bình thường.
- Số chưa là thành viên, bàn đã gắn khách khác, khách bị khóa, hoặc bàn chưa có đơn: số được giữ lại cho thu ngân. Chi tiết đơn/bàn có cờ `has_pending_member: true`. Thu ngân xác nhận đồng ý, đăng ký bằng `POST /customers`, rồi gắn bằng `POST /orders/{id}/customer`. Gắn xong (hoặc phiên đóng) thì số chờ bị xóa.
- **Phản hồi giống nhau mọi trường hợp**, để không dò được số nào là thành viên. Khách không đổi điểm, không xem số dư trên QR.
- Mỗi phiên tối đa 5 lần (`QR_MEMBER_MAX_ATTEMPTS`), lần thứ 6 trả 429. Số sai định dạng trả 422, không tính lần. Mã sai/thu hồi trả 401, hết hạn trả 410.
- Event `ORDER_UPDATED` với `reason: "QR_MEMBER"` để màn thu ngân tải lại.

**Hoàn điểm** (khi đơn được hoàn tiền hết):
- Ghi một dòng `REVERSAL` gộp: trả lại điểm đã đổi, thu lại điểm đã tích.
- Ưu đãi của đơn chuyển `REVERSED`, trả lại một lượt dùng.
- Số dư không âm. Không thu đủ điểm tích (khách đã tiêu) thì ghi audit `POINTS_REVERSAL_SHORTFALL` để Supervisor xử lý.
- Hoàn một phần không đổi điểm (chờ PO chốt có thu theo tỉ lệ không).

**Hết hạn điểm:**
- `scripts/expire_points.py` chạy mỗi ngày 03:00 giờ Việt Nam (workflow *Expire loyalty points*, có chạy thử `dry run`).
- Trừ phần điểm tích đã quá hạn mà chưa dùng, điểm dùng tính vào lô cũ nhất trước. Mỗi khách một dòng `EXPIRE` và một dòng audit `POINTS_EXPIRED`.
- Điểm cộng tay và điểm được trả lại khi hoàn tiền không có hạn. Chạy lại không trừ thêm.

Audit mới: `POINTS_REVERSED`, `POINTS_REVERSAL_SHORTFALL` (cả hai là thao tác ngoại lệ), `POINTS_EXPIRED`, `QR_MEMBER_LINKED`, `QR_MEMBER_PENDING`.

### A14. Chuyển bàn (từ 09/11)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 78 | POST | `/api/v1/tables/{id}/transfer` (cần `Idempotency-Key`) | W, S (BRD "Merge/Split/Transfer Table") | 16 Chuyển bàn: body `{"target_table_id": "..."}`; trả `table_session_id`, `from_table`, `to_table` | ✅ |

**Quy tắc:**
- Cả phiên bàn đi theo: mọi đơn, món, phiếu bếp, ưu đãi, khách gắn vào đơn, mã QR. Mã bàn trên phiếu bếp và trên API QR tự đổi.
- Bàn nguồn phải `OCCUPIED`. Bàn đang chờ thanh toán (`BILLING`) không chuyển được.
- Bàn đích phải `AVAILABLE` hoặc `RESERVED`.
- Sau khi chuyển: bàn đích `OCCUPIED`, **bàn nguồn `CLEANING`**, phải xác nhận dọn xong mới mở lại.
- Cashier không có quyền chuyển (theo BRD). Chuyển trùng bàn trả 422; bàn hoặc bàn đích thuộc nhà hàng khác trả 404; sai trạng thái trả 409.
- Event: kênh `tables` có `TABLE_TRANSFERRED` (`table_session_id`, `from_table_id`, `to_table_id`) và `TABLE_STATUS_CHANGED` cho cả hai bàn. Kênh `kitchen` có `KITCHEN_QUEUE_UPDATED` với `reason: "TABLE_TRANSFERRED"` để màn bếp tải lại mã bàn.

### A15. Gộp bàn (từ 09/11)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 79 | POST | `/api/v1/tables/{id}/merge` (cần `Idempotency-Key`) | W, S | 17 Gộp bàn: `{id}` là bàn chính, body `{"table_ids": [...]}` (1–10 bàn phụ); trả `table_session_id`, `table`, `merged_tables`, `order_id` | ✅ |

**Quy tắc** (một phiên, một đơn, một hóa đơn):
- Bàn chính phải `OCCUPIED`. Bàn phụ có thể đang có khách (`OCCUPIED`) hoặc đang trống (`AVAILABLE`, `RESERVED`, kê thêm bàn). Bàn đang chờ thanh toán, đang dọn, đã gộp, hoặc đang có bàn khác gộp vào thì trả 409.
- Món của bàn phụ chuyển sang đơn của bàn chính, phiếu bếp đi theo món. Đơn cũ của bàn phụ chuyển `CLOSED` và không còn món. Bàn chính chưa có đơn thì đơn đầu tiên của bàn phụ thành đơn chung.
- Phiên bàn phụ đóng, số khách cộng vào bàn chính, **mã QR của bàn phụ hết dùng** (401); khách dùng mã của bàn chính.
- Bàn chính chưa gắn khách thì nhận khách của bàn phụ. **Đơn bàn phụ đang áp ưu đãi thì phải gỡ trước** (409).
- Bàn phụ sang `MERGED`, có `merged_into_table_id` (có trong `GET /tables`, `GET /tables/{id}`), không mở phiên hay dọn được. **Thanh toán bàn chính thì mọi bàn phụ cùng sang `CLEANING`.**
- Bàn chính đang có bàn gộp vào thì không chuyển bàn được (409).
- Event: kênh `tables` có `TABLE_MERGED`, `TABLE_STATUS_CHANGED` cho bàn phụ, `ORDER_UPDATED` với `reason: "TABLES_MERGED"`; kênh `kitchen` có `KITCHEN_QUEUE_UPDATED`.

Chưa có: bỏ gộp giữa chừng (tách bàn ra lại).

### A16. Tách đơn (từ 09/11)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 80 | POST | `/api/v1/orders/{id}/split` (cần `Idempotency-Key`) | W, S | 18 Tách hóa đơn: body `{"items": [{"order_item_id": "...", "quantity": 1}]}`; trả `order` (đơn cũ) và `new_order`, cả hai dạng chi tiết đơn | ✅ |

**Quy tắc:**
- Tách sang hóa đơn mới **cùng bàn**, mỗi hóa đơn yêu cầu thanh toán và thanh toán riêng.
- Món chưa gửi bếp (`CREATED`) hoặc đã phục vụ (`SERVED`) tách lẻ số lượng được; tùy chọn món, ghi chú, giá đi theo. **Món đang ở bếp chỉ tách nguyên dòng** (409), phiếu bếp đi theo món.
- Phải để lại ít nhất 1 món ở đơn cũ (422). Món đã hủy, đơn đang chờ thanh toán, bàn đang chờ thanh toán, hoặc đơn đang áp ưu đãi thì 409.
- Khách hàng đã gắn vẫn ở đơn cũ. Trạng thái hai đơn tính lại theo món còn lại. Có snapshot `order_version` cho cả hai đơn.
- Event: `ORDER_UPDATED` (`reason: "ORDER_SPLIT"`) cho cả hai đơn; kênh `kitchen` có `KITCHEN_QUEUE_UPDATED` vì phiếu bếp của món chuyển nguyên dòng giờ thuộc đơn mới.

**Thay đổi ở thanh toán (áp dụng cho mọi bàn có nhiều đơn):**
- `POST /orders/{id}/pay` chỉ đóng phiên bàn khi **không còn đơn nào có món chưa trả**. Còn đơn chưa trả thì phiên vẫn mở và bàn về `OCCUPIED`, hoặc giữ `BILLING` nếu đơn còn lại đang chờ thanh toán.
- Đơn rỗng (không còn món) được đóng cùng phiên, không giữ bàn.
- Khi bàn đang `BILLING` thì mọi đơn của bàn đều không gọi thêm món được (như trước).
- Khách quét QR gọi thêm thì món vào **đơn cũ nhất** của bàn.

### A17. Thanh toán v2: nhiều lần, nhiều hình thức, hoàn tiền (từ 09/11)

| # | Method | Endpoint | Quyền | Dùng cho | Trạng thái |
|---|---|---|---|---|---|
| 83 | POST | `/api/v1/orders/{id}/payments` (cần `Idempotency-Key`) | S C | 20, 21 Thanh toán: body `{"method": "CASH" \| "CARD", "amount"?, "cash_received"?, "provider_ref"?, "note"?}`; trả `payment`, `order_status`, `summary` | ✅ |
| 84 | GET | `/api/v1/orders/{id}/payments` | S C | Danh sách lần thanh toán, kèm `summary` (`total`, `paid`, `refunded`, `remaining`) | ✅ |
| 85 | POST | `/api/v1/payments/{id}/cancel` (cần `Idempotency-Key`) | S | Hủy lần ghi nhầm khi đơn chưa trả xong: body `{"reason"}` | ✅ |
| 86 | POST | `/api/v1/payments/{id}/refunds` (cần `Idempotency-Key`) | S | 100 Hoàn tiền: body `{"amount"?, "reason"}`, sau khi đơn đã PAID | ✅ |

**Quy tắc:**
- Đơn phải ở `BILLING`. `amount` bỏ trống = trả hết số còn lại. **Không nhận quá số còn phải thu** (409); khách đưa dư tiền mặt thì là tiền thối (`change_due`), không phải trả vượt.
- Tiền mặt: `cash_received` bỏ trống = đưa vừa đủ; ít hơn `amount` thì 422. Thẻ: không có `cash_received` (422); thu ngân xác nhận máy POS đã quẹt, `provider_ref` là số hóa đơn trên máy. `VNPAY` chưa nhận (422), làm ở R2.
- Lần trả đủ tiền chạy đúng logic `/pay`: chốt ưu đãi, trừ và tích điểm, đóng phiên khi là đơn cuối của bàn, bàn sang `CLEANING`.
- Đã nhận một phần tiền thì **không áp thêm ưu đãi và không đổi khách** (409), vì số phải trả có thể thấp hơn số đã thu. Gỡ ưu đãi vẫn được (số phải trả tăng).
- Mọi API ghi khóa dòng đơn: hai thu ngân cùng bấm trả hết thì một bên 201, bên kia 409 (BRD "No duplicate payment").
- Hủy (`cancel`): chỉ khi đơn còn `BILLING`. Đơn đã `PAID` thì dùng hoàn tiền. Hoàn tiền tối đa phần chưa hoàn của lần đó; hoàn hết thì lần thanh toán thành `REFUNDED`. Đơn giữ nguyên trạng thái. Lần hoàn làm đơn được **hoàn hết** thì tự đảo điểm (mục A18); hoàn một phần không đổi điểm.
- `/pay` vẫn dùng được, giờ là lối tắt: ghi 1 lần `CASH` cho số còn lại rồi chốt đơn.
- Chi tiết đơn (`GET /orders/{id}`, `GET /tables/{id}`) có thêm `amount_paid`, `amount_due`.
- Audit: `PAYMENT_RECORDED`, `PAYMENT_CANCELLED`, `PAYMENT_REFUNDED` (hai cái sau là thao tác ngoại lệ trong báo cáo audit). Quyền mới `PAYMENT_REFUND` (chỉ Supervisor).
- Event `ORDER_UPDATED` với `reason`: `PAYMENT_RECORDED`, `PAYMENT_CANCELLED`, `PAYMENT_REFUNDED`; lần trả đủ là `ORDER_PAID` như cũ.
- Đơn đã PAID trước 09/11 không có dòng thanh toán.

**Event WebSocket** (không phải endpoint, liệt kê để FE/QA đối chiếu):
Mọi message có dạng `{"type", "channel", "data", "at"}`. Event chỉ là tín hiệu "có thay đổi" —
FE gọi lại REST để lấy dữ liệu; mất kết nối thì kết nối lại rồi gọi lại REST (server không phát
lại event đã lỡ).

| Kênh | Event | `data` | Khi nào |
|---|---|---|---|
| `tables` | `TABLE_SESSION_OPENED` | `table_id`, `status`, `table_session_id` | Mở bàn |
| `tables` | `TABLE_STATUS_CHANGED` | `table_id`, `status` | Bàn sang BILLING, CLEANING, AVAILABLE |
| `tables` | `ORDER_UPDATED` (từ 15/10) | `order_id`, `table_id`, `table_session_id`, `status`, `current_version`, `reason`, `item_id` | **Mọi** thao tác ghi vào order. `reason`: `ORDER_CREATED`, `ITEMS_ADDED`, `ITEM_UPDATED`, `ITEM_REMOVED`, `SENT_TO_KITCHEN`, `ITEM_STARTED`, `ITEM_READY`, `ITEM_PICKED_UP`, `ITEM_SERVED`, `ITEM_VOIDED`, `ITEM_REFIRED`, `BILLING_REQUESTED`, `PAYMENT_RECORDED`, `PAYMENT_CANCELLED`, `PAYMENT_REFUNDED`, `ORDER_PAID`, `ORDER_CLOSED`; `item_id` có khi thao tác trên 1 món |
| `kitchen` | `KITCHEN_QUEUE_UPDATED` | `order_id`, `items_sent` | Gửi bếp |
| `kitchen` | `ORDER_ITEM_STATUS_CHANGED` / `ORDER_ITEM_VOIDED` / `ORDER_ITEM_REFIRED` | `order_id`, `item_id`, `status` | Bếp nấu/xong, phục vụ lấy/mang ra, hủy, làm lại |

Gợi ý cho FE: màn chi tiết bàn (05) nghe `ORDER_UPDATED` có `table_id` trùng bàn đang mở rồi gọi
lại `GET /tables/{id}`; `reason = ITEM_READY` thì nhắc phục vụ ra lấy món.

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
| ~~`mock/summary` + trang mock~~ | Trang giả từ Sprint 0 | **Đã gỡ 28/10**; `/` của backend giờ chỉ trả chỉ dẫn tới `/docs` |

---

## C. Pha 1 — đề xuất bổ sung (không bắt buộc cho demo)

| Đề xuất | Lý do | Ưu tiên |
|---|---|---|
| ~~`GET /api/v1/auth/me`~~ | **Đã có từ 04/11** (xem mục A8) | — |
| ~~Event WS `ORDER_UPDATED` trên kênh `tables`~~ | **Đã có từ 15/10** (xem bảng event ở mục A) | — |
| Kiểm tra xung đột version (`expected_version` → 409) | QA hỏi (TC version conflict); SRS chưa rõ có bắt buộc | Chờ QA chỉ mục SRS |
| CRUD trạm bếp `/api/v1/kitchen/stations` (POST/PATCH) | QA cần 6 trạm; hiện trạm tạo bằng seed | Chờ PO chốt 6 trạm/Expeditor |

Không phải API nhưng phục vụ Pha 1: script reset dữ liệu staging + tạo dữ liệu mẫu (`backend/scripts/reset_staging_data.py`, chạy từ GitHub Actions → "Reset staging data"), đã có từ 12/10.

---

## D. API các pha sau — đề xuất (📝 chưa code)

### Pha 2 · Sprint 3–4 (26/10 – 20/11)

| Nhóm (Board) | Endpoint đề xuất | Vì sao chưa làm |
|---|---|---|
| **Thanh toán đa phương thức** (BRD Payment) | Tiền mặt, thẻ, trả nhiều lần, hủy, hoàn tiền **đã có từ 09/11** (mục A17). Còn: VNPay sandbox (`GET /payments/vnpay/return`, `POST /payments/{id}/check`, `GET /payments/vnpay/ipn`) | Chờ tài khoản sandbox VNPay (SDD R2) |
| **Merge / Split / Transfer bàn** | Chuyển bàn, gộp bàn, tách đơn **đã có từ 09/11** (mục A14–A16) | Còn bỏ gộp giữa chừng | BRD Permission Matrix có (W, S); không thuộc luồng gọi món cơ bản; HLR yêu cầu chuyển kèm order, bếp, thanh toán, audit |
| ~~**Quản lý nhân sự / phân quyền**~~ | **Đã có từ 04/11** (xem mục A8) | Còn màn 93, 94 phía FE |
| **Bảo mật đăng nhập** (SEC-02) | `POST /auth/pin-login`, khóa tài khoản sau N lần sai (không thêm endpoint), `POST /auth/refresh` | PIN policy/lockout chưa được BA/Security chốt |
| ~~**Audit search / report**~~ | **Đã có** (mục A7): tra cứu từ 15/10, báo cáo và xuất CSV từ 09/11 | Còn màn hình báo cáo phía FE |
| **QR Ordering** (Key Focus BRD) | Phần gọi món **đã có từ 04/11** (mục A10). Còn: `POST /public/qr/{token}/request-bill`, thanh toán QR | Làm cùng VNPay |
| ~~**Modifier cơ bản** (cho QR + POS)~~ | **Đã có từ 04/11** (mục A11) | Chưa có combo |
| **Rewards / CRM** (Key Focus BRD) | Đợt 1, 2 **đã có từ 04/11** (mục A12, A13). Đợt 3: `POST /public/qr/{token}/member`, hoàn điểm | PO chốt con số của luật; khách trên QR chỉ tích điểm, đổi điểm qua thu ngân |

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
