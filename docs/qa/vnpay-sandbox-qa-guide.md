# Hướng dẫn QA: thanh toán VNPay trên sandbox

- **Cập nhật:** 17/11/2026
- **Áp dụng cho testcase:** P2-PAY-003, P2-PAY-004, P2-PAY-005, P2-PAY-006. Có ghi chú cho P2-PAY-002 và P2-RWD-009 ở cuối.
- **Spec:** `specs/001-vnpay-sandbox/`. API ở `docs/api/api-catalog.md` mục A17.
- **Không cần khóa VNPay.** Khóa chỉ nằm trên server. QA chỉ dùng tài khoản nhân viên staging, trang `/docs` và trình duyệt.

## 0. Điều cần biết trước khi test

| Điểm | Chi tiết |
|---|---|
| Môi trường | Staging `http://160.191.47.17`, kết nối VNPay **sandbox** (tiền giả). Ghi SHA từ `GET /version` vào mỗi bằng chứng |
| Trả tiền | Trên trang VNPay chọn **Thẻ nội địa → NCB**, nhập thẻ test và OTP trong [tài liệu sandbox VNPay](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html). **Không quét mã VNPAY-QR**: app ngân hàng thật báo "QR không tồn tại" với giao dịch sandbox |
| Hạn link | 15 phút kể từ lúc tạo (`expires_at`) |
| Xác nhận kết quả | Hệ thống hỏi lại VNPay (QueryDR). **Sandbox hiện trả lỗi `99` cho mọi QueryDR**, nên kết quả được lấy từ Return URL đã kiểm chữ ký VNPay. Audit ghi nguồn `return_signed` |
| Hệ quả khi QueryDR lỗi | Nút "Kiểm tra lại" (`POST /payments/{id}/check`) trả **502**. Script đối soát (10 phút một lần) chuyển link quá hạn sang `UNKNOWN` thay vì `EXPIRED`. Cả hai đúng thiết kế, không phải lỗi; ghi là "giới hạn của sandbox" |
| IPN | Tắt trên staging (cần HTTPS). Không test IPN trên staging; IPN đã có test tự động trong `backend/tests/test_vnpay.py` |
| Giao diện | FE **chưa có màn VNPay**. Tạo link qua `/docs`; xem kết quả trên màn Tóm tắt đơn hoặc qua API |

## 1. Chuẩn bị fixture (mỗi ca dùng một đơn riêng)

1. Đăng nhập tài khoản **Cashier** của khu QA, mở một bàn trống của QA. Gọi 1 món, gửi bếp, rồi **yêu cầu thanh toán**. Không bấm "Ghi nhận thanh toán" hay "Xác nhận đã thanh toán".
2. Lấy **mã đơn** như sau:
   - mở `/docs`, gọi `POST /api/v1/auth/login` rồi bấm **Authorize**;
   - gọi `GET /api/v1/tables/{table_id}` (mã bàn nằm trên thanh địa chỉ khi mở bàn);
   - lấy `orders[].id` của đơn đang `BILLING`.
3. Ghi lại trạng thái trước khi test:
   - `GET /api/v1/orders/{order_id}` → `status`, `total`, `amount_paid`, `amount_due`;
   - `GET /api/v1/orders/{order_id}/payments` → danh sách lần thanh toán và `summary`.
4. Mỗi lệnh ghi dùng một `Idempotency-Key` mới, ví dụ `qa-pay003-<giờ phút>`.

**Tạo link VNPay** (dùng cho mọi ca):

```http
POST /api/v1/orders/{order_id}/payments
Idempotency-Key: qa-pay003-1015
{"method": "VNPAY"}
```

**Kết quả đúng:** 201, `payment.status = "PENDING"`, có `payment_url`, có `expires_at`, `summary.pending` bằng số tiền của link. Ghi lại `payment.id`.

## 2. Các ca test

### P2-PAY-003 — Trả thành công

1. Tạo link (mục 1). Mở `payment_url` trong tab mới.
2. Chọn Thẻ nội địa → NCB, nhập thẻ test, OTP.
3. Trình duyệt chuyển về `160.191.47.17/api/v1/payments/vnpay/return?...`. **Giữ tab này lại** để dùng cho ca P2-PAY-005.

**Kết quả đúng:**

| Kiểm tra | Mong đợi |
|---|---|
| Trang quay về | "Thanh toán thành công", "Đã nhận <số tiền>đ"; **không** hiện mã đơn hay thông tin khách |
| `GET /orders/{order_id}/payments` | Lần VNPay `SUCCEEDED`, có `provider_txn_no`, `provider_paid_at`; `summary.remaining = 0`, `summary.pending = 0` |
| `GET /orders/{order_id}` | `status = "PAID"` (nếu link trả hết số tiền) |
| Sơ đồ bàn | Bàn chuyển "chờ dọn" (`CLEANING`) nếu là đơn cuối của bàn |
| Audit (`GET /audit-logs?order_id=...`, Supervisor) | `PAYMENT_LINK_CREATED`, `PAYMENT_CONFIRMED` (payload `source` = `return_signed` hoặc `return`), `ORDER_PAID` |

### P2-PAY-004 — Khách hủy hoặc thanh toán thất bại, đơn vẫn chưa trả

1. Tạo link trên một đơn mới. Mở `payment_url`.
2. Trên trang VNPay bấm **Hủy thanh toán**, hoặc nhập sai OTP tới khi VNPay báo thất bại.
3. Trình duyệt quay về hệ thống.

**Kết quả đúng:**

