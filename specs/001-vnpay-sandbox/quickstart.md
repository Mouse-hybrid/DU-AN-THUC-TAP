# Quickstart: thử VNPay sandbox

## Chuẩn bị (người phụ trách, một lần)

1. Đăng ký merchant sandbox của VNPay. Nhận `vnp_TmnCode` và `vnp_HashSecret` qua email.
2. Trên server staging, mở `~/secrets/pos-staging/.env.staging` và thêm:

   ```text
   VNPAY_TMN_CODE=...
   VNPAY_HASH_SECRET=...
   VNPAY_RETURN_URL=http://160.191.47.17/api/v1/payments/vnpay/return
   ```

   Không dán hai giá trị đầu vào chat, repo hay ảnh chụp.
3. Chạy lại workflow deploy staging.

## Thử một lần thanh toán

1. Đăng nhập thu ngân, mở một đơn đã yêu cầu thanh toán, chọn VNPay.
2. Mở link (hoặc quét mã QR) bằng điện thoại.
3. Trên trang VNPay sandbox, chọn thẻ nội địa và nhập thẻ test NCB lấy từ tài liệu sandbox.
4. Sau khi trả, trang chuyển về hệ thống và báo "Thanh toán thành công". Đơn chuyển PAID, bàn sang chờ dọn.

## Thử các trường hợp lỗi

| Thử | Kết quả đúng |
|---|---|
| Bấm "Hủy" trên trang VNPay | Báo chưa hoàn tất; đơn vẫn chờ thanh toán; thu ngân chọn cách khác được |
| Trả xong rồi tắt trình duyệt trước khi quay về | Thu ngân bấm "Kiểm tra lại", đơn chuyển PAID |
| Sửa `vnp_Amount` trên Return URL rồi mở lại | Báo liên kết không hợp lệ; đơn không đổi |
| Để link quá 15 phút không trả | Sau tối đa 10 phút, script đối soát chuyển lần đó sang hết hạn |

## Xem dấu vết

- Nhật ký (Supervisor): lọc theo đơn, thấy `PAYMENT_LINK_CREATED` rồi `PAYMENT_CONFIRMED`.
- Log API: tìm theo `request_id` (xem `docs/runbooks/monitoring.md`).
