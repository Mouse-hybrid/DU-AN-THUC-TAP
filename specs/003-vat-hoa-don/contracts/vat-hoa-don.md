# Contract: VAT, phí phục vụ, hóa đơn, hóa đơn điện tử

Hợp đồng cho FE và QA. Sau khi code, `docs/api/openapi.json` là nguồn chính thức. Tiền trả dạng chuỗi số như các API hiện có (`"306180.00"`).

## 1. Cấu hình — `GET/PATCH /api/v1/outlet/settings` (đã có, thêm trường)

- Quyền `OUTLET_SETTINGS`. `PATCH` bắt buộc `Idempotency-Key`, gửi trường nào đổi trường đó.

```json
{
  "qr_send_mode": "DIRECT",
  "vat_rate": "8.00",
  "prices_include_vat": false,
  "service_charge_rate": "5.00"
}
```

| Mã | Khi nào |
|---|---|
| 422 | `vat_rate` ngoài 0–20, `service_charge_rate` ngoài 0–30, quá 2 chữ số thập phân |

Đổi cấu hình chỉ ảnh hưởng đơn **chưa** yêu cầu thanh toán. Đơn đang `BILLING` giữ tỉ lệ lúc yêu cầu thanh toán.

## 2. Chi tiết đơn — `GET /api/v1/orders/{id}` (đã có, thêm trường)

```json
{
  "subtotal": "300000.00",
  "discount_total": "30000.00",
  "service_charge": "13500.00",
  "tax_total": "22680.00",
  "total": "306180.00",
  "amount_paid": "0.00",
  "amount_due": "306180.00",
  "pricing_rates": {
    "vat_rate": "8.00",
    "prices_include_vat": false,
    "service_charge_rate": "5.00",
    "locked": true
  }
}
```

- `locked`: `true` khi đơn đã `BILLING` trở đi (tỉ lệ không đổi nữa).
- Giá gồm VAT: `tax_total` là phần VAT nằm trong giá, **không** cộng vào `total`. FE hiện "Đã gồm VAT 8%: 8.000đ".
- VAT và phí bằng 0 thì FE ẩn hai dòng này.
- Các API khác trả `total` cũng đổi theo: `GET /orders/{id}/payments` (`summary.total`), danh sách đơn, `GET /public/qr/{token}/order` (thêm `service_charge`, `tax_total`).

## 3. Hóa đơn — `GET /api/v1/orders/{id}/invoice`

- Quyền `PROCESS_PAYMENT`.

**200**:

```json
{
  "is_preview": false,
  "outlet": { "name": "NOVA", "address": "..." },
  "order_id": "…",
  "table_code": "T05",
  "created_at": "2026-11-27T11:30:00Z",
  "paid_at": "2026-11-27T12:40:00Z",
  "items": [
    { "name": "Bò lúc lắc", "quantity": 2, "unit_price": "150000.00",
      "modifiers": ["Chín vừa"], "line_total": "300000.00" }
  ],
  "subtotal": "300000.00",
  "discount_total": "30000.00",
  "discount_label": "Giảm 10%",
  "service_charge": "13500.00",
  "tax_total": "22680.00",
  "total": "306180.00",
  "pricing_rates": { "vat_rate": "8.00", "prices_include_vat": false, "service_charge_rate": "5.00", "locked": true },
  "payments": [
    { "method": "CASH", "amount": "200000.00", "paid_at": "…" },
    { "method": "VNPAY", "amount": "106180.00", "paid_at": "…", "provider_txn_no": "14123456" }
  ],
  "customer_phone_masked": "090****567",
  "vat_request": { "buyer_tax_code": "0123456789", "buyer_name": "Công ty ABC", "e_invoice_status": "ISSUED" }
}
```

- `is_preview: true` khi đơn chưa `PAID`; FE in chữ "Tạm tính".
- Không có món đã hủy. Lần thanh toán đã hủy hoặc thất bại không hiện.
- `paid_at` của từng lần thanh toán: VNPay lấy giờ VNPay báo (`provider_paid_at`), tiền mặt và thẻ lấy giờ ghi nhận.
- `vat_request` là `null` nếu khách không yêu cầu. Không trả email ở đây.

## 4. Yêu cầu hóa đơn VAT — `PUT /api/v1/orders/{id}/vat-request`

- Quyền `PROCESS_PAYMENT`. Bắt buộc `Idempotency-Key`.

```json
{
  "buyer_tax_code": "0123456789-001",
  "buyer_name": "Công ty TNHH ABC",
  "buyer_address": "12 Lê Lợi, Q1, TP.HCM",
  "buyer_email": "ketoan@abc.vn"
}
```

**200** — trả trạng thái phiếu (giống mục 5).

| Mã | Khi nào |
|---|---|
| 404 | Không có đơn, hoặc đơn của outlet khác |
| 409 | Phiếu đã `ISSUED`; hoặc đơn `CLOSED` mà không có món (đơn rỗng) |
| 422 | Mã số thuế sai định dạng, email sai, thiếu tên hoặc địa chỉ |

- Đơn chưa `PAID`: phiếu ở `REQUESTED`.
- Đơn đã `PAID`: phiếu sang `PENDING` ngay, job gửi trong vòng 5 phút.

## 5. Trạng thái hóa đơn điện tử — `GET /api/v1/orders/{id}/e-invoice`

- Quyền `PROCESS_PAYMENT`.

**200**:

```json
{
  "status": "RETRYING",
  "attempts": 2,
  "next_attempt_at": "2026-11-27T12:55:00Z",
  "last_error": "Nhà cung cấp không phản hồi",
  "provider_invoice_no": null,
  "provider_lookup_code": null,
  "issued_at": null,
  "buyer_tax_code": "0123456789-001",
  "buyer_name": "Công ty TNHH ABC",
  "buyer_address": "12 Lê Lợi, Q1, TP.HCM",
  "buyer_email": "ketoan@abc.vn"
}
```

| Mã | Khi nào |
|---|---|
| 404 | Đơn không có yêu cầu VAT |

## 6. Gửi lại tay — `POST /api/v1/orders/{id}/e-invoice/retry`

- Quyền `PAYMENT_REFUND` (Supervisor, cùng nhóm thao tác tiền sau thanh toán). Bắt buộc `Idempotency-Key`. Bắt buộc `reason`.

```json
{ "reason": "Nhà cung cấp đã hoạt động lại" }
```

**200** — trạng thái phiếu sau lần gửi (gửi ngay trong request, chờ tối đa 10 giây).

| Mã | Khi nào |
|---|---|
| 404 | Đơn không có yêu cầu VAT |
| 409 | Phiếu không ở `FAILED` hoặc `RETRYING` |
| 422 | Thiếu `reason` |

## 7. Trang QR (P3) — `PUT /api/v1/public/qr/{token}/vat-request`

- Công khai, bắt buộc `Idempotency-Key`. Body như mục 4.
- Lưu phiếu `REQUESTED` cho đơn đang mở của phiếu bàn; thu ngân thấy và xác nhận ở màn 23.
- **200**: `{ "status": "RECEIVED" }`. Không trả lại thông tin đã nhập.
- Làm sau cùng, chỉ khi còn thời gian (spec US5).
