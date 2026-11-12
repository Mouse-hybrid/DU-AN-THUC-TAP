# Contract: API thanh toán VNPay

Hợp đồng cho FE và QA. Sau khi code, `docs/api/openapi.json` là nguồn chính thức; file này là bản thiết kế trước khi code.

## 1. Tạo link — `POST /api/v1/orders/{order_id}/payments` (mở rộng API R1)

- Quyền `PROCESS_PAYMENT`. Bắt buộc header `Idempotency-Key`.

```json
{ "method": "VNPAY", "amount": 200000 }
```

`amount` bỏ trống = số còn phải thu.

**201** — trả như R1, `payment` có thêm các trường VNPay:

```json
{
  "payment": {
    "id": "…",
    "method": "VNPAY",
    "amount": "200000.00",
    "status": "PENDING",
    "payment_url": "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_Amount=…",
    "expires_at": "2026-11-17T03:15:00Z"
  },
  "order_status": "BILLING",
  "summary": { "total": "200000.00", "paid": "0.00", "refunded": "0.00", "remaining": "200000.00" }
}
```

| Mã lỗi | Khi nào |
|---|---|
| 409 | Đơn không ở BILLING; vượt số còn được thu |
| 422 | Gửi kèm `cash_received` |
| 503 | `"VNPay chưa được cấu hình"` (thiếu khóa) |

Đơn đã có một lần VNPay đang chờ, chưa hết hạn → trả lại lần đó (201), không tạo mới.

## 2. Kiểm tra lại — `POST /api/v1/payments/{payment_id}/check`

- Quyền `PROCESS_PAYMENT`. Bắt buộc header `Idempotency-Key`.
- Chỉ dùng cho lần thanh toán VNPay ở trạng thái `PENDING` hoặc `UNKNOWN`. Lần đã có kết quả cuối thì trả lại kết quả đó.

**200** — kết quả cùng dạng với API tạo link:

```json
{ "payment": { "status": "SUCCEEDED" }, "order_status": "PAID", "summary": { } }
```

| Mã | Khi nào |
|---|---|
| 200 | Có kết quả, kể cả khi trạng thái vẫn `PENDING` (khách chưa trả) |
| 404 | Không tìm thấy, hoặc lần thanh toán thuộc outlet khác |
| 409 | Không phải lần thanh toán VNPay |
| 502 | VNPay không trả lời trong 10 giây; trạng thái giữ nguyên |

## 3. Trình duyệt quay về — `GET /api/v1/payments/vnpay/return?vnp_…`

- Công khai, không cần đăng nhập.
- Kiểm chữ ký, gọi QueryDR, xác nhận kết quả.
- Trả **trang HTML**: "Thanh toán thành công", "Thanh toán chưa hoàn tất" hoặc "Liên kết không hợp lệ", kèm số tiền.
- Không hiện mã đơn hay thông tin khách.

## 4. IPN — `GET /api/v1/payments/vnpay/ipn?vnp_…`

- Công khai. Trả JSON theo VNPay: `{"RspCode": "00", "Message": "Confirm Success"}`.
- Bảng mã trả về: xem `research.md` R-4.
- `VNPAY_IPN_ENABLED=false` thì luôn trả `99`.

## Event WebSocket

| Thời điểm | Event |
|---|---|
| Tạo link | `ORDER_UPDATED` với `reason: "PAYMENT_PENDING"` |
| Kết quả thành công | `ORDER_UPDATED` với `reason: "PAYMENT_RECORDED"`; đủ tiền thì `ORDER_PAID` |
| Kết quả thất bại | `ORDER_UPDATED` với `reason: "PAYMENT_FAILED"` |

## Audit

| Action | Ngoại lệ | Khi nào |
|---|---|---|
| `PAYMENT_LINK_CREATED` | Không | Tạo link |
| `PAYMENT_CONFIRMED` | Không | Có kết quả; payload ghi nguồn: `return`, `check`, `ipn` hoặc `reconcile` |
| `PAYMENT_AMOUNT_MISMATCH` | Có | Số tiền VNPay báo khác số của lần thanh toán |
| `PAYMENT_LATE_SUCCESS` | Có | VNPay báo đã trả sau khi lần đó đã hủy hoặc đơn đã đóng |
