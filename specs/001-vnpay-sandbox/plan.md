# Implementation Plan: Thanh toán VNPay (sandbox)

- **Branch**: `feat/vnpay-sandbox`
- **Date**: 2026-11-12
- **Spec**: [spec.md](spec.md)

## Summary

Thêm hình thức `VNPAY` vào API thanh toán v2 (R1). Luồng xử lý:

1. BE tạo một lần thanh toán ở trạng thái PENDING.
2. BE ký và trả link sang trang thanh toán của VNPay.
3. Kết quả được xác nhận theo thứ tự ưu tiên:
   - QueryDR (BE tự hỏi VNPay), gọi khi trình duyệt khách quay về hoặc khi thu ngân bấm kiểm tra lại;
   - IPN, chỉ dùng khi có HTTPS.
4. Xác nhận thành công thì gọi lại `finalize_paid_order`, cùng hàm R1 đang dùng để chốt đơn.

Một script đối soát chạy định kỳ xử lý các lần thanh toán quá hạn.

## Technical Context

| Mục | Giá trị |
|---|---|
| Language/Version | Python 3.11 |
| Primary Dependencies | FastAPI, SQLAlchemy 2, `httpx` (đã có trong requirements-dev; chuyển sang requirements) để gọi QueryDR |
| Storage | PostgreSQL 16, thêm cột vào bảng `payment` (migration `0013`) |
| Testing | pytest; giả lập VNPay bằng khóa giả + `httpx.MockTransport` cho QueryDR |
| Target Platform | Docker Compose trên staging (http, IP `160.191.47.17`) |
| Performance Goals | Tạo link < 200 ms; xác nhận (gồm QueryDR) < 5 s, thời hạn chờ QueryDR 10 s |
| Constraints | Không HTTPS trên staging; khóa chỉ ở `.env.staging`; không thêm scheduler mới |
| Scale/Scope | 4 endpoint mới, 1 script, 1 workflow, ~1 migration |

## Constitution Check

| Nguyên tắc | Đáp ứng |
|---|---|
| I. BRD, PO chốt | "Payment UNKNOWN handling" theo BRD; hai chỗ chưa rõ ghi `[NEEDS CLARIFICATION]` trong spec |
| II. An toàn khi gửi lại | Tạo link cần Idempotency-Key. Xác nhận khóa theo thứ tự phiên bàn → đơn → thanh toán (dùng `lock_order_for_payment`). Có test đồng thời trên Postgres cho Return + kiểm tra lại cùng lúc |
| III. Phân quyền | Tạo link, kiểm tra lại: `PROCESS_PAYMENT`. Return URL và IPN công khai nhưng chỉ tin dữ liệu có chữ ký, không trả dữ liệu cá nhân |
| IV. Dấu vết | Audit `PAYMENT_LINK_CREATED`, `PAYMENT_CONFIRMED`, `PAYMENT_AMOUNT_MISMATCH` (ngoại lệ), `PAYMENT_LATE_SUCCESS` (ngoại lệ) |
| V. Test, CI | Test luồng chính, chữ ký sai, sửa Return URL, lệch tiền, gửi lại, cách ly outlet; sinh lại `schema.d.ts` |
| VI. Migration | `0013` chỉ thêm cột cho phép null, có downgrade |
| VII. Bí mật | `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET` chỉ trong env; log không ghi `vnp_SecureHash` hay toàn bộ query |
| VIII. Đơn giản | Đối soát bằng script + workflow trên runner sẵn có (như backup), không thêm Celery/Redis |

Không có vi phạm.

## Project Structure

```text
backend/
  app/
    core/
      config.py               # + VNPAY_* (thêm)
      vnpay.py                # ký, kiểm chữ ký, dựng URL, gọi QueryDR (mới)
    api/v1/
      payments.py             # + method VNPAY, /check, /vnpay/return, /vnpay/ipn
    schemas/payments.py       # + payment_url, các trường mới
    db/models.py              # + cột payment
  migrations/versions/
    0013_payment_vnpay.py     # (mới)
  scripts/
    reconcile_vnpay.py        # đối soát lần thanh toán quá hạn (mới)
  tests/
    test_vnpay.py             # (mới)
    test_concurrency_postgres.py  # + Return và kiểm tra lại cùng lúc
.github/workflows/
  reconcile-vnpay.yml         # 10 phút một lần trên runner staging (mới)
infra/compose/compose.staging.yml  # + truyền VNPAY_*
.env.staging.example          # + dòng mẫu
docs/api/api-catalog.md       # mục A17
```

## Thiết kế chính

- **Ký và kiểm chữ ký** (`app/core/vnpay.py`): theo tài liệu VNPay 2.1.0, chi tiết ở [research.md](research.md).
  - Ký: sắp tham số theo tên, URL-encode, nối bằng `&`, ký HMAC-SHA512 bằng `VNPAY_HASH_SECRET`.
  - Kiểm: bỏ `vnp_SecureHash` và `vnp_SecureHashType` khỏi dữ liệu nhận về, ký lại, so bằng `hmac.compare_digest`.
- **Trạng thái:** chi tiết chuyển trạng thái ở [data-model.md](data-model.md).
  - `PENDING` có thể đi tới `SUCCEEDED`, `FAILED`, `EXPIRED` hoặc `UNKNOWN`.
  - `UNKNOWN` có thể đi tới `SUCCEEDED`, `FAILED` hoặc `EXPIRED`.
  - Ba trạng thái `SUCCEEDED`, `FAILED`, `EXPIRED` là kết thúc.
- **Xác nhận** (hàm `confirm_vnpay_payment`), dùng chung cho Return URL, `/check`, IPN và script đối soát:
  1. Khóa phiên bàn, đơn, rồi dòng thanh toán.
  2. Thanh toán đã ở trạng thái kết thúc → trả kết quả cũ, không làm gì thêm.
  3. So số tiền. Lệch → không đóng đơn, ghi audit ngoại lệ.
  4. Thành công:
     - đơn còn BILLING → ghi SUCCEEDED, rồi gọi `finalize_paid_order` nếu đã đủ tiền;
     - đơn đã đóng hoặc lần thanh toán đã bị hủy → ghi `PAYMENT_LATE_SUCCESS` để hoàn tay.
- **Không gọi mạng khi đang giữ khóa:** gọi QueryDR trước, khóa dòng sau, rồi kiểm tra lại trạng thái. Hai request cùng lúc thì có thể cả hai cùng gọi QueryDR, nhưng chỉ một request ghi kết quả.
- **Return URL:**
  - Trả trang HTML đơn giản có nút "Quay lại" hoặc tự chuyển về FE, không trả JSON.
  - Chỉ hiện kết quả và số tiền, không hiện thông tin đơn.
- **IPN:** tắt mặc định (`VNPAY_IPN_ENABLED=false`). Khi tắt thì trả `RspCode=99` để VNPay gửi lại sau, và vẫn ghi log.

## Complexity Tracking

Không có.
