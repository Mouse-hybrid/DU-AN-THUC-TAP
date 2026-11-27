# Research: VAT, phí phục vụ, hóa đơn và hóa đơn điện tử

## R-1. Công thức và thứ tự tính

- **Decision**: tính trên từng đơn (mỗi bill tách là một đơn riêng), theo thứ tự:

  | Bước | Giá chưa gồm VAT | Giá đã gồm VAT |
  |---|---|---|
  | `base` | `subtotal − discount` | `subtotal − discount` |
  | `service_charge` | `round(base × sc% / 100)` | `round(base × sc% / 100)` |
  | `tax_total` | `round((base + service_charge) × vat% / 100)` | `round((base + service_charge) × vat% / (100 + vat%))` |
  | `total` (phải trả) | `base + service_charge + tax_total` | `base + service_charge` |

- **Kiểm lại ví dụ trong spec:**
  - US1: base 270.000 → phí 13.500 → VAT 283.500 × 8% = 22.680 → phải trả 306.180.
  - US1 giá gồm VAT: 108.000 × 8/108 = 8.000, phải trả 108.000.
  - US2: bill A 100.000 → 5.000 → 8.400 → 113.400; bill B 200.000 → 10.000 → 16.800 → 226.800. Tổng 340.200, bằng đơn gốc không tách.
- **Rationale**:
  - Phí phục vụ là một phần doanh thu dịch vụ nên chịu VAT, đúng cách các nhà hàng đang in hóa đơn.
  - Giảm giá trừ trước theo spec (đang chờ PO xác nhận). Đổi thứ tự sau này chỉ sửa một hàm.
  - Tách bill hiện đã tạo đơn mới, nên tính theo từng đơn là đủ BR-SB-004/005, không cần logic chia tỉ lệ riêng.
- **Alternatives considered**:
  - Tính thuế trên từng món rồi cộng lại: lệch làm tròn nhiều hơn, và không cần vì chỉ có một thuế suất.
  - VAT không tính trên phí phục vụ: sai với cách hóa đơn GTGT ghi phí phục vụ là một dòng hàng.

## R-2. Làm tròn

- **Decision**: `Decimal.quantize(Decimal("1"), ROUND_HALF_UP)` cho từng dòng `service_charge` và `tax_total`, trên từng đơn. Không làm tròn `base` (đã là số nguyên đồng).
- **Rationale**: tiền Việt không có số lẻ. Làm tròn từng dòng thì số in trên hóa đơn cộng lại đúng bằng `total`.
- **Hệ quả**: tổng các bill tách có thể lệch đơn gốc tối đa 1đ mỗi dòng (spec đã nêu).
- **Lưu ý code**: các hàm cũ (`_floor`) làm tròn xuống cho giảm giá; giữ nguyên, chỉ thuế/phí dùng nửa lên.

## R-3. Đổi cấu hình khi còn đơn đang thu dở

Spec US1 kịch bản 5 đề xuất chặn đổi cấu hình (409). Đọc code thấy cách đơn giản hơn:

- Thu tiền chỉ được khi đơn ở `BILLING` (`payments.py` dòng 176, `orders.py` `/pay`).
- Đơn ở `BILLING` không thêm, sửa, tách món được, và không có đường lùi về `SERVED`.

- **Decision**: **chốt tỉ lệ khi đơn chuyển `BILLING`** (`request_billing` ghi `vat_rate_applied`, `prices_include_vat_applied`, `service_charge_rate_applied` lên đơn). Số tiền vẫn tính lại khi cần (áp/gỡ ưu đãi trong lúc BILLING vẫn đúng). Khi đơn chuyển `PAID` thì lưu thêm `service_charge`, `tax_total` đã tính.
- **Rationale**:
  - Đơn đang thu dở không bao giờ đổi số vì cấu hình đổi, nên không cần chặn Supervisor.
  - Đơn chưa `BILLING` dùng cấu hình hiện tại; khách chưa trả gì nên không ai bị thu lệch.
  - Bỏ được một câu hỏi PO (câu 6 trong danh sách 27/11).
- **Alternatives considered**:
  - 409 khi còn đơn đang thu dở: Supervisor phải chờ, dễ kẹt giờ cao điểm.
  - Chốt tỉ lệ ngay khi tạo đơn: đơn mở từ trưa vẫn dùng thuế cũ sau khi đã đổi buổi chiều, khó giải thích.
- **Đơn cũ trước migration**: ba cột tỉ lệ để `NULL`. `NULL` nghĩa là "tỉ lệ 0", không phải "dùng cấu hình hiện tại", để đơn PAID cũ không đổi số khi bật VAT (FR-005).
  - Đơn mới chưa `BILLING` thì đọc cấu hình outlet, không đọc cột trên đơn.

