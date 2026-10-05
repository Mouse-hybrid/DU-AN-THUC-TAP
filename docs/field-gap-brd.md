# Field gap: BRD vs schema hiện tại (BE-S1-11 — chỉ phân tích)

> Trạng thái: **bản nháp để BA/PM xác nhận**. Chưa tạo migration. Phần "schema hiện có" lấy từ
> `app/db/models.py` (xem `docs/erd.md`). Phần "BRD cần" mình **chưa đối chiếu được với văn bản
> BRD gốc trong lần soạn này** (chỉ có Permission Matrix trong Project) nên các dòng đánh dấu
> "?" cần bạn/BA điền hoặc xác nhận trước khi coi là gap thật.

## Cách đọc

| Ký hiệu | Ý nghĩa |
|---|---|
| Có | Đã có cột/bảng trong schema |
| Thiếu (suy ra) | Không có trong schema, nhưng luồng nghiệp vụ POS thông thường cần — cần BA xác nhận có thuộc Release 1 không |
| ? | Chưa đối chiếu BRD |

## Bảng gap (từ phía schema)

| Khu vực | Hiện có | Ứng viên gap | Trạng thái |
|---|---|---|---|
| Menu | `menu_item(name, price, is_available, station_id)` | Danh mục món (category), mô tả, ảnh, modifier/topping | Thiếu (suy ra) |
| Thanh toán | Chỉ trạng thái order/table (BILLING → PAID → CLOSED) | Bảng payment: phương thức (tiền mặt/thẻ/QR), số tiền, tiền thối, mã giao dịch | Thiếu (suy ra) |
| Order | `order`, `order_item(quantity, unit_price, note)`, `order_version` | Giảm giá/khuyến mãi, thuế/phí dịch vụ, tổng tiền lưu sẵn | Thiếu (suy ra) |
| Void/Refire | Audit log `ORDER_ITEM_VOIDED/REFIRED` | Lý do void/refire dạng cột riêng (hiện nằm trong payload audit?) | ? |
| Bàn | `restaurant_table(code, seats, status, merged_into_table_id)` | Khu vực/tầng, đặt bàn (RESERVED có trạng thái nhưng chưa có bảng reservation) | ? |
| Phiên bàn | `table_session(guest_count, opened_by, opened_at, closed_at, qr_session_token)` | Tách/gộp bill, tên khách | ? |
| Bếp | `kitchen_station`, `kitchen_queue(queued_at, started_at, done_at)` | Độ ưu tiên/ETA, ghi chú theo trạm | ? |
| Nhân sự | `staff(role, is_active)` | Ca làm việc, PIN đăng nhập nhanh | ? |
| Outlet | `outlet(name, address)` | Giờ mở cửa, thuế suất, tiền tệ | ? |

## Việc tiếp theo

1. BA/PM đánh dấu từng dòng "Thiếu (suy ra)" / "?" là *cần ở R1* hay *để sau*.
2. Với dòng cần ở R1: tạo task migration riêng (Alembic), cập nhật model + `docs/erd.md`
   (`python scripts/generate_erd.py`).
3. Không đổi schema trước khi có xác nhận (tránh migration phải revert).
