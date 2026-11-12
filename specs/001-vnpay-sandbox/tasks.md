# Tasks: Thanh toán VNPay (sandbox)

- **Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/payments-vnpay.md](contracts/payments-vnpay.md)
- **Ký hiệu**: `[P]` = làm song song được (khác file, không phụ thuộc nhau); `[US1]`… = thuộc user story nào.
- **Ước lượng**: khoảng 2 ngày làm.

## Phase 1: Setup

- [ ] T001 Thêm `VNPAY_*` vào `backend/app/core/config.py`, `.env.staging.example`, `infra/compose/compose.staging.yml`
- [ ] T002 [P] Chuyển `httpx==0.27.2` từ `backend/requirements-dev.txt` sang `backend/requirements.txt`

## Phase 2: Foundational (chặn mọi user story)

- [ ] T003 Migration `backend/migrations/versions/0013_payment_vnpay.py`: thêm cột và chỉ mục theo data-model; cập nhật `Payment` trong `backend/app/db/models.py`
- [ ] T004 `backend/app/core/vnpay.py`: `build_payment_url`, `verify_signature`, `query_transaction` (QueryDR, thời hạn chờ 10 giây)
- [ ] T005 [P] Unit test ký/kiểm chữ ký với bộ tham số mẫu, và QueryDR giả lập bằng `httpx.MockTransport`, trong `backend/tests/test_vnpay.py`
- [ ] T006 Hàm `confirm_vnpay_payment(session, payment_id, result, source)` trong `backend/app/api/v1/payments.py`: khóa theo thứ tự, kết quả idempotent, so số tiền, gọi `finalize_paid_order`, ghi audit

## Phase 3: User Story 1 — khách trả qua VNPay (P1) 🎯 MVP

- [ ] T007 [US1] Mở `CreatePaymentRequest` nhận `VNPAY`; tạo `PENDING` + `payment_url`; trả lại lần đang chờ nếu chưa hết hạn; giữ chỗ số tiền khi tính số còn được thu
- [ ] T008 [US1] `GET /payments/vnpay/return`: kiểm chữ ký → QueryDR → `confirm_vnpay_payment` → trang HTML
- [ ] T009 [P] [US1] Test: tạo link, quay về thành công, khách hủy, sửa Return URL, lệch số tiền, thiếu cấu hình (503), cách ly outlet

**Checkpoint**: chạy được trên sandbox với thẻ test (quickstart).

## Phase 4: User Story 2 — kiểm tra lại, đối soát (P2)

- [ ] T010 [US2] `POST /payments/{id}/check` (quyền `PROCESS_PAYMENT`, Idempotency-Key)
- [ ] T011 [US2] `backend/scripts/reconcile_vnpay.py`: lấy các lần `PENDING`/`UNKNOWN` quá hạn, hỏi VNPay, chuyển `SUCCEEDED`/`FAILED`/`EXPIRED`/`UNKNOWN`
- [ ] T012 [P] [US2] `.github/workflows/reconcile-vnpay.yml`: 10 phút một lần trên runner `[self-hosted, staging]`, cùng nhóm concurrency `staging`
- [ ] T013 [P] [US2] Test: kiểm tra lại khi đã trả hoặc chưa trả, VNPay không trả lời (502, giữ trạng thái), đối soát hết hạn, thanh toán tới sau khi hủy (`PAYMENT_LATE_SUCCESS`)
- [ ] T014 [US2] Test Postgres trong `backend/tests/test_concurrency_postgres.py`: Return URL và kiểm tra lại cùng lúc → đơn đóng một lần

## Phase 5: User Story 3 — IPN (P3)

- [ ] T015 [US3] `GET /payments/vnpay/ipn`, trả `RspCode` theo research R-4; `VNPAY_IPN_ENABLED=false` thì trả `99`
- [ ] T016 [P] [US3] Test: `00`, IPN gửi lại → `02`, sai chữ ký → `97`, sai số tiền → `04`, không tìm thấy → `01`, đang tắt → `99`

## Phase 6: Polish

- [ ] T017 Thêm `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_LATE_SUCCESS` vào `EXCEPTION_ACTIONS` (`backend/app/api/v1/audit.py`)
- [ ] T018 Sinh lại `docs/api/openapi.json`, `frontend/src/api/schema.d.ts`, `docs/erd.md`; cập nhật `docs/api/api-catalog.md` mục A17
- [ ] T019 Cập nhật trạng thái R2 trong `docs/architecture/sdd/0001-backend-viec-con-lai.md`
- [ ] T020 Chạy quickstart trên staging với tài khoản sandbox; ghi kết quả vào PR

## Thứ tự và phụ thuộc

- T001–T002, rồi T003–T006, chặn mọi story.
- US1 (T007–T009) là MVP. US2 cần T006 và T007. US3 chỉ cần T006.
- Việc của FE (màn 21, 49–51, nút "Kiểm tra lại") bắt đầu được ngay khi T007 có trong `schema.d.ts`.