| Kiểm tra | Mong đợi |
|---|---|
| Trang quay về | "Thanh toán chưa hoàn tất" |
| Lần thanh toán | `FAILED`; `summary.paid` không đổi |
| Đơn | Vẫn `BILLING`, `amount_due` không đổi |
| Thử lại | Tạo link mới (Idempotency-Key mới) được: trả về `payment.id` **khác**. Thu tiền mặt cũng được |

**Biến thể — khách bỏ ngang, không quay về:** tạo link rồi không mở hoặc không trả. Sau 15 phút cộng tối đa 10 phút, script đối soát chạy:
- lần thanh toán chuyển `UNKNOWN` (do QueryDR của sandbox lỗi; nếu QueryDR chạy được thì là `EXPIRED`);
- link quá hạn **không còn giữ chỗ** tiền: thu tiền mặt hoặc tạo link mới được.

**Biến thể — hủy link khi khách đổi ý:** gọi `POST /api/v1/payments/{payment_id}/cancel` bằng tài khoản **Cashier** với `{"reason": "Khách đổi sang tiền mặt"}`.
- **Đúng:** 200, lần đó `CANCELLED`, thu tiền mặt được ngay.
- Trong lúc link còn hạn mà **chưa hủy**: thu tiền mặt toàn bộ hoặc gọi `/pay` phải trả **409** ("Đang chờ khách trả qua VNPay…").

### P2-PAY-005 — Kết quả tới nhiều lần chỉ ghi một lần

Dùng đơn đã PAID ở P2-PAY-003.
1. Ở tab Return URL đã giữ, bấm **tải lại** 2–3 lần.
2. Gọi `POST /api/v1/payments/{payment_id}/check` 2 lần với 2 `Idempotency-Key` khác nhau.

**Kết quả đúng:**
- Trang vẫn "Thanh toán thành công".
- `/check` trả 200 và kết quả `SUCCEEDED` hiện có. Lần đã có kết quả cuối thì không hỏi VNPay nữa, nên không bị 502.
- `GET /orders/{order_id}/payments` chỉ có **1** lần VNPay `SUCCEEDED`; `summary.paid` không tăng.
- Audit `ORDER_PAID` chỉ **1** dòng cho đơn; điểm (nếu đơn có khách) chỉ tích **1** lần.
- Có thể kiểm thêm: gọi lại API tạo link với **cùng** `Idempotency-Key` của lần đầu → nhận đúng response cũ, không tạo lần thanh toán mới.

### P2-PAY-006 — Chữ ký sai không làm đổi gì

Dùng một đơn **mới**, tạo link và trả thành công tới bước trình duyệt quay về. Sau đó sao chép Return URL và thử từng biến thể trong một tab mới:

| Biến thể | Cách sửa | Mong đợi |
|---|---|---|
| Sửa số tiền | Đổi giá trị `vnp_Amount` (vd bớt một số 0) | Trang "Liên kết không hợp lệ" (HTTP 400) |
| Sửa chữ ký | Đổi 1 ký tự trong `vnp_SecureHash` | "Liên kết không hợp lệ" |
| Mất tham số | Chỉ mở `.../vnpay/return` không có `?...` | "Liên kết không hợp lệ" |
| Đổi mã tham chiếu | Đổi 1 ký tự trong `vnp_TxnRef` | "Liên kết không hợp lệ" |

Sau mỗi biến thể, đơn và lần thanh toán **không đổi** so với trước khi mở link giả. Audit không có dòng `PAYMENT_CONFIRMED` mới.

> Không đưa Return URL thật vào báo cáo công khai. Chụp màn hình thì che phần `vnp_SecureHash`.

## 3. Ghi bằng chứng

Mỗi ca ghi tối thiểu:
1. SHA staging (`GET /version`) và thời điểm chạy.
2. `order_id`, `payment_id`, trạng thái **trước và sau** (đơn, lần thanh toán, `summary`).
3. Ảnh chụp trang quay về và trang VNPay (che chữ ký, che token).
4. Các dòng audit liên quan (`GET /audit-logs?order_id=...`).
5. Nếu gặp lỗi: `X-Request-ID` trong header phản hồi hoặc `request_id` trên trang lỗi 500, để BE tra log.

**Không ghi vào bằng chứng:** token đăng nhập, `vnp_HashSecret` (QA không có), số thẻ test đầy đủ.

## 4. Ngoài phạm vi trên staging hiện tại

| Testcase | Lý do | Cách xử lý đề xuất |
|---|---|---|
| P2-PAY-002 (CARD qua cổng) | Hệ thống không nối cổng thẻ; thẻ là **thu ngân xác nhận máy POS đã quẹt** (`method: "CARD"`) | PO xác nhận phạm vi; test như tiền mặt (không có callback) |
| P2-RWD-009 (hoàn điểm khi thanh toán lỗi) | Thanh toán thất bại thì **chưa tích điểm** nên không có gì để hoàn. Hoàn điểm chỉ xảy ra khi **hoàn tiền hết** đơn (Rewards đợt 3, mục A18) | Chạy theo luồng hoàn tiền: thanh toán thành công → Supervisor hoàn tiền hết → kiểm dòng `REVERSAL` |
| IPN trùng hoặc sai chữ ký | IPN tắt trên staging (cần HTTPS) | Đã có test tự động; chạy lại khi có HTTPS |
| "Kiểm tra lại" và đối soát xác nhận thành công | QueryDR của sandbox đang trả `99` | Chờ VNPay trả lời. Hiện kiểm được hành vi 502 và `UNKNOWN` |
