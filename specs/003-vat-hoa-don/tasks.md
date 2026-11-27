# Tasks: VAT, phí phục vụ, hóa đơn và hóa đơn điện tử (stub)

- **Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/vat-hoa-don.md](contracts/vat-hoa-don.md)
- **Ký hiệu**: `[P]` = làm song song được; `[US1]`… = thuộc user story nào.
- **Ước lượng**: khoảng 4 ngày làm (US1+US2 ~1,5 ngày, US3 ~0,5, US4 ~1,5, polish ~0,5). US5 ngoài ước lượng.
- **Tiến độ (27/11)**: PR 1 (Phase 1–3) đã code xong, trừ T003 (chạy migration trên Postgres: CI chạy `alembic upgrade head` trên Postgres; bản sao dữ liệu staging làm trước khi merge). Migration tách đôi: `0016_vat_service_charge` (PR 1), bảng `e_invoice` sang `0017` ở PR 2. Biến `EINVOICE_*` cũng để PR 2.

## Phase 1: Foundational

- [x] T001 Migration `backend/migrations/versions/0016_vat_einvoice.py`:
  - `outlet`: `vat_rate`, `prices_include_vat`, `service_charge_rate`, mặc định 0/false, có CHECK khoảng giá trị;
  - `order`: `vat_rate_applied`, `prices_include_vat_applied`, `service_charge_rate_applied`, `service_charge`, `tax_total`, `paid_at`, đều cho phép null;
  - bảng `e_invoice` với CHECK trạng thái, unique `order_id`, index `(status, next_attempt_at)`;
  - có `downgrade()`.
- [x] T002 Cập nhật `Outlet`, `Order`, thêm `EInvoice` và `EINVOICE_STATUS` trong `backend/app/db/models.py`; thêm `EINVOICE_PROVIDER`, `EINVOICE_STUB_FAIL`, `EINVOICE_MAX_ATTEMPTS`, `EINVOICE_TIMEOUT_SECONDS`, `LOYALTY_EARN_ON_PRE_TAX` vào `backend/app/core/config.py`.
- [ ] T003 Chạy migration lên/xuống trên bản sao dữ liệu staging (`alembic upgrade head`, `downgrade -1`, `upgrade head`), ghi kết quả vào PR.

## Phase 2: User Story 1 — VAT và phí phục vụ (P1) 🎯

- [x] T004 [US1] `backend/app/core/pricing.py`: `PricingRates`, `Charges`, `compute_charges`, `rates_for_order` theo research R-1, R-2, R-3.
- [x] T005 [P] [US1] `backend/tests/test_vat_pricing.py` phần hàm thuần:
  - 3 ví dụ trong spec (306.180; giá gồm VAT 108.000 → 8.000; tắt → bằng `subtotal − discount`);
  - 16 tổ hợp giá gồm/chưa gồm VAT × có/không phí × có/không giảm giá × 2 mức giá lẻ (làm tròn nửa lên);
  - `base = 0` và đơn giảm hết.
- [x] T006 [US1] `OrderPricing` thêm `service_charge`, `tax_total`, `rates`; `price_order` gọi `compute_charges`; đơn PAID có số đã lưu thì trả số đã lưu (`backend/app/core/loyalty.py`).
- [x] T007 [US1] `request_billing` chốt 3 tỉ lệ lên đơn, thêm vào audit; `finalize_paid_order` lưu `service_charge`, `tax_total`, `paid_at`, thêm vào audit `ORDER_PAID` (`backend/app/api/v1/orders.py`).
- [x] T008 [US1] `earn_points_for_order` nhận số theo cờ `LOYALTY_EARN_ON_PRE_TAX` (`backend/app/core/loyalty.py`, chỗ gọi trong `finalize_paid_order`).
- [x] T009 [US1] Response:
  - `OrderDetailOut` thêm `service_charge`, `tax_total`, `pricing_rates` (`backend/app/schemas/orders.py`, `_order_detail` trong `orders.py`);
  - QR order summary dùng `price_order` thay vì `subtotal − discount`, thêm hai trường (`backend/app/api/v1/qr.py`, `backend/app/schemas/qr.py`);
  - kiểm `PaymentSummaryOut.total` và danh sách đơn đã ra số mới.
