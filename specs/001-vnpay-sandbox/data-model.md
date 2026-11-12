# Data Model: Thanh toán VNPay (sandbox)

## Bảng `payment` (đã có từ R1, migration `0013` thêm cột)

| Cột | Kiểu | Null | Ý nghĩa |
|---|---|---|---|
| `payment_url` | text | có | Link sang trang VNPay (FE vẽ mã QR); lưu lại để trả đúng link cũ khi thu ngân bấm tạo lần nữa |
| `expires_at` | timestamptz | có | Hạn của link VNPay; tiền mặt/thẻ để trống |
| `provider_txn_no` | varchar(50) | có | `vnp_TransactionNo` VNPay trả về |
| `provider_code` | varchar(10) | có | Mã kết quả gần nhất (`vnp_ResponseCode` / `vnp_TransactionStatus`) |
| `provider_paid_at` | timestamptz | có | `vnp_PayDate` đổi về UTC |
| `vnp_create_date` | varchar(14) | có | `vnp_CreateDate` đã gửi, cần cho QueryDR (`vnp_TransactionDate`) |
| `last_checked_at` | timestamptz | có | Lần hỏi VNPay gần nhất |

- **Mã tham chiếu gửi VNPay:** dùng lại cột `provider_ref` (đã có). Với lần thanh toán VNPay, `provider_ref` = `vnp_TxnRef` = `payment.id` dạng hex.
- **Chỉ mục mới:** `ix_payment_pending_expires` trên `(status, expires_at)`, phục vụ script đối soát.

## Trạng thái của lần thanh toán VNPay

```text
PENDING --QueryDR/IPN: đã trả--------> SUCCEEDED   (đóng đơn nếu đủ tiền)
PENDING --QueryDR/IPN: lỗi, khách hủy-> FAILED
PENDING --quá hạn, VNPay: không có GD-> EXPIRED
PENDING --quá hạn, VNPay không trả lời-> UNKNOWN
UNKNOWN --đối soát lại----------------> SUCCEEDED | FAILED | EXPIRED
PENDING --Supervisor hủy--------------> CANCELLED  (VNPay báo đã trả sau đó: audit PAYMENT_LATE_SUCCESS)
SUCCEEDED --hoàn tiền (R1)------------> REFUNDED   (hoàn tay ngoài VNPay)
```

## Quy tắc dữ liệu

- **Số lần chờ:** mỗi đơn có tối đa 1 lần thanh toán VNPay ở trạng thái `PENDING` cùng lúc. Tạo lần mới khi lần cũ chưa hết hạn thì trả lại link cũ.
- **Cách tính tổng đã thu:** `SUCCEEDED` và `REFUNDED` cộng vào tổng đã thu như R1. `PENDING` **còn hạn link** không cộng nhưng **giữ chỗ** số tiền (`summary.pending`): không tạo link thứ hai, không thu tiền mặt/thẻ hay `/pay` vượt phần còn lại. `PENDING` quá hạn và `UNKNOWN` không giữ chỗ, để thu ngân thu cách khác; VNPay báo đã trả sau đó thì ghi `PAYMENT_LATE_SUCCESS` để hoàn tay.
- **Số tiền:** `amount` được chốt lúc tạo link, không đổi sau đó. Đơn thay đổi thì hủy lần cũ, tạo lần mới.

## Biến môi trường

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `VNPAY_TMN_CODE` | (trống) | Bí mật, chỉ trong `.env.staging` |
| `VNPAY_HASH_SECRET` | (trống) | Bí mật, chỉ trong `.env.staging` |
| `VNPAY_PAY_URL` | `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html` | |
| `VNPAY_API_URL` | `https://sandbox.vnpayment.vn/merchant_webapi/api/transaction` | Đối chiếu lại khi có tài khoản |
| `VNPAY_RETURN_URL` | (trống) | Vd `http://160.191.47.17/api/v1/payments/vnpay/return` |
| `VNPAY_LINK_TTL_MINUTES` | `15` | |
| `VNPAY_IPN_ENABLED` | `false` | Chỉ bật khi có HTTPS |
