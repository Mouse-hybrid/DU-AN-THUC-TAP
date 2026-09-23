# Checklist Ngày 1: Nền tảng staging

## Mục tiêu

Chốt server hiện tại là staging, ghi nhận hiện trạng bằng thao tác chỉ đọc, xác định blocker và chuẩn bị đầu vào cho scaffold repository ở Ngày 2.

## Đã hoàn thành

- [x] Xác nhận repository local sạch và đang đồng bộ với `origin/main`.
- [x] Xác nhận SSH bằng public key hoạt động với tài khoản `admin`.
- [x] Ghi nhận OS, kernel, CPU, RAM, swap, disk, timezone và trạng thái NTP.
- [x] Ghi nhận port TCP đang lắng nghe và systemd failed units.
- [x] Kiểm tra sự hiện diện của Docker, Nginx và PostgreSQL.
- [x] Kiểm tra trạng thái reboot và danh sách package có bản cập nhật.
- [x] Ghi quyết định server là staging trong ADR 0001.
- [x] Ghi nhận cấu hình SSH cần hardening.

## Cần mentor xác nhận trước khi thay đổi server

- [ ] Cho phép cài Docker Engine và Docker Compose hay yêu cầu dùng systemd.
- [ ] Cho phép cài Nginx và PostgreSQL trên server staging.
- [ ] Cung cấp quyền sudo hoặc thống nhất người thực hiện các lệnh cần sudo.
- [ ] Cho phép tạo tài khoản deploy riêng, không vận hành ứng dụng bằng `admin` hoặc `root`.
- [ ] Xác nhận thời điểm reboot để áp dụng cập nhật hệ thống đang chờ.
- [ ] Cho phép hardening SSH: tắt root login, tắt X11 forwarding và xác nhận chính sách password authentication.
- [ ] Xác nhận firewall đang dùng và rule được phép mở cho HTTP/HTTPS.
- [ ] Cấp domain/subdomain staging và owner cập nhật DNS, nếu muốn HTTPS trong tuần đầu.
- [ ] Xác nhận bộ dữ liệu mock và phạm vi trang demo: Landing, POS, Kitchen, Customer, Admin.

## Việc bảo mật bắt buộc

- [ ] Rotate mật khẩu đã từng xuất hiện trong ảnh/chat.
- [ ] Tiếp tục dùng SSH key; không đưa private key hoặc password vào repository.
- [ ] Không public PostgreSQL port 5432.
- [ ] Không chạy FastAPI trực tiếp bằng user `root` hoặc `admin` trong phương án vận hành dài hạn.
- [ ] Không nâng cấp package, đổi SSH config, firewall hoặc reboot khi chưa có lịch và phê duyệt.

## Đầu ra Ngày 1

- ADR xác định môi trường staging.
- Server inventory có bằng chứng kiểm tra và danh sách rủi ro.
- Danh sách quyết định mentor cần trả lời.
- Backlog Ngày 2: chuẩn hóa cấu trúc repository, cấu hình môi trường, readiness endpoint, PostgreSQL connection và CI.

## Phát hiện trong repository

- Repository hiện chỉ có FastAPI health endpoint, một test và backend CI cơ bản.
- `backend/README.md` vẫn mô tả stack là thử nghiệm và chưa có PostgreSQL/UI; cần cập nhật ở Ngày 2 vì công nghệ đã được chốt.
- Backend CI chạy khi có pull request vào `main`, nhưng push trigger vẫn giới hạn ở branch bootstrap cũ; cần sửa khi chuẩn hóa workflow.
- Virtual environment local đang được ignore đúng và không được đưa vào Git.
- Baseline hiện tại đạt: pytest `1 passed`, Ruff `All checks passed`; còn một deprecation warning từ thư viện Starlette/AnyIO.

## Trạng thái

Ngày 1 hoàn thành phần audit không phá vỡ hệ thống. Phần hardening và cài đặt đang **blocked by approval** vì tài khoản sudo yêu cầu mật khẩu và các thay đổi có thể ảnh hưởng khả năng truy cập server.
