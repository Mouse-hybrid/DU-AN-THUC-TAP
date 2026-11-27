# Implementation Plan: VAT, phí phục vụ, hóa đơn và hóa đơn điện tử (stub)

- **Branch**: `feat/vat-hoa-don`
- **Date**: 2026-11-27
- **Spec**: [spec.md](spec.md)

## Summary

Bốn phần, làm theo thứ tự ưu tiên của spec:

1. **Tính tiền (US1, US2):** mở rộng `price_order` trong `app/core/loyalty.py` để tính phí phục vụ và VAT trên từng đơn. Mọi luồng thu tiền đã gọi `price_order().total`, nên đổi một chỗ là đủ. Tách bill đã tạo đơn riêng, nên mỗi bill tự có thuế và phí. Tỉ lệ được chốt lên đơn khi chuyển `BILLING`, số tiền chốt khi chuyển `PAID`.
2. **Hóa đơn (US3):** một API đọc, gom dữ liệu đơn, món, thanh toán, yêu cầu VAT.
3. **Hóa đơn điện tử (US4):** bảng `e_invoice`, interface nhà cung cấp kèm bản stub, script gửi chạy 5 phút một lần. Thanh toán không gọi nhà cung cấp.
4. **QR (US5, P3):** làm nếu còn thời gian.

Cấu hình mặc định là 0%, nên merge không đổi số tiền nào trên staging.

## Technical Context

| Mục | Giá trị |
|---|---|
| Language/Version | Python 3.11 |
| Primary Dependencies | FastAPI, SQLAlchemy 2 (không thêm thư viện) |
| Storage | PostgreSQL 16. Migration `0016`: 3 cột `outlet`, 6 cột `order`, bảng `e_invoice` |
| Testing | pytest; test Postgres cho job gửi chạy chồng (`SKIP LOCKED`) |
| Target Platform | Docker Compose trên staging, workflow self-hosted cho job |
| Performance Goals | `GET /orders/{id}` không chậm thêm quá 5 ms; thanh toán không chậm thêm khi nhà cung cấp lỗi (SC-003) |
| Constraints | Tiền `Numeric(12,2)`, làm tròn nửa lên tới 1đ; mặc định tắt; không gọi dịch vụ ngoài trong transaction thanh toán |
| Scale/Scope | 4 endpoint mới, 3 endpoint đổi response, 1 migration, 1 script, 1 workflow |

## Constitution Check

| Nguyên tắc | Đáp ứng |
|---|---|
| I. BRD, PO chốt | Thuế suất, phí phục vụ, giá gồm VAT đặt qua cấu hình outlet. Thứ tự giảm giá và cơ sở tích điểm có cờ cấu hình (research R-1, R-4). Câu hỏi PO giữ trong spec |
| II. An toàn khi gửi lại | `PATCH /outlet/settings`, `PUT vat-request`, `POST e-invoice/retry` có Idempotency-Key. `vat-request` khóa đơn rồi mới khóa phiếu (phiếu thuộc nhóm "thanh toán" trong thứ tự khóa). Job khóa từng phiếu bằng `SKIP LOCKED`, không khóa đơn |
| III. Phân quyền | `OUTLET_SETTINGS` cho cấu hình, `PROCESS_PAYMENT` cho hóa đơn và yêu cầu VAT, `PAYMENT_REFUND` cho gửi lại tay. Lọc theo `outlet_id`, khác outlet trả 404. API QR dưới `/public/` |
| IV. Dấu vết | 6 action audit mới (data-model). `EINVOICE_FAILED`, `EINVOICE_RETRY_MANUAL` vào `EXCEPTION_ACTIONS`. Audit `ORDER_BILLING_REQUESTED` và `ORDER_PAID` thêm tỉ lệ và số thuế/phí |
| V. Test, CI | Test đủ luồng chính, quyền, trạng thái, gửi lại, cách ly outlet. 20 tổ hợp tính tiền (SC-002). Test hiện có không sửa số kỳ vọng (SC-001). Sinh lại openapi, schema.d.ts, api-catalog |
| VI. Migration | Cột mới có mặc định hoặc cho phép null. Trạng thái `e_invoice` dùng `String` + CHECK. Có `downgrade()` |
| VII. Bí mật, dữ liệu cá nhân | Không có khóa nhà cung cấp ở Pha 3 (stub). Audit và `last_error` không ghi email người mua. Gọi nhà cung cấp có timeout 10 giây |
| VIII. Đơn giản | Job dùng script + workflow như đối soát VNPay. Không thêm hàng đợi (research R-5) |

Không có vi phạm.

## Project Structure

```text
backend/
  app/
    core/pricing.py            # MỚI: compute_charges(base, rates) -> Charges; rates_for_order()
    core/loyalty.py            # OrderPricing thêm service_charge, tax_total, rates; price_order gọi pricing
    core/einvoice.py           # MỚI: EInvoiceProvider, StubProvider, issue_einvoice(), queue_on_paid()
    core/config.py             # + EINVOICE_*, LOYALTY_EARN_ON_PRE_TAX
    db/models.py               # Outlet, Order thêm cột; EInvoice mới
    api/v1/outlet.py           # settings thêm 3 trường
    api/v1/orders.py           # request_billing chốt tỉ lệ; finalize_paid_order chốt số, xếp phiếu;
                               # detail trả service_charge, tax_total, pricing_rates;
                               # + GET invoice, PUT vat-request, GET e-invoice, POST e-invoice/retry
    api/v1/payments.py         # _summary dùng total mới (đã dùng price_order, chỉ kiểm lại)
    api/v1/qr.py               # tổng QR dùng price_order thay vì subtotal - discount
    api/v1/audit.py            # + EXCEPTION_ACTIONS
    schemas/orders.py, schemas/outlet.py, schemas/einvoice.py (mới)
  migrations/versions/0016_vat_einvoice.py
  scripts/send_einvoices.py
  tests/test_vat_pricing.py
  tests/test_invoice.py
  tests/test_einvoice.py
  tests/test_concurrency_postgres.py   # + hai lần chạy job song song không gửi trùng
.github/workflows/send-einvoices.yml
```

