# Server inventory staging

- Ngày kiểm tra: 2026-09-21
- Phương thức: SSH và các lệnh chỉ đọc
- Môi trường: Staging

## Tài nguyên

| Hạng mục | Giá trị ghi nhận |
|---|---|
| OS | Ubuntu 22.04.5 LTS |
| Kernel | Linux 5.15.0-187-generic x86_64 |
| CPU | 12 logical CPU |
| RAM | 19 GiB tổng, khoảng 18 GiB available tại thời điểm kiểm tra |
| Swap | 3.8 GiB, chưa sử dụng |
| Root disk | 39 GiB tổng, 8.0 GiB đã dùng, 29 GiB còn trống, 23% sử dụng |
| Boot disk | 974 MiB tổng, 259 MiB đã dùng, 648 MiB còn trống |
| Timezone | Etc/UTC |
| NTP | Đồng bộ |
| Uptime | Khoảng 8 ngày 17 giờ tại thời điểm kiểm tra |

## Truy cập và mạng

- SSH public key hoạt động với tài khoản `admin`.
- Tài khoản thuộc nhóm `sudo`, nhưng lệnh sudo yêu cầu mật khẩu.
- TCP lắng nghe công khai được ghi nhận: SSH trên port đã thống nhất.
- Không ghi nhận HTTP, HTTPS hoặc PostgreSQL đang lắng nghe.
- Trạng thái UFW chưa xác minh được vì cần sudo.

## Phần mềm và dịch vụ

| Thành phần | Trạng thái |
|---|---|
| Git | 2.34.1 |
| Python | 3.10.12 |
| Docker | Chưa cài |
| Docker Compose | Chưa cài |
| Nginx | Chưa cài |
| PostgreSQL client/server | Chưa cài hoặc chưa có trong PATH |
| Failed systemd units | 0 tại thời điểm kiểm tra |

## Phát hiện cần xử lý

1. Server báo `System restart required`; chưa reboot vì cần lịch và phê duyệt.
2. Có nhiều package đang chờ cập nhật; chưa chạy upgrade trong audit Ngày 1.
3. Cấu hình SSH đọc được cho thấy `PermitRootLogin yes`; cần đổi thành `no` sau khi xác nhận đường lui truy cập.
4. `X11Forwarding yes`; staging backend không cần X11 và nên tắt sau khi được duyệt.
5. `PubkeyAuthentication yes`; đây là cấu hình phù hợp và SSH key đã được kiểm chứng.
6. `PasswordAuthentication` không xuất hiện trong phần cấu hình đọc được; cần kiểm tra effective config bằng quyền phù hợp trước khi hardening.
7. Firewall chưa xác minh; không mở 80/443 hoặc cài dịch vụ trước khi biết chính sách hiện tại.
8. Dung lượng root disk khoảng 39 GiB; cần image tối giản, log rotation và theo dõi disk nếu dùng container.

## Quy tắc thay đổi tiếp theo

- Mọi thay đổi có sudo phải được mentor duyệt và có đường rollback.
- Backup cấu hình trước khi sửa SSH, firewall hoặc Nginx.
- Không tắt password/root login trước khi kiểm tra SSH key ở một phiên kết nối thứ hai.
- Không reboot trong phiên làm việc chưa có lịch bảo trì.
- Sau khi cài dịch vụ, chạy lại inventory và cập nhật tài liệu này.
