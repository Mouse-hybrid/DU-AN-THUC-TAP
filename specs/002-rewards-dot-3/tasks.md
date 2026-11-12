# Tasks: Rewards đợt 3

- **Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/rewards-dot-3.md](contracts/rewards-dot-3.md)
- **Ký hiệu**: `[P]` = làm song song được; `[US1]`… = thuộc user story nào.
- **Ước lượng**: khoảng 1,5 ngày làm.
- **Tiến độ (12/11)**: xong trừ T011 (đo hiệu năng) và phần báo FE ở T018. T006 chỉ chạy trên Postgres của CI.

## Phase 1: Foundational

- [x] T001 Migration `backend/migrations/versions/0012_rewards_dot3.py`:
  - thêm `EXPIRE` vào CHECK `entry_type`;
  - thêm `table_session.pending_member_phone`, `qr_member_attempts`;
  - có downgrade, nhưng downgrade từ chối nếu đã có dòng `EXPIRE`.
- [x] T002 Cập nhật `POINTS_ENTRY_TYPE` và `TableSession` trong `backend/app/db/models.py`; thêm `QR_MEMBER_MAX_ATTEMPTS` vào `backend/app/core/config.py`.

## Phase 2: User Story 1 — hoàn điểm (P1) 🎯

- [x] T003 [US1] `reverse_order_points(session, order, staff_id)` trong `backend/app/core/loyalty.py`:
  - ghi một dòng `REVERSAL` gộp;
  - chặn số dư âm;
  - chuyển `order_reward` sang `REVERSED`;
  - giảm `used_count`.
- [x] T004 [US1] Gọi T003 trong `refund_payment` (`backend/app/api/v1/payments.py`) khi tổng hoàn bằng tổng đã thu.
- [x] T005 [P] [US1] Test trong `backend/tests/test_rewards_dot3.py`:
  - 4 tổ hợp có/không đổi điểm × có/không tích điểm;
  - hoàn một phần không đổi điểm;
  - số dư không đủ → audit shortfall;
  - khách bị khóa vẫn đảo;
  - hoàn hết hai lần không đảo hai lần.
- [x] T006 [US1] Test Postgres: hoàn tiền đơn A và đổi điểm đơn B của cùng khách chạy cùng lúc, số dư cuối đúng.

## Phase 3: User Story 2 — hết hạn điểm (P1)

- [x] T007 [US2] `expire_points_for_customer(session, customer, now)` trong `backend/app/core/loyalty.py`, theo công thức ở research R-3.
- [x] T008 [US2] `backend/scripts/expire_points.py`:
  - chạy theo từng outlet;
  - commit theo lô 500 khách;
  - có `--dry-run`;
  - chỉ chạy ở development, staging, test, production.
- [x] T009 [P] [US2] `.github/workflows/expire-points.yml`: cron 03:00 giờ Việt Nam, runner `[self-hosted, staging]`, concurrency `staging`, có `workflow_dispatch`.
- [x] T010 [P] [US2] Test:
  - ví dụ ở research R-3;
  - chạy lại không trừ thêm;
  - luật không đặt hạn;
  - `ADJUST` dương không hết hạn;
  - lô của đơn đã đảo không tính.
- [ ] T011 [US2] Đo trên dữ liệu giả 10.000 khách: dưới 1 phút (SC-003). Ghi kết quả vào PR. **Chưa đo** — làm khi chạy test tải trên staging.

## Phase 4: User Story 3 — số điện thoại trên QR (P2)

- [x] T012 [US3] `POST /public/qr/{token}/member` trong `backend/app/api/v1/qr.py`: kiểm phiên, giới hạn lần thử, gắn thành viên hoặc giữ số chờ, phản hồi giống nhau.
- [x] T013 [US3] `GET /orders/{id}/pending-member` và trường `has_pending_member` trong chi tiết đơn/bàn (`backend/app/api/v1/orders.py`, `backend/app/schemas/orders.py`).
- [x] T014 [US3] Xóa `pending_member_phone` khi thu ngân gắn khách (`attach_customer`) và khi phiên đóng (`finalize_paid_order`).
- [x] T015 [P] [US3] Test:
  - thành viên được gắn;
  - không thành viên chỉ giữ số;
  - phản hồi hai trường hợp giống hệt nhau;
  - bàn đã có khách khác;
  - giới hạn 5 lần;
  - số sai định dạng không tính lần;
  - mã QR hết hạn → 404;
  - khách bị khóa không được gắn;
  - thu ngân xem số chờ cần `CUSTOMER_ACCESS`.

## Phase 5: Polish

- [x] T016 Thêm `POINTS_REVERSED`, `POINTS_REVERSAL_SHORTFALL` vào `EXCEPTION_ACTIONS`.
- [x] T017 Sinh lại `docs/api/openapi.json`, `frontend/src/api/schema.d.ts`, `docs/erd.md`; cập nhật `docs/api/api-catalog.md` (mục A10, A12, A17).
- [ ] T018 Cập nhật trạng thái R5 trong `docs/architecture/sdd/0001-backend-viec-con-lai.md`; báo FE hai thay đổi giao diện: ô nhập số trên trang QR, nhắc "Khách có nhập số điện thoại" ở màn thanh toán.

## Thứ tự và phụ thuộc

- T001–T002 chặn mọi phần.
- Sau đó ba story độc lập với nhau, làm theo thứ tự ưu tiên: US1 → US2 → US3.
- Câu hỏi FR-004 (hoàn một phần có thu điểm theo tỉ lệ không) không chặn việc làm: mặc định không thu. PO đổi ý thì thêm một nhánh ở T003.