## Thiết kế chính

### Tính tiền

`app/core/pricing.py` là hàm thuần, không đụng DB, để test 20 tổ hợp dễ:

```python
@dataclass(frozen=True)
class PricingRates:
    vat_rate: Decimal
    prices_include_vat: bool
    service_charge_rate: Decimal
    locked: bool

@dataclass(frozen=True)
class Charges:
    service_charge: Decimal
    tax_total: Decimal
    total: Decimal

def compute_charges(base: Decimal, rates: PricingRates) -> Charges: ...
def rates_for_order(order: Order, outlet: Outlet) -> PricingRates: ...
```

- Công thức và làm tròn theo research R-1, R-2. `base <= 0` thì phí và thuế bằng 0.
- `rates_for_order`: đơn đã `BILLING` trở đi đọc cột `*_applied` (null coi là 0); còn lại đọc outlet.
- `OrderPricing` giữ nguyên tên, thêm `service_charge`, `tax_total`, `rates`. `total` thành `base + service_charge + (0 nếu giá gồm VAT, ngược lại tax_total)`.
- Đơn đã `PAID` có `service_charge`/`tax_total` lưu sẵn thì `price_order` trả số đã lưu, không tính lại.

**Chỗ phải đổi để không còn `subtotal − discount` tự cộng (FR-004):**

| File | Hiện tại | Đổi |
|---|---|---|
| `api/v1/qr.py` ~dòng 258 | `total=subtotal - discount` | cộng từ `price_order` từng đơn |
| `core/loyalty.py` `earn_points_for_order` | nhận `pricing.total` | giữ; cờ `LOYALTY_EARN_ON_PRE_TAX` thì truyền `base` |
| `evaluate_reward`, `legal_discount_cap` | trên `subtotal` | giữ nguyên (spec Edge Cases) |

Các chỗ khác (`payments.py`, `vnpay.py`, `/pay`, `finalize_paid_order`, `_summary`) đã dùng `price_order().total`, chỉ cần test lại.

### Chốt tỉ lệ và số tiền

- `request_billing`: sau khi chuyển `BILLING`, chép 3 tỉ lệ từ outlet lên đơn, ghi vào payload audit `ORDER_BILLING_REQUESTED`.
- `finalize_paid_order`: sau `commit_order_reward`, ghi `service_charge`, `tax_total`, `paid_at` lên đơn; thêm vào payload `ORDER_PAID`; gọi `queue_on_paid(session, order)` nếu đơn có phiếu `REQUESTED`.
- Supervisor đổi tỉ lệ khi có đơn đang `BILLING`: cho đổi, đơn đó giữ tỉ lệ cũ (research R-3). Spec US1 kịch bản 5 cập nhật theo.

### Hóa đơn điện tử

- `PUT vat-request`: khóa đơn (`FOR UPDATE`), lấy hoặc tạo phiếu, kiểm trạng thái, lưu người mua. Đơn đã `PAID` thì gọi `queue_on_paid` luôn.
- `queue_on_paid`: `total > 0` thì `PENDING`, `next_attempt_at = now`, audit `EINVOICE_QUEUED`. Không gọi nhà cung cấp.
- `scripts/send_einvoices.py`: theo research R-5. Mỗi phiếu một transaction; dựng `EInvoiceRequest` từ dữ liệu hóa đơn (dùng chung hàm với `GET invoice`).
- `POST e-invoice/retry`: khóa phiếu, đặt `attempts = 0`, gửi ngay qua `issue_einvoice` (timeout), trả trạng thái mới.
- Workflow `send-einvoices.yml`: cron `*/5`, `concurrency: staging`, giống `reconcile-vnpay.yml`.

### Hóa đơn (in)

- `build_invoice(session, order) -> InvoiceOut` trong `api/v1/orders.py` (hoặc `core/invoice.py` nếu file `orders.py` quá dài). Dùng cho cả `GET invoice` và dữ liệu gửi nhà cung cấp.
- Số điện thoại khách luôn che bằng hàm che có sẵn.

## Ảnh hưởng FE (báo Thiện sau khi merge phần tính tiền)

- Màn tóm tắt đơn và khung Thanh toán: thêm dòng "Phí phục vụ x%" và "VAT x%" (hoặc "Đã gồm VAT x%"), ẩn khi bằng 0.
- Màn Cài đặt: 3 ô cấu hình mới.
- Màn 24 Xem hóa đơn, màn 23 Hóa đơn VAT: màn mới, làm sau khi có API.
- Trang QR: tổng tiền có thể khác trước khi bật VAT.

## Ảnh hưởng QA

- Cấu hình mặc định tắt: các gate Phase 1/2 và evidence cũ không đổi.
- Bật VAT trên staging chỉ khi PO chốt số và QA đồng ý, vì đổi số tiền của mọi ca thanh toán mới.
- P2-PAY-008 (thuế theo bill tách) chạy được sau khi xong US2.

## Complexity Tracking

Không có.
