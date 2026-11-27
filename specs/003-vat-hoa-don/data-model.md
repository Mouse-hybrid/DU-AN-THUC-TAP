# Data Model: VAT, phí phục vụ, hóa đơn điện tử

Migration `0016_vat_einvoice.py`. Mọi cột mới trên bảng đã có đều cho phép null hoặc có mặc định, chạy được trên dữ liệu staging (nguyên tắc VI).

## outlet (đã có) — thêm 3 cột

| Cột | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|
| `vat_rate` | `Numeric(5,2)` | `0` | % VAT. CHECK `0 <= vat_rate <= 20` |
| `prices_include_vat` | `Boolean` | `false` | Giá thực đơn đã gồm VAT |
| `service_charge_rate` | `Numeric(5,2)` | `0` | % phí phục vụ. CHECK `0 <= service_charge_rate <= 30` |

Mặc định 0 nên deploy không đổi số tiền nào (SC-001). Trần 20% và 30% chỉ để chặn gõ nhầm, không phải con số nghiệp vụ.

## order (đã có) — thêm 6 cột

| Cột | Kiểu | Ghi khi | Ghi chú |
|---|---|---|---|
| `vat_rate_applied` | `Numeric(5,2)` null | chuyển `BILLING` | Chép từ outlet (research R-3) |
| `prices_include_vat_applied` | `Boolean` null | chuyển `BILLING` | |
| `service_charge_rate_applied` | `Numeric(5,2)` null | chuyển `BILLING` | |
| `service_charge` | `Numeric(12,2)` null | chuyển `PAID` | Số đã tính, giữ cố định |
| `tax_total` | `Numeric(12,2)` null | chuyển `PAID` | |
| `paid_at` | `DateTime(tz)` null | chuyển `PAID` | In trên hóa đơn. Đơn cũ để null, hóa đơn lấy `updated_at` |

Đọc tỉ lệ khi tính tiền:
- Đơn `BILLING`/`PAID`/`CLOSED`: dùng cột `*_applied`; `NULL` (đơn cũ trước migration) coi là 0.
- Đơn `NEW`/`SENT`/`SERVED`: dùng cấu hình outlet hiện tại.

Không lưu `total` riêng: `total` = `subtotal − discount + service_charge + tax_total` (hoặc không cộng `tax_total` nếu giá gồm VAT), tính trong `price_order`. Giảm giá đã chốt nằm sẵn ở `order_reward.discount_amount`.

## e_invoice (mới)

Một phiếu cho một đơn. Tạo khi thu ngân lưu yêu cầu VAT (kể cả trước khi đơn PAID), nên bảng này cũng giữ thông tin người mua.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | GUID PK | Dùng làm mã tham chiếu gửi nhà cung cấp |
| `order_id` | GUID FK → order, **unique** | |
| `outlet_id` | GUID FK → outlet | Lọc theo outlet |
| `status` | `String(20)` + CHECK | `REQUESTED`, `PENDING`, `RETRYING`, `ISSUED`, `FAILED` |
| `buyer_tax_code` | `String(14)` | `0123456789` hoặc `0123456789-001` |
| `buyer_name` | `String(255)` | Tên đơn vị |
| `buyer_address` | `Text` | |
| `buyer_email` | `String(255)` | Nơi nhận hóa đơn |
| `attempts` | `Integer` mặc định 0 | |
| `next_attempt_at` | `DateTime(tz)` null | Job lấy phiếu đến hạn |
| `last_error` | `String(500)` null | Không chứa dữ liệu người mua |
| `provider` | `String(30)` null | `stub`, sau này tên nhà cung cấp thật |
| `provider_invoice_no` | `String(50)` null | Số hóa đơn nhà cung cấp trả |
| `provider_lookup_code` | `String(100)` null | Mã tra cứu cho khách |
| `issued_at` | `DateTime(tz)` null | |
| `created_at`, `updated_at` | `DateTime(tz)` | |

Index: `(status, next_attempt_at)` cho job.

### Trạng thái

```text
REQUESTED ──(đơn PAID)──▶ PENDING ──(gửi được)──▶ ISSUED
                            │
                            └─(lỗi)─▶ RETRYING ──(gửi được)──▶ ISSUED
                                         │
                                         └─(hết số lần)─▶ FAILED ──(Supervisor gửi lại)──▶ PENDING
```

- `REQUESTED`: có thông tin người mua, đơn chưa PAID. Thêm so với spec FR-010 để không phải giữ thông tin VAT ở bảng `order`.
- Sửa thông tin người mua được khi `REQUESTED`, `PENDING`, `RETRYING`, `FAILED`; `ISSUED` thì 409.
- Đơn PAID có `total = 0` thì phiếu không chuyển `PENDING`, giữ `REQUESTED` và ghi audit (spec: đơn 0đ không xuất hóa đơn).

## audit_log — action mới

| Action | Ngoại lệ? | Khi nào |
|---|---|---|
| `OUTLET_SETTINGS_UPDATED` | không (đã có) | Payload thêm `vat_rate`, `prices_include_vat`, `service_charge_rate` before/after |
| `VAT_REQUEST_SAVED` | không | Lưu hoặc sửa thông tin người mua. Payload chỉ ghi mã số thuế, không ghi email |
| `EINVOICE_QUEUED` | không | Đơn PAID, phiếu sang `PENDING` |
| `EINVOICE_ISSUED` | không | Nhà cung cấp trả số hóa đơn |
| `EINVOICE_ATTEMPT_FAILED` | không | Một lần gửi lỗi |
| `EINVOICE_FAILED` | **có** | Hết số lần thử |
| `EINVOICE_RETRY_MANUAL` | **có** | Supervisor gửi lại tay |

## Cấu hình (`app/core/config.py`)

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `EINVOICE_PROVIDER` | `stub` | `stub` hoặc `none` |
| `EINVOICE_STUB_FAIL` | `false` | Cho QA thử đường lỗi |
| `EINVOICE_MAX_ATTEMPTS` | `5` | |
| `EINVOICE_TIMEOUT_SECONDS` | `10` | |
| `LOYALTY_EARN_ON_PRE_TAX` | `false` | research R-4 |
