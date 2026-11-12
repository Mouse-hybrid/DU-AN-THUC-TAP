# Research: Thanh toán VNPay (sandbox)

Ghi lại các lựa chọn đã cân nhắc. Tham số VNPay dưới đây theo tài liệu tích hợp VNPay phiên bản 2.1.0 mà nhóm đã đọc. **Khi có tài khoản sandbox phải đối chiếu lại với tài liệu VNPay gửi kèm**, nhất là định dạng chuỗi ký của QueryDR.

## R-1. Xác nhận kết quả khi staging chưa có HTTPS

- **Decision**: Return URL (trình duyệt khách quay về) + QueryDR (BE gọi ra VNPay). IPN viết sẵn, chỉ bật khi có HTTPS.
- **Rationale**:
  - Return URL do trình duyệt mở nên http trên IP vẫn chạy.
  - QueryDR là chiều gọi ra nên không cần HTTPS.
  - Không tin Return URL một mình, vì khách có thể sửa tham số.
- **Alternatives considered**:
  - Chỉ dùng IPN: cần URL công khai có HTTPS, staging chưa có.
  - Chỉ dùng Return URL: không an toàn, và mất kết quả nếu khách tắt trình duyệt.
  - Bật HTTPS ngay bằng `sslip.io` + Let's Encrypt: làm được nhưng thuộc R13. Chỉ dùng nếu VNPay bắt khai báo IPN URL.

**Cập nhật 12/11 (chạy thử sandbox thật):** QueryDR của sandbox trả `{"vnp_ResponseCode": "99", "vnp_Message": "Unexpected error"}`, không kèm chữ ký, cho **mọi** yêu cầu. Đã thử 4 biến thể (IP `127.0.0.1`, IP server, IP máy khách, `vnp_RequestId` ngắn) đều ra `99`. Yêu cầu khớp tài liệu và code mẫu của VNPay.

- **Decision (đổi so với bản đầu):** Return URL hỏi QueryDR trước; QueryDR trả lời được thì nghe QueryDR. QueryDR **lỗi** thì dùng kết quả trong Return URL (nguồn ghi audit `return_signed`).
- **Rationale:**
  - Dữ liệu Return URL đã kiểm chữ ký HMAC-SHA512 bằng `vnp_HashSecret`, nên không giả được.
  - Mở lại cùng link không chốt đơn lần hai, vì hàm xác nhận idempotent.
  - Vẫn so số tiền và mã tham chiếu.
  - Rủi ro còn lại là khách đóng trình duyệt trước khi quay về. Trường hợp này xử lý bằng IPN (khi có HTTPS) hoặc nút "Kiểm tra lại" (khi QueryDR chạy lại được).
- **Còn mở:** hỏi hỗ trợ VNPay sandbox vì sao QueryDR trả `99` cho mã merchant này. Nếu do tài khoản chưa bật QueryDR thì nút "Kiểm tra lại" và script đối soát chưa dùng được trên sandbox.

## R-2. Tham số tạo link (`vpcpay.html`, phương thức GET)

| Tham số | Giá trị |
|---|---|
| `vnp_Version` | `2.1.0` |
| `vnp_Command` | `pay` |
| `vnp_TmnCode` | `VNPAY_TMN_CODE` |
| `vnp_Amount` | số tiền × 100, số nguyên |
| `vnp_CurrCode` | `VND` |
| `vnp_TxnRef` | `payment.id` dạng hex 32 ký tự (duy nhất, không lộ thông tin đơn) |
| `vnp_OrderInfo` | `Thanh toan don <6 ky tu cuoi id>` (không dấu) |
| `vnp_OrderType` | `other` |
| `vnp_Locale` | `vn` |
| `vnp_ReturnUrl` | `VNPAY_RETURN_URL` (vd `http://160.191.47.17/api/v1/payments/vnpay/return`) |
| `vnp_IpAddr` | IP của máy thu ngân (header `X-Forwarded-For` qua nginx), không có thì `127.0.0.1` |
| `vnp_CreateDate`, `vnp_ExpireDate` | `yyyyMMddHHmmss`, giờ Việt Nam; hết hạn = tạo + `VNPAY_LINK_TTL_MINUTES` (mặc định 15) |
| `vnp_SecureHash` | HMAC-SHA512(`VNPAY_HASH_SECRET`, chuỗi query đã sắp xếp theo tên, giá trị URL-encode) |

## R-3. QueryDR (tra cứu giao dịch)

- **Gọi:** `POST` JSON tới `VNPAY_API_URL`. Các trường gửi đi:
  - `vnp_RequestId`: mới mỗi lần gọi;
  - `vnp_Version`;
  - `vnp_Command=querydr`;
  - `vnp_TmnCode`, `vnp_TxnRef`, `vnp_OrderInfo`;
  - `vnp_TransactionDate`: bằng `vnp_CreateDate` lúc tạo link;
  - `vnp_CreateDate`, `vnp_IpAddr`, `vnp_SecureHash`.
- **Chữ ký:** HMAC-SHA512 của các trường nối bằng `|` theo thứ tự tài liệu quy định. **Cần đối chiếu** với tài liệu khi có tài khoản.
- **Đọc kết quả:** `vnp_ResponseCode = 00` nghĩa là tra cứu thành công. Khi đó xem `vnp_TransactionStatus`:
  - `00`: đã thanh toán;
  - `01`: chưa hoàn tất;
  - `02`: lỗi;
  - các mã khác: theo bảng mã của VNPay.
- **Thời hạn chờ:** 10 giây. Quá hạn hoặc lỗi mạng thì không đổi trạng thái (spec: Edge Cases).

## R-4. Mã trả lời IPN

| Mã | Khi nào |
|---|---|
| `00` | Xác nhận thành công |
| `01` | Không tìm thấy lần thanh toán |
| `02` | Đã xác nhận trước đó |
| `04` | Số tiền không khớp |
| `97` | Sai chữ ký |
| `99` | Lỗi khác (kể cả IPN đang tắt) |

## R-5. Đối soát định kỳ

- **Decision**: script `scripts/reconcile_vnpay.py`, chạy bằng workflow `reconcile-vnpay.yml` 10 phút một lần trên runner staging (self-hosted), qua `docker compose exec api`.
- **Rationale**: dùng lại hạ tầng của backup và reset staging, không thêm scheduler (constitution VIII).
- **Alternatives considered**:
  - APScheduler trong tiến trình API: chạy trùng khi có nhiều worker.
  - Celery + Redis: thêm hai thành phần, quá nặng cho một việc.
  - Kiểm tra lười khi có người mở đơn: đơn bị bỏ quên sẽ treo mãi.

## R-6. Thư viện gọi HTTP

- **Decision**: `httpx` (đã có trong `requirements-dev.txt`, chuyển sang `requirements.txt`, giữ phiên bản 0.27.2).
- **Rationale**: test bằng `MockTransport` không cần mạng; đặt thời hạn chờ dễ.
- **Alternatives considered**: `urllib` của thư viện chuẩn — dùng được nhưng giả lập trong test khó hơn.
