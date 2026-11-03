# Mức sẵn sàng cho Pha 2

Tài liệu này chỉ liệt kê những gì Pha 2 cần và backend đã có hay chưa. **Không có code Pha 2 trong repo**: không route, không màn, không hàm gọi API cho các mục dưới đây. Khi backend có endpoint thật, chạy `npm run gen:api` rồi mới làm màn tương ứng.

Nguồn đối chiếu: danh sách endpoint trong `src/api/schema.d.ts` (sinh từ `docs/api/openapi.json`) và `docs/api/api-catalog.md`. Số màn là số màn trong Figma (110 màn, chốt ngày 30/10/2026).

## Endpoint backend đang có (Pha 1)

`/auth/login`, `/tables`, `/tables/{id}`, `/tables/{id}/open-session`, `/tables/{id}/mark-clean`, `/menu`, `/menu/{id}`, `/menu/categories`, `/menu/categories/{id}`, `/orders`, `/orders/{id}`, `/orders/{id}/items`, `/orders/{id}/items/{item_id}`, `/orders/{id}/send-to-kitchen`, `/orders/{id}/request-billing`, `/orders/{id}/pay`, `/orders/{id}/close`, `/orders/{id}/items/{item_id}/void|refire|start-cooking|mark-ready|pickup|served`, `/kitchen/queue`, `/kitchen/stations`, `/audit-logs`, `/orders/{id}/versions`, và WebSocket `/ws`.

Đã có API nhưng chưa có màn Pha 1 nối vào: `void`, `refire`, `close`, `audit-logs`, `versions`. Đây không phải việc của Pha 2 trong danh sách dưới; nhóm cần quyết định khi nào làm.

## Bảng thiếu API

| Màn | Tính năng | API cần có | Hiện trạng backend | Ghi chú cho FE |
|---|---|---|---|---|
| 16 | Chuyển bàn | Chuyển phiên và đơn từ bàn này sang bàn khác (đề xuất `POST /tables/{id}/transfer`) | Chưa có | Quy tắc nghiệp vụ (bàn đích, đơn đã gửi bếp) cần backend chốt trước |
| 17 | Gộp bàn / gộp đơn | Gộp nhiều bàn hoặc đơn (đề xuất `POST /tables/merge`) | Chưa có | Trạng thái “Đã gộp” đã có trong bộ lọc bàn nhưng chưa có luồng tạo ra nó |
| 18 | Tách đơn | Tách món sang đơn mới (đề xuất `POST /orders/{id}/split`) | Chưa có | Quy tắc tách món đã gửi bếp cần backend chốt trước |
| 20 | Thanh toán nhiều phương thức | `pay` nhận phương thức, số tiền từng phần, tiền khách đưa, tiền thối | `/orders/{id}/pay` hiện không nhận phương thức, số tiền, tiền mặt hay tiền thối | FE hiện chỉ có nút “Xác nhận đã thanh toán” |
| 21, 50 | Thanh toán QR | Tạo phiên thanh toán, mã QR/token, trạng thái nhà cung cấp, hạn dùng, làm mới, hủy, webhook | Chưa có | Màn 50 là phía khách quét QR; màn 21 là phía POS |
| 22 | Ưu đãi và điểm thưởng | Tra cứu hội viên, áp dụng/gỡ ưu đãi, trừ/cộng điểm | Chưa có | Phải có khách hàng và quy tắc điểm trước |
| 23 | Hóa đơn VAT / hóa đơn điện tử | Xuất hóa đơn, thông tin người mua, tra cứu trạng thái | Chưa có | Giá trong thiết kế đã gồm VAT 8%, cần kế toán xác nhận |
| 25 | Lịch sử đơn | Danh sách đơn đã đóng có lọc và phân trang | Chưa có `GET /orders` dạng danh sách có lọc | `GET /orders/{id}` chỉ lấy từng đơn |
| 41–54 | Khách quét QR tại bàn | API dành cho khách (thực đơn, giỏ hàng, đặt món, thanh toán QR) | Chưa có API dành cho khách; API hiện tại dùng token nhân viên | Cần backend chốt cách xác thực khách |
| 93 | Quản trị nhân viên | Danh sách, tạo, sửa, khóa/mở khóa, đặt lại mật khẩu | Chưa có (chỉ có `/auth/login`) | Chưa có role “System Admin” riêng trong FE |

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
