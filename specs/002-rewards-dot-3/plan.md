# Implementation Plan: Rewards đợt 3

- **Branch**: `feat/rewards-dot-3`
- **Date**: 2026-11-12
- **Spec**: [spec.md](spec.md)

## Summary

Ba phần độc lập, cùng dựa trên sổ điểm (`points_ledger`) và các hàm sẵn có trong `app/core/loyalty.py`:

1. **Hoàn điểm:** gọi từ API hoàn tiền R1 khi đơn được hoàn hết.
2. **Hết hạn điểm:** một script tính theo FIFO, chạy hằng ngày.
3. **Số điện thoại trên QR:** một API công khai mới. API này gắn khách đã là thành viên vào đơn; với số chưa là thành viên thì giữ số lại cho thu ngân.

## Technical Context

| Mục | Giá trị |
|---|---|
| Language/Version | Python 3.11 |
| Primary Dependencies | FastAPI, SQLAlchemy 2 (không thêm thư viện) |
| Storage | PostgreSQL 16. Migration `0012`: thêm `EXPIRE` vào CHECK của `points_ledger`, thêm 2 cột vào `table_session` |
| Testing | pytest; test Postgres cho hoàn điểm đồng thời với đổi điểm ở đơn khác |
| Target Platform | Docker Compose trên staging |
| Performance Goals | Job hết hạn: 10.000 khách < 1 phút; API QR < 200 ms |
| Constraints | Sổ điểm chỉ ghi thêm; số dư không âm; QR không lộ dữ liệu cá nhân |
| Scale/Scope | 2 endpoint mới, 1 trường mới trong chi tiết đơn, 1 script, 1 workflow, 1 migration |

## Constitution Check

| Nguyên tắc | Đáp ứng |
|---|---|
| I. BRD, PO chốt | Hoàn một phần ghi `[NEEDS CLARIFICATION]`; giữ quyết định "thu ngân xác nhận đồng ý" |
| II. An toàn khi gửi lại | Hoàn điểm chạy trong transaction hoàn tiền (đã có Idempotency-Key), khóa khách bằng `lock_customer` sau khóa đơn và thanh toán. API QR cần Idempotency-Key như các API ghi QR khác. Job hết hạn chạy lại không trừ thêm |
| III. Phân quyền | API QR nằm dưới `/public/`, chỉ nhận mã phiên. API xem số chờ dùng quyền `CUSTOMER_ACCESS` |
| IV. Dấu vết | Sổ điểm chỉ ghi thêm (`REVERSAL`, `EXPIRE`). Audit `POINTS_REVERSED`, `POINTS_REVERSAL_SHORTFALL` (ngoại lệ), `POINTS_EXPIRED`, `QR_MEMBER_LINKED`, `QR_MEMBER_PENDING` |
| V. Test, CI | Test cho đủ ba phần, kèm cách ly outlet và gửi lại |
| VI. Migration | `0012` sửa CHECK và thêm cột cho phép null, có downgrade |
| VII. Bí mật, dữ liệu cá nhân | QR chỉ trả số đã che. Log không ghi số điện thoại (bộ lọc của R3 đã che) |
| VIII. Đơn giản | Job dùng script + workflow như backup; không thêm scheduler |

Không có vi phạm.

## Project Structure

```text
backend/
  app/
    core/loyalty.py           # + reverse_order_points, expire_points_for_customer
    api/v1/payments.py        # refund_payment: gọi reverse_order_points khi hoàn hết
    api/v1/qr.py              # + POST /public/qr/{token}/member
    api/v1/orders.py          # + GET /orders/{id}/pending-member
    core/config.py            # + QR_MEMBER_MAX_ATTEMPTS
    db/models.py              # + EXPIRE, cột table_session
  migrations/versions/0012_rewards_dot3.py
  scripts/expire_points.py
  tests/test_rewards_dot3.py
  tests/test_concurrency_postgres.py   # + hoàn điểm song song với đổi điểm
.github/workflows/expire-points.yml
```

## Thiết kế chính

### Hoàn điểm

Trong `refund_payment`, sau khi ghi `PaymentRefund`:
1. Nếu tổng `refunded_amount` của mọi lần thanh toán đã thu bằng tổng đã thu, gọi `reverse_order_points(session, order, staff_id)`.
2. Hàm này lấy dòng `REDEEM` và `EARN` của đơn, rồi tính:
   - `+redeemed` (số điểm đã đổi, cộng trả lại);
   - `-earned` (số điểm đã tích, thu về);
   - net = tổng hai phần.
3. Khóa khách, rồi chặn để số dư không âm: `net >= -balance`. Phần thiếu thì ghi audit ngoại lệ.
4. Ghi **một** dòng `REVERSAL`. Ràng buộc unique `(order_id, entry_type)` sẵn có bảo đảm mỗi đơn chỉ đảo một lần.
5. Chuyển `order_reward` sang `REVERSED` và giảm `reward.used_count` đi 1.

### Hết hạn điểm (FIFO)

- **Cách tính:** duyệt lại sổ điểm của khách theo thời gian, xếp thành các lô, điểm dùng lấy từ lô cũ nhất. Phần còn lại của các lô đã quá hạn (không vượt số dư) được ghi `EXPIRE`. Chi tiết, và vì sao không dùng công thức gộp, ở [research.md](research.md) R-3.
- **Chạy:** `scripts/expire_points.py` chạy theo từng outlet, khóa từng khách, commit theo lô 500 khách.

### Số điện thoại trên QR

- **API:** `POST /api/v1/public/qr/{token}/member` với body `{"phone": "..."}`. Luồng xử lý:
  1. Kiểm phiên còn hiệu lực.
  2. Tăng `qr_member_attempts`. Quá giới hạn thì trả 429.
  3. Chuẩn hóa số bằng `normalize_phone`.
- **Số là thành viên đang hoạt động:** gắn vào các đơn `NEW`/`SENT`/`SERVED`/`BILLING` chưa có khách của phiên.
- **Trường hợp khác:** ghi `pending_member_phone` lên phiên bàn.
- **Phản hồi:** luôn là `{"status": "RECEIVED", "phone_masked": "090****567"}`.
- **Phía thu ngân:** `GET /api/v1/orders/{id}/pending-member` (quyền `CUSTOMER_ACCESS`) trả số đầy đủ. Khi thu ngân gắn khách qua API hiện có thì số chờ được xóa.

## Complexity Tracking

Không có.