- [x] T010 [US1] `GET/PATCH /outlet/settings` thêm 3 trường, kiểm khoảng giá trị, audit before/after (`backend/app/api/v1/outlet.py`, `backend/app/schemas/outlet.py`).
- [x] T011 [P] [US1] Test API trong `backend/tests/test_vat_pricing.py`:
  - bật cấu hình, đơn có ưu đãi, chi tiết đơn khớp bảng US1;
  - trả nhiều lần (tiền mặt + thẻ) đủ `total` mới thì PAID, thiếu 1đ thì chưa;
  - VNPay tạo link với số tiền mới (mock như test VNPay hiện có);
  - đổi tỉ lệ khi đơn đang `BILLING` không đổi số đơn đó; đơn mở sau dùng tỉ lệ mới;
  - đổi tỉ lệ sau khi PAID không đổi số đơn PAID;
  - đơn PAID trước migration (cột null) vẫn ra số cũ khi bật VAT;
  - áp/gỡ ưu đãi lúc `BILLING` thì thuế tính lại trên base mới;
  - tích điểm theo `total`, và theo `base` khi bật cờ;
  - `PATCH /outlet/settings`: quyền, 422, gửi lại cùng Idempotency-Key, audit;
  - outlet khác không thấy và không đổi được.
- [x] T012 [US1] Chạy toàn bộ test hiện có với cấu hình mặc định, không sửa số kỳ vọng nào (SC-001).

## Phase 3: User Story 2 — Tách bill (P1)

- [x] T013 [US2] Test trong `backend/tests/test_vat_pricing.py`:
  - ví dụ US2: bill A 113.400, bill B 226.800, tổng bằng đơn không tách;
  - 4 tổ hợp tách có/không phí × giá gồm/chưa gồm VAT, tổng lệch tối đa 1đ mỗi dòng (cùng T005 đủ 20 tổ hợp của SC-002);
  - trả nhiều lần trên cùng đơn không tính lại thuế mỗi lần.
- [x] T014 [US2] Nếu T013 lộ chỗ tách bill chưa đúng (ví dụ đơn mới chưa đọc tỉ lệ đúng) thì sửa `split_order`. Dự kiến không cần sửa, vì tách chỉ được trước `BILLING`.

## Phase 4: User Story 3 — Hóa đơn (P2)

- [ ] T015 [US3] `build_invoice(session, order)` và `GET /orders/{id}/invoice` (`backend/app/api/v1/orders.py` hoặc `backend/app/core/invoice.py`; schema `InvoiceOut` trong `backend/app/schemas/einvoice.py`).
- [ ] T016 [P] [US3] `backend/tests/test_invoice.py`:
  - đơn PAID tiền mặt + VNPay: đủ hai lần thanh toán, mã giao dịch, tổng khớp;
  - đơn chưa PAID: `is_preview: true`;
  - món đã hủy, lần thanh toán đã hủy không hiện;
  - số điện thoại đã che, không có email người mua;
  - quyền `PROCESS_PAYMENT`, outlet khác 404.

## Phase 5: User Story 4 — Hóa đơn điện tử (P2)

