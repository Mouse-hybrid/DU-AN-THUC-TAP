# ADR 0001: Sử dụng server hiện tại làm môi trường staging

- Trạng thái: Accepted
- Ngày: 2026-09-21
- Người quyết định: Backend Developer, chờ mentor xác nhận các quyền vận hành

## Bối cảnh

Dự án đang ở giai đoạn dựng nền. Repository mới có FastAPI health endpoint và CI cơ bản; chưa có PostgreSQL, giao diện, xác thực, nghiệp vụ POS hoặc quy trình vận hành production. Mentor yêu cầu đưa một số trang mock lên server để nhóm có giao diện nền trước khi phát triển chức năng chi tiết.

## Quyết định

Server hiện tại được sử dụng làm **staging**, không phải production.

- Chỉ sử dụng dữ liệu mock hoặc dữ liệu mẫu đã loại bỏ thông tin nhạy cảm.
- Cho phép deploy thường xuyên để demo, kiểm thử tích hợp và nghiệm thu nội bộ.
- Không cho người dùng thật sử dụng và không lưu dữ liệu kinh doanh thật.
- Nginx sẽ là điểm truy cập web/API khi được mentor cho phép cài đặt.
- PostgreSQL chỉ lắng nghe trên localhost hoặc private container network; không public cổng 5432.
- Ưu tiên Docker Compose nếu mentor cho phép. Phương án dự phòng là Python virtual environment, systemd và Nginx.
- Production sau này phải có môi trường, secret, database, domain, backup và quy trình deploy tách biệt.

## Kiến trúc nền dự kiến

```text
Browser
  /             Landing page
  /pos          POS mock shell
  /kitchen      Kitchen mock shell
  /customer     Customer mock shell
  /admin        Admin mock shell
       |
       v
Nginx staging
  |-- static web shells
  `-- /api --> FastAPI --> PostgreSQL private
```

## Hệ quả

### Tích cực

- Có URL demo sớm nhưng không tạo kỳ vọng đây là bản go-live.
- Cho phép thử deploy, migration, restart và rollback với rủi ro thấp hơn production.
- Cấu hình được thiết kế để có thể dựng lại production trên máy khác.

### Hạn chế

- Server staging có thể gián đoạn trong lúc thử nghiệm.
- Domain và HTTPS phụ thuộc quyền DNS của mentor.
- Chưa thể chốt Docker hay systemd cho đến khi mentor xác nhận quyền cài đặt.

## Điều kiện để thay đổi quyết định

Không đổi server thành production chỉ vì trang mock truy cập được. Muốn sử dụng production cần một ADR mới và tối thiểu phải có: phân quyền, HTTPS, quản lý secret, backup/restore đã thử, monitoring, rollback, kiểm thử bảo mật và nghiệm thu nghiệp vụ.
