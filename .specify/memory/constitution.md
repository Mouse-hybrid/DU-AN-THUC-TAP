# Constitution — NOVA POS Backend

- Phiên bản: 1.0.0
- Phê chuẩn: 2026-11-12
- Sửa đổi gần nhất: 2026-11-12

Các nguyên tắc dưới đây đúc kết từ cách dự án đã làm ở Pha 1 và Pha 2. Mọi `spec.md`, `plan.md`, `tasks.md` trong `specs/` phải tuân theo. Một kế hoạch vi phạm nguyên tắc nào thì phải ghi lý do ở mục "Complexity Tracking" của `plan.md`; không có lý do thì sửa kế hoạch, không sửa nguyên tắc.

## Nguyên tắc cốt lõi

### I. BRD là nguồn yêu cầu, PO là người chốt
- Yêu cầu lấy từ Pos System BRD 1.0 và các quyết định PO đã chốt (ghi trong ADR, SDD, hoặc phiếu B1–B6).
- Chỗ BRD chỉ có tiêu đề hoặc mơ hồ thì `spec.md` ghi `[NEEDS CLARIFICATION: …]`, không tự đoán.
- Con số nghiệp vụ chưa chốt (thuế suất, ngưỡng, số lần thử…) đặt qua cấu hình, không viết cứng trong code.

### II. Mọi thao tác ghi đều an toàn khi gửi lại
- API tạo hoặc đổi dữ liệu **bắt buộc** header `Idempotency-Key`. Gửi lại cùng key thì trả đúng kết quả cũ, không ghi hai lần.
- Ghi đồng thời vào cùng dữ liệu phải khóa dòng (`SELECT … FOR UPDATE`) theo **thứ tự cố định**: phiên bàn → đơn → thanh toán → khách hàng.
- Khóa nào chỉ kiểm chứng được trên Postgres thì phải có test trong `tests/test_concurrency_postgres.py`.

### III. Phân quyền tập trung
- Endpoint khai báo quyền bằng `Depends(require_permission(Permission.X))`. Không tự liệt kê role trong endpoint.
- Quyền mặc định nằm ở `app/core/permissions.py`. Quyền thực tế (kể cả các ô Supervisor đã sửa) đọc qua `app/core/rbac.py`.
- Dữ liệu luôn lọc theo `outlet_id` của người gọi. Truy cập khác outlet trả 404, không trả 403.
- API công khai cho khách (QR) nằm dưới `/api/v1/public/`. Nhóm này chỉ nhận mã phiên bàn, không bao giờ trả dữ liệu cá nhân đầy đủ, và có giới hạn số request ở nginx.

### IV. Có dấu vết cho mọi thay đổi quan trọng
- Mọi thao tác ghi nghiệp vụ gọi `write_audit_log` trong cùng transaction.
- Thao tác ngoại lệ (hủy, hoàn, bỏ qua điều kiện, đổi quyền…) phải nằm trong `EXCEPTION_ACTIONS`.
- Lịch sử tiền và điểm chỉ ghi thêm, không sửa, không xóa: sửa sai bằng một dòng đảo ngược (`REVERSAL`) hoặc điều chỉnh (`ADJUST`), luôn kèm lý do.

### V. Test trước khi merge, CI là cổng chặn
- Mỗi tính năng có test API cho luồng chính, lỗi quyền, lỗi trạng thái, gửi lại cùng Idempotency-Key, cách ly outlet.
- Không merge khi CI đỏ. Không dùng quyền admin để vượt ruleset.
- Đổi API thì sinh lại `docs/api/openapi.json` và `frontend/src/api/schema.d.ts` trong cùng PR, và cập nhật `docs/api/api-catalog.md`.

### VI. Thay đổi dữ liệu qua migration có đường lùi
- Đổi schema chỉ qua Alembic, migration có `downgrade()`. Trạng thái dùng `String` + `CHECK`, không dùng ENUM của Postgres.
- Migration chạy được trên dữ liệu staging đang có. Thêm cột bắt buộc thì phải có giá trị mặc định hoặc bước điền dữ liệu.

### VII. Bí mật không vào repo, dữ liệu cá nhân không ra ngoài
- Khóa, mật khẩu, DSN chỉ nằm trong `.env.staging` trên server. Không ghi vào repo, log, chat, ảnh chụp.
- Log và Sentry không chứa body, token, mã QR, số điện thoại. Số điện thoại hiển thị cho khách luôn được che.
- Gọi dịch vụ ngoài (cổng thanh toán, ERP…) phải có thời hạn chờ. Dịch vụ ngoài lỗi thì không làm hỏng dữ liệu bên mình, và có cách đối soát lại.

### VIII. Đơn giản trước
- Chọn cách ít thành phần nhất mà vẫn đúng: một service FastAPI, một Postgres, chạy được trên staging hiện tại.
- Thêm hạ tầng mới (Redis, hàng đợi, scheduler…) chỉ khi spec chứng minh cách cũ không đủ, và ghi vào Complexity Tracking.

## Ràng buộc kỹ thuật

| Mảng | Lựa chọn |
|---|---|
| Ngôn ngữ, framework | Python 3.11, FastAPI, SQLAlchemy 2, Pydantic 2 |
| Dữ liệu | PostgreSQL 16 (test dùng SQLite, phần khóa dùng Postgres trên CI) |
| Xác thực | JWT có `token_version` để thu hồi; khách QR dùng mã theo phiên bàn |
| Realtime | WebSocket, event chỉ báo "có thay đổi", client gọi lại REST |
| Triển khai | Docker Compose trên staging, tự deploy khi merge vào `main` |
| Tiền | `Numeric(12,2)`, đơn vị VND, không dùng số thực |
| Giờ | Lưu UTC, hiển thị và gom ngày theo giờ Việt Nam (UTC+7) |

## Quy trình làm một tính năng

1. `spec.md`: làm gì, vì sao, nghiệm thu thế nào. Ghi rõ chỗ cần PO chốt.
2. `plan.md` (kèm `research.md`, `data-model.md`, `contracts/`): làm thế nào. Qua Constitution Check.
3. `tasks.md`: việc nhỏ, có thứ tự. Mỗi việc ghi file sẽ sửa.
4. Code trên nhánh `feat/<tên>` tạo từ `main`, PR nhỏ, mô tả theo mẫu: Tóm tắt, Chi tiết, Hạn chế, Kiểm thử, Sau khi merge.
5. Merge xong thì cập nhật trạng thái trong `docs/architecture/sdd/0001-backend-viec-con-lai.md`.

## Quản trị

- Constitution được ưu tiên hơn mọi tài liệu khác trong `specs/`.
- Sửa constitution qua PR riêng, ghi lý do. Tăng phiên bản theo quy tắc:
  - **MAJOR:** bỏ hoặc đổi nghĩa một nguyên tắc.
  - **MINOR:** thêm nguyên tắc.
  - **PATCH:** sửa câu chữ.
- Người review PR kiểm tra mục Constitution Check trong `plan.md` có khớp với code không.
