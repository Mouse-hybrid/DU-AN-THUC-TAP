# Data Model: Rewards đợt 3

## Bảng `points_ledger` (đã có)

| Thay đổi | Chi tiết |
|---|---|
| CHECK `entry_type` | Thêm `EXPIRE`: `('EARN', 'REDEEM', 'REVERSAL', 'ADJUST', 'EXPIRE')` |
| Dòng `REVERSAL` | `order_id` = đơn được hoàn; `points` = +đã đổi − đã tích (có thể âm); `reason` ghi `"Hoàn tiền: trả N điểm đổi, thu M điểm tích"` |
| Dòng `EXPIRE` | `order_id` = null; `points` âm; `reason` ghi `"Hết hạn điểm tích đến <ngày>"` |

Ràng buộc sẵn có `uq_points_ledger_order_type (order_id, entry_type)` giữ cho mỗi đơn chỉ đảo một lần. Dòng `EXPIRE` có `order_id` null nên không vướng ràng buộc này.

## Bảng `table_session` (đã có, thêm cột)

| Cột | Kiểu | Null | Ý nghĩa |
|---|---|---|---|
| `pending_member_phone` | varchar(15) | có | Số khách nhập trên QR, chờ thu ngân đăng ký hoặc gắn |
| `qr_member_attempts` | integer | không, mặc định 0 | Số lần khách đã gửi số trong phiên |

- Hai cột được xóa giá trị khi phiên đóng. Khi thu ngân gắn khách thì chỉ xóa số chờ.
- Script reset staging không cần sửa, vì phiên bàn bị xóa cả dòng.

## Bảng `order_reward` (đã có)

Dùng trạng thái `REVERSED` có sẵn. Khi đảo, `reward.used_count` giảm 1, không xuống dưới 0.

## Cấu hình

| Biến | Mặc định |
|---|---|
| `QR_MEMBER_MAX_ATTEMPTS` | `5` |