## R-4. Điểm thưởng tích theo số nào

- **Decision**: giữ cách hiện tại, tích theo `total` (số khách thực trả, giờ gồm phí và VAT). Thêm cấu hình `LOYALTY_EARN_ON_PRE_TAX` (mặc định `false`); bật thì tích theo `base`.
- **Rationale**: không đổi hành vi khi VAT tắt; PO chốt khác thì bật cờ, không sửa code.
- **Lưu ý**: ngưỡng `min_order_amount` và trần giảm 50% vẫn tính trên `subtotal` như hiện nay (spec Edge Cases).

## R-5. Gửi hóa đơn điện tử không chặn bán hàng

- **Decision**:
  - Khi đơn `PAID` mà có yêu cầu VAT: trong cùng transaction, chuyển phiếu sang `PENDING`, đặt `next_attempt_at = now`. Không gọi nhà cung cấp trong transaction này.
  - Gửi bằng script `scripts/send_einvoices.py`, chạy 5 phút một lần bằng workflow `send-einvoices.yml` (giống `reconcile-vnpay.yml`).
  - Script lấy phiếu `PENDING`/`RETRYING` đến hạn bằng `FOR UPDATE SKIP LOCKED`, gọi nhà cung cấp có timeout 10 giây, commit từng phiếu.
  - Lỗi thì `RETRYING`, `next_attempt_at = now + min(5 phút × 2^(attempts−1), 2 giờ)`. Đến `EINVOICE_MAX_ATTEMPTS` (mặc định 5) thì `FAILED`, audit ngoại lệ.
  - Supervisor bấm gửi lại (`POST .../e-invoice/retry`) thì gửi ngay trong request (timeout 10 giây), đặt lại số lần thử.
- **Rationale**:
  - Thanh toán không bao giờ chờ nhà cung cấp (SC-003, TAX-HL-004, Edge case 10).
  - Dùng lại mô hình script + workflow đã chạy ổn (đối soát VNPay, hết hạn điểm). Không thêm hàng đợi hay scheduler (nguyên tắc VIII).
  - `SKIP LOCKED` cho hai lần chạy chồng nhau không gửi trùng một phiếu.
- **Alternatives considered**:
  - `BackgroundTasks` của FastAPI gửi ngay sau khi trả response: nhanh hơn, nhưng `finalize_paid_order` được gọi từ 5 đường khác nhau (`/pay`, payments, VNPay return, IPN, đối soát), dễ sót. Có thể thêm sau nếu PO cần phát hành gần như ngay.
  - Redis/Celery: thêm hạ tầng chỉ cho một job 5 phút, không đáng.
- **Rủi ro nhà cung cấp thật trả lỗi mạng sau khi đã phát hành**: Pha 3 là stub nên chưa xảy ra. Interface đã có `idempotency_key = e_invoice.id` để nhà cung cấp thật chống phát hành trùng (đa số nhà cung cấp VN có mã tham chiếu phía bán).

## R-6. Interface nhà cung cấp

- **Decision**: `app/core/einvoice.py`:

  ```python
  class EInvoiceProvider(Protocol):
      def issue(self, request: EInvoiceRequest) -> EInvoiceResult: ...
  ```

  - `EInvoiceRequest`: mã tham chiếu (id phiếu), thông tin người mua, các dòng hàng (món, phí phục vụ), thuế suất, tổng.
  - `EInvoiceResult`: `ok`, `invoice_no`, `lookup_code`, `error`.
  - `StubProvider`: thành công và trả `STUB-<8 ký tự id>`. Biến môi trường `EINVOICE_STUB_FAIL=true` thì luôn lỗi, để QA thử đường gửi lại.
  - Chọn nhà cung cấp bằng `EINVOICE_PROVIDER` (`stub` mặc định ở development/test/staging; `none` thì script không gửi gì, phiếu nằm `PENDING`).
- **Rationale**: thay nhà cung cấp thật ở Pha 4 chỉ cần viết một lớp mới và đặt biến môi trường. Stub không gọi ra ngoài (FR-011).

## R-7. Kiểm mã số thuế

- **Decision**: regex `^\d{10}(-\d{3})?$` (10 số, hoặc 10 số + `-` + 3 số cho đơn vị phụ thuộc). Không kiểm chữ số kiểm tra, không tra cứu cơ quan thuế.
- **Rationale**: đúng định dạng trong spec FR-008. Tra cứu thật cần API của Tổng cục Thuế, để Pha 4 cùng nhà cung cấp.
- Email kiểm bằng regex đơn giản `^[^@\s]+@[^@\s]+\.[^@\s]+$`. Repo chưa có `email-validator`, không thêm thư viện chỉ cho một trường.
