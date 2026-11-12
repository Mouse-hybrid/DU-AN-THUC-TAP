# Research: Rewards đợt 3

## R-1. Hoàn điểm khi hoàn một phần hay chỉ khi hoàn hết

- **Decision**: chỉ khi hoàn hết đơn. Ghi một dòng `REVERSAL` gộp cả điểm đã đổi và điểm đã tích.
- **Rationale**:
  - Hoàn một phần thường là bù cho món lỗi; khách vẫn dùng bữa, giữ điểm là hợp lý.
  - Bảng `points_ledger` có ràng buộc unique `(order_id, entry_type)`, nên mỗi đơn chỉ có một dòng `REVERSAL`. Ràng buộc này tự chặn việc đảo hai lần.
- **Alternatives considered**:
  - Thu lại điểm theo tỉ lệ mỗi lần hoàn: phải bỏ ràng buộc unique, dễ lệch do làm tròn, và cần PO chốt cách làm tròn. Để lại thành câu hỏi FR-004.
  - Hai dòng riêng (trả điểm đổi, thu điểm tích): vướng ràng buộc unique, mà người đọc sổ cũng không cần tách.

## R-2. Khách đã tiêu điểm vừa tích, số dư không đủ thu lại

- **Decision**: thu tối đa bằng số dư hiện có (số dư không âm). Phần thiếu ghi audit `POINTS_REVERSAL_SHORTFALL` để Supervisor quyết định.
- **Rationale**: số dư âm làm hỏng mọi phép kiểm "đủ điểm để đổi" và gây khó hiểu khi hiện cho khách.
- **Alternatives considered**:
  - Cho số dư âm: đơn giản hơn nhưng rủi ro ở các luồng khác.
  - Chặn hoàn tiền: sai thứ tự ưu tiên, vì tiền của khách quan trọng hơn điểm.

## R-3. Cách tính hết hạn theo FIFO

**Ví dụ:**

| Ngày | Dòng | Điểm | Hạn |
|---|---|---|---|
| 01/01 | EARN | +50 | 01/01 năm sau |
| 01/03 | EARN | +30 | 01/03 năm sau |
| 01/04 | REDEEM | −40 | — |

Đến ngày 02/01 năm sau, lô 50 điểm đã quá hạn:
- 40 điểm đổi hôm 01/04 được trừ vào lô cũ nhất trước, tức lô 50.
- Lô 50 còn 10 điểm chưa dùng nên 10 điểm này hết hạn: ghi `EXPIRE` −10.
- Số dư từ 40 còn 30, đúng bằng lô 30 điểm còn hạn.

**Cách tính đã chọn khi code: duyệt lại sổ điểm theo thời gian** (`expiring_points` trong `app/core/loyalty.py`), không lưu thêm gì:

- Mỗi dòng cộng điểm tạo một **lô**: EARN có hạn; ADJUST dương và phần điểm đổi được trả lại khi hoàn tiền không có hạn.
- Mỗi dòng trừ (REDEEM, ADJUST âm) lấy dần từ **lô cũ nhất**.
- Dòng REVERSAL thu điểm tích từ đúng lô EARN của đơn đó trước.
- Dòng EXPIRE lấy từ các lô đã hết hạn.
- **Kết quả:** điểm hết hạn = tổng phần còn lại của các lô đã quá hạn, không vượt số dư.
- **Thứ tự khi trùng thời điểm:** REDEEM trước EARN (cùng một lần thanh toán).

Bản nháp ban đầu dùng công thức gộp:

```text
max(0, Σ EARN quá hạn − Σ đã dùng − Σ EXPIRE)
```

Công thức này **sai** khi khách có điểm cộng tay cũ hơn. Ví dụ:
1. Cộng tay 100 điểm (không hạn).
2. Đổi 50 điểm.
3. Tích 50 điểm (có hạn), rồi lô này quá hạn.

FIFO đúng là 50 điểm đổi ở bước 2 lấy từ lô cộng tay, nên lô tích 50 điểm hết hạn nguyên. Công thức gộp lại trừ 50 điểm đổi vào lô tích, cho ra 0 điểm hết hạn. Test `test_manual_adjust_is_consumed_first_when_older` giữ trường hợp này.

**Alternatives considered:**
- Lưu từng lô và đánh dấu tiêu thụ: chính xác tuyệt đối nhưng cần bảng mới, và phải sửa mọi luồng đổi điểm.
- Hết hạn theo số dư toàn phần (cứ quá N ngày không giao dịch là xóa hết): sai luật đã công bố.

## R-4. Số điện thoại trên QR và đồng ý của khách

- **Decision**:
  - Không tự tạo khách mới từ QR. Số chưa là thành viên được giữ lại trên phiên bàn cho thu ngân.
  - Phản hồi giống nhau cho mọi trường hợp.
  - Giới hạn 5 lần gửi mỗi phiên.
- **Rationale**:
  - Giữ quyết định đợt 1: thu ngân xác nhận đồng ý trước khi tạo khách.
  - Không để người ngoài dùng mã QR dò xem số nào là thành viên.
- **Alternatives considered**:
  - Cho khách tự đăng ký kèm ô đồng ý trên QR: nhanh hơn, nhưng trái quyết định đã chốt. Nếu PO đổi ý thì chỉ cần thêm nhánh tạo khách.
  - Gửi OTP xác minh số điện thoại: cần nhà cung cấp SMS, ngoài phạm vi Pha 2.

## R-5. Lịch chạy job hết hạn

- **Decision**: workflow `expire-points.yml`, `cron: "0 20 * * *"` (03:00 giờ Việt Nam), chạy trên runner `[self-hosted, staging]`, cùng nhóm concurrency `staging` với deploy, backup, reset.
- **Rationale**: dùng lại hạ tầng sẵn có (constitution VIII). Giờ thấp điểm nên không tranh khóa với thu ngân.
