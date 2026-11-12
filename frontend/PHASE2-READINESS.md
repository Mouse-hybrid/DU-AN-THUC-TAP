# Mức sẵn sàng cho Pha 2

Tài liệu này liệt kê những gì Pha 2 cần và backend đã có hay chưa. Chỉ làm phần backend **đã có endpoint thật** (xem mục “Đã làm”); các mục trong bảng thiếu API **chưa có code**: không route, không màn, không hàm gọi API. Khi backend có endpoint thật, chạy `npm run gen:api` rồi mới làm màn tương ứng.

## Đã làm (backend có API)

| Màn / tính năng | Route / vị trí | API dùng | Role |
|---|---|---|---|
| 25 Lịch sử đơn | `/history` | `GET /orders` (lọc `created_from`, phân trang `limit/offset`) | CASHIER, WAITER, SUPERVISOR |
| Đóng đơn (PAID → CLOSED) | `/history`, `/tables/:id/summary` | `POST /orders/{id}/close` | CASHIER, SUPERVISOR |
| Hủy món (bắt buộc nhập lý do) | `/tables/:id`, `/tables/:id/summary`, `/kitchen/orders/:orderId/items/:itemId` | `POST /orders/{id}/items/{item_id}/void` | SUPERVISOR |
| Làm lại món | `/tables/:id`, `/tables/:id/summary`, `/kitchen/orders/:orderId/items/:itemId` | `POST /orders/{id}/items/{item_id}/refire` | SUPERVISOR |
| 97 Nhật ký hệ thống | `/admin/audit-logs` | `GET /audit-logs` | SUPERVISOR |
| 93 Quản trị nhân viên | `/admin/staff` | `GET/POST /staff`, `PATCH /staff/{id}`, `POST /staff/{id}/lock`, `/unlock`, `/reset-password` | SUPERVISOR |
| 94 Vai trò & quyền (chỉ đọc) | `/admin/roles` | `GET /staff/permissions` | SUPERVISOR |
| 16, 17 Chuyển bàn, gộp bàn | `/tables/:id` | `POST /tables/{id}/transfer`, `POST /tables/{id}/merge` | WAITER, SUPERVISOR (`TABLE_TRANSFER`) |
| 18 Tách bill | `/tables/:id/summary` | `POST /orders/{id}/split` | WAITER, SUPERVISOR |
| 10 Size/topping khi gọi món | `/tables/:id/order`, `/tables/:id/search` | `GET /menu/{id}/modifiers`, `modifier_option_ids` trong `POST /orders/{id}/items` | Theo quyền gọi món |
| 03 Sơ đồ bàn theo khu vực | `/tables` | `GET /areas`, `area_id` trong `GET /tables` | Mọi vai trò |
| 22, 80, 81 Khách hàng và ưu đãi | `/tables/:id/summary` | `GET/POST /customers`, `POST /orders/{id}/customer`, `GET /orders/{id}/eligible-rewards`, `POST/DELETE /orders/{id}/rewards` | CUSTOMER_ACCESS, REWARD_APPLY, OVERRIDE |
| 40–48, 107 QR gọi món | `/qr/:token` (khách), `/tables/:id` (mã QR, xác nhận món) | `/tables/{id}/qr-session`, `/public/qr/{token}*` | QR_SESSION_MANAGE |
| 20 Thanh toán nhiều lần, hoàn tiền | `/tables/:id/summary` | `GET/POST /orders/{id}/payments`, `POST /payments/{id}/cancel`, `/refunds` | PROCESS_PAYMENT, PAYMENT_REFUND |
| 97 Báo cáo nhật ký + tải Excel | `/admin/audit-logs` | `GET /audit-logs/summary`, `GET /audit-logs/export` | SUPERVISOR |
| 98 Hồ sơ của tôi + đổi mật khẩu | `/profile` (bấm chip tên ở góc trên phải) | `GET /auth/me`, `POST /auth/change-password` | Mọi vai trò |

Màn 35 (Chi tiết món, KDS) thuộc Pha 1 và đã làm: `/kitchen/orders/:orderId/items/:itemId`, dùng `GET /orders/{id}`, `GET /kitchen/queue`, `start-cooking`, `mark-ready`, `void`, `refire` (xem `README.md`).

Chưa làm dù đã có API:

| Màn / tính năng | API đã có | Ghi chú cho FE |
|---|---|---|
| Xem phiên bản đơn | `GET /orders/{id}/versions` (SUPERVISOR) | Chưa có thiết kế |

Lưu ý cho màn 93, 94, 98 (đã làm): đổi mật khẩu, khóa tài khoản, đặt lại mật khẩu hoặc đổi vai trò làm token cũ của người bị tác động trả `401`; `src/api/client.ts` tự gọi `redirectToLogin()` khi gặp `401`. Riêng đổi mật khẩu của chính mình, backend trả token mới và FE lưu lại bằng `saveAuth` nên không bị đăng xuất. Backend chặn quản lý tự đổi vai trò, tự khóa/mở khóa hoặc tự đặt lại mật khẩu (409); FE ẩn các nút này ở dòng của chính mình. Màn 94 đã sửa được quyền (tick từng ô, “Đã sửa”, khôi phục mặc định) và mọi nút/route đã chuyển sang đọc `permissions` từ `GET /auth/me`. Backend chưa có API tạo vai trò mới; role “System Admin” riêng chưa có. Lưu ý: `schema.d.ts` trên main chưa có `PUT /staff/permissions/{permission}`, `POST /staff/permissions/reset` và các trường `default_roles`, `locked_roles`, `customized`, nên FE tạm khai báo type tay.

