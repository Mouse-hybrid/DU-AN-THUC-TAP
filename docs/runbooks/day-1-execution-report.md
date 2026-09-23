# Day 1 staging execution report

## Hoàn thành

- Khảo sát tài nguyên, phần mềm và cổng mạng của máy chủ staging.
- Tạo cấu trúc nền FastAPI và năm màn hình mock: landing, POS, kitchen, customer, admin.
- Thêm liveness `/health`, readiness `/ready`, mock API và OpenAPI docs.
- Chuẩn bị Dockerfile, PostgreSQL, Nginx reverse proxy và Docker Compose cho staging.
- Chuẩn bị script bootstrap, deploy và quản lý preview tạm thời.
- Chạy lint và 5 automated tests trên Windows và Ubuntu; tất cả đều đạt.
- Đưa preview vào thư mục release riêng trên máy chủ và xác nhận phản hồi HTTP 200.

## Trạng thái hiện tại

- Docker Engine và Docker Compose đã được cài đặt; user `admin` thuộc nhóm `docker`.
- Stack PostgreSQL, FastAPI và Nginx đang chạy bằng Docker Compose.
- Cả PostgreSQL và FastAPI đều báo `healthy`; readiness báo `database: connected`.
- Nginx public ứng dụng trên cổng 80 và đã được kiểm tra HTTP 200 từ bên ngoài server.
- PostgreSQL chỉ nằm trong Docker network, không publish cổng 5432 ra host hoặc Internet.
- Preview tạm trên cổng 8000 và SSH tunnel đã được dừng sau khi Docker staging hoạt động.
- Chưa có domain và TLS.
- Chưa commit, push hoặc merge các thay đổi trong working tree.

## Việc tiếp theo

1. Review và commit/push các thay đổi bằng pull request.
2. Gắn domain staging và bổ sung HTTPS/TLS.
3. Cấu hình backup PostgreSQL và diễn tập restore.
4. Chốt BRD, UX và API contract trước khi phát triển nghiệp vụ.
5. Reboot server trong khung bảo trì để nạp kernel mới, sau khi xác nhận không có dịch vụ khác bị ảnh hưởng.