- [ ] T017 [US4] `backend/app/core/einvoice.py`: `EInvoiceRequest`, `EInvoiceResult`, `EInvoiceProvider`, `StubProvider`, `get_provider()`, `issue_einvoice(session, e_invoice)` (gọi nhà cung cấp, cập nhật trạng thái, lịch gửi lại, audit), `queue_on_paid(session, order)`.
- [ ] T018 [US4] `PUT /orders/{id}/vat-request`, `GET /orders/{id}/e-invoice`, `POST /orders/{id}/e-invoice/retry` (`backend/app/api/v1/orders.py`, `backend/app/schemas/einvoice.py`). Kiểm mã số thuế và email theo research R-7.
- [ ] T019 [US4] Gọi `queue_on_paid` trong `finalize_paid_order` (T007). Đơn `total = 0` giữ `REQUESTED`.
- [ ] T020 [US4] `backend/scripts/send_einvoices.py`: lấy phiếu đến hạn bằng `FOR UPDATE SKIP LOCKED`, gửi từng phiếu, commit từng phiếu, có `--dry-run`, `EINVOICE_PROVIDER=none` thì thoát.
- [ ] T021 [P] [US4] `.github/workflows/send-einvoices.yml`: cron `*/5 * * * *`, runner `[self-hosted, staging]`, concurrency `staging`, có `workflow_dispatch`.
- [ ] T022 [P] [US4] `backend/tests/test_einvoice.py`:
  - đơn PAID + yêu cầu VAT → `PENDING`, 200;
  - đơn chưa PAID → `REQUESTED`, chuyển `PENDING` khi PAID;
  - stub thành công → `ISSUED`, có số hóa đơn;
  - stub lỗi → `RETRYING`, `next_attempt_at` lùi theo lũy thừa; hết 5 lần → `FAILED`, audit ngoại lệ;
  - stub lỗi không làm chậm hay hỏng thanh toán (thanh toán không gọi stub);
  - gửi lại tay: quyền `PAYMENT_REFUND`, bắt buộc lý do, 409 khi phiếu `ISSUED`;
  - mã số thuế sai 422; sửa sau `ISSUED` 409; gửi lại cùng Idempotency-Key;
  - đơn 0đ không tạo phiếu gửi; outlet khác 404.
- [ ] T023 [US4] Test Postgres trong `backend/tests/test_concurrency_postgres.py`: hai lần chạy script cùng lúc, mỗi phiếu chỉ gửi một lần.

## Phase 6: User Story 5 — VAT trên QR (P3, làm nếu còn thời gian)

- [ ] T024 [US5] `PUT /public/qr/{token}/vat-request` trong `backend/app/api/v1/qr.py`, lưu phiếu `REQUESTED` cho đơn đang mở; test mã QR hết hạn, không trả lại dữ liệu đã nhập.

## Phase 7: Polish

- [ ] T025 Thêm `EINVOICE_FAILED`, `EINVOICE_RETRY_MANUAL` vào `EXCEPTION_ACTIONS` (`backend/app/api/v1/audit.py`).
- [ ] T026 Sinh lại `docs/api/openapi.json`, `frontend/src/api/schema.d.ts`, `docs/erd.md`; cập nhật `docs/api/api-catalog.md`.
- [ ] T027 Cập nhật R6 trong `docs/architecture/backlog/0001-backend-viec-con-lai.md`.
- [ ] T028 Viết `quickstart.md` để QA thử trên staging (bật cấu hình, chạy job, bật `EINVOICE_STUB_FAIL`).
- [ ] T029 Báo FE (thay đổi response, 3 ô cấu hình, 2 màn mới) và QA (mặc định tắt, P2-PAY-008 chạy được) sau khi merge.

## Thứ tự và phụ thuộc

- T001–T003 chặn mọi phần.
- US1 (T004–T012) trước, vì US2, US3, US4 đều dùng số tính ra ở đây.
- US2 chỉ là test thêm, làm ngay sau US1.
- US3 và US4 độc lập với nhau sau US1. T017 dùng `build_invoice` của T015 để dựng dữ liệu gửi, nên làm T015 trước T017 nếu một người làm.
- Đề xuất chia PR: PR 1 = Phase 1–3 (tính tiền), PR 2 = Phase 4–5 (hóa đơn, hóa đơn điện tử), PR 3 = Phase 6 nếu làm.
- Câu hỏi PO không chặn việc code: mọi con số đều là cấu hình, mặc định tắt.