Nguồn đối chiếu: danh sách endpoint trong `src/api/schema.d.ts` (sinh từ `docs/api/openapi.json`) và `docs/api/api-catalog.md`. Số màn là số màn trong Figma (110 màn, chốt ngày 30/10/2026).

## Endpoint backend đang có (Pha 1)

`/auth/login`, `/auth/me`, `/auth/change-password`, `/staff`, `/staff/{id}`, `/staff/{id}/lock|unlock|reset-password`, `/staff/permissions`, `/tables`, `/tables/{id}`, `/tables/{id}/open-session`, `/tables/{id}/mark-clean`, `/menu`, `/menu/{id}`, `/menu/categories`, `/menu/categories/{id}`, `/orders`, `/orders/{id}`, `/orders/{id}/items`, `/orders/{id}/items/{item_id}`, `/orders/{id}/send-to-kitchen`, `/orders/{id}/request-billing`, `/orders/{id}/pay`, `/orders/{id}/close`, `/orders/{id}/items/{item_id}/void|refire|start-cooking|mark-ready|pickup|served`, `/kitchen/queue`, `/kitchen/stations`, `/audit-logs`, `/orders/{id}/versions`, và WebSocket `/ws`.

Đã có API nhưng chưa có màn: `versions` (xem mục “Đã làm” cho `void`, `refire`, `close`, `audit-logs`, `GET /orders`, `/staff*`, `/auth/me`, `/auth/change-password`).

Các nhóm `areas`, `modifiers`, `rewards`, `qr-session`, `public/qr`, chuyển/gộp bàn, tách đơn và thanh toán v2 đã có API và FE đã làm (xem bảng “Đã làm”). Chưa có API: hóa đơn VAT, VNPay/thanh toán QR, hoàn điểm khi hoàn tiền, mã hội viên trên QR, quản lý khu vực/tùy chọn món/ưu đãi ở màn quản trị.

## Bảng thiếu API

| Màn | Tính năng | API cần có | Hiện trạng backend | Ghi chú cho FE |
|---|---|---|---|---|
| 21, 50 | Thanh toán QR | Tạo phiên thanh toán, mã QR/token, trạng thái nhà cung cấp, hạn dùng, làm mới, hủy, webhook | Chưa có | Màn 50 là phía khách quét QR; màn 21 là phía POS |
| 23 | Hóa đơn VAT / hóa đơn điện tử | Xuất hóa đơn, thông tin người mua, tra cứu trạng thái | Chưa có | Giá trong thiết kế đã gồm VAT 8%, cần kế toán xác nhận |
| 25 | Lịch sử đơn: phương thức thanh toán, nhân viên, hoàn tiền, xuất ca | Thêm vào `GET /orders` (hoặc API ca/hoàn tiền) | `GET /orders` dạng danh sách có bộ lọc đã có từ 12/10 và FE đã dùng cho màn 25; chỉ thiếu các trường này (hiện trả mã, bàn, giờ, số món, tiền, trạng thái) | Cột Thanh toán/Nhân viên, chip Hoàn tiền và “Xuất ca” chờ backend |
| 93 | Nhân viên: ảnh đại diện, số điện thoại, email, ca làm việc, lần đăng nhập gần nhất, xóa nhân viên | Thêm trường vào `StaffDetailOut`; API ca làm việc; API xóa | Chưa có | FE chỉ hiện họ tên, tên đăng nhập, vai trò, trạng thái, ngày tạo; khóa tài khoản thay cho xóa |
| 94 | Tạo vai trò mới, sửa quyền từng vai trò | `POST/PATCH` vai trò và quyền | Chưa có (`GET /staff/permissions` chỉ đọc, 4 vai trò cố định) | Màn 94 chỉ hiển thị ma trận quyền |
| 98 | Hồ sơ: sửa họ tên, ảnh đại diện, liên hệ, phiên đăng nhập, xác thực 2 bước | API tự sửa hồ sơ (`PATCH /auth/me`), danh sách phiên, 2FA | Chưa có | FE chỉ có xem thông tin và đổi mật khẩu |
| 41–54 | Khách quét QR tại bàn | API dành cho khách (thực đơn, giỏ hàng, đặt món, thanh toán QR) | Chưa có API dành cho khách; API hiện tại dùng token nhân viên | Cần backend chốt cách xác thực khách |

## Màn 79, 80, 81 (CRM)

| Màn | Tên trong Figma | Nội dung |
|---|---|---|
| 79 | Quy tắc điểm thưởng | Quy tắc tích điểm và đổi điểm |
| 80 | Tra cứu hội viên | Tìm hội viên, xem điểm và lịch sử |
| 81 | Kiểm tra khuyến mãi | Kiểm tra khuyến mãi áp dụng cho một đơn |

Đã kiểm tra trong Figma ngày 30/10: tên màn và nội dung khớp nhau, không có lệch cần sửa trong thiết kế. Ba màn thuộc Pha 2 (CRM). Backend chưa có API hội viên, điểm thưởng hay khuyến mãi, nên FE **không code** các màn này ở Pha 1.

## Điều kiện để bắt đầu một màn Pha 2

1. Endpoint đã có trong `docs/api/openapi.json` (không dùng endpoint “đề xuất” ở bảng trên khi chưa được backend xác nhận).
2. Chạy `npm run gen:api`, dùng kiểu sinh ra thay vì tự khai báo.
3. Mọi `POST`, `PATCH`, `DELETE` dùng `createIdempotencyKey()` và có trạng thái bận, chống bấm đúp, xử lý offline như các màn Pha 1 (xem `README.md`).
4. Xác định role được phép trước khi vẽ nút; nếu backend chưa có quy tắc role thì hỏi, không đoán.
