# NOVA POS frontend — Batch 1

Frontend tĩnh, không có bước build và không cần cài package. Batch này gồm đúng ba luồng: đăng nhập, sơ đồ bàn và mở bàn.

## Chạy local

Mở PowerShell tại thư mục `frontend/` rồi chạy:

```powershell
py -m http.server 5173
```

Truy cập: <http://localhost:5173/login.html>

`assets/js/config.js` đang đặt:

- `API_BASE_URL = "http://127.0.0.1:8000"`
- `USE_MOCK = true`

Đổi `USE_MOCK` thành `false` khi muốn gọi backend local. Bootstrap 5.3.3 và icon SVG Lucide đã được lưu local, không cần Internet lúc chạy.

## Dữ liệu mock và giả lỗi

- Mock login chấp nhận mọi `username` và `password` không rỗng.
- Role mặc định là `CASHIER`. Thử role khác bằng `login.html?mock_role=WAITER`, `KITCHEN` hoặc `SUPERVISOR`.
- Role `KITCHEN` được chuyển đến `kitchen.html` và không thể mở `tables.html` hoặc `open-table.html`.
- Mock bàn có đủ tám trạng thái trong schema: `AVAILABLE`, `OCCUPIED`, `BILLING`, `PAID`, `CLEANING`, `RESERVED`, `DELAYED`, `MERGED`.
- Thêm query `mock_error=401`, `403`, `409`, `422`, `500`, `network` hoặc `empty` để thử trạng thái lỗi. Ví dụ: `tables.html?mock_error=500`.
- Có thể đặt `sessionStorage.nova_mock_error` cùng các giá trị trên để lỗi tiếp tục qua nhiều trang. Xoá key đó để trở lại bình thường.
- Mock state bàn được giữ trong `sessionStorage` để bàn vừa mở chuyển sang `OCCUPIED` khi quay lại danh sách.

## Checklist kiểm tra tay

### Chung

- [ ] Chạy được từ HTTP server, không mở file trực tiếp bằng `file://`.
- [ ] Ngắt mạng: banner “Đang ngoại tuyến” xuất hiện.
- [ ] Giao diện dùng được ở 1280×800 và từ chiều rộng 768px.
- [ ] Tab bằng bàn phím thấy focus rõ, nút và ô nhập cao tối thiểu 48px.

### Đăng nhập

- [ ] Bỏ trống từng ô: hiện lỗi tại client, không gửi request.
- [ ] Nút Hiện/Ẩn đổi đúng trạng thái mã PIN.
- [ ] Khi gửi: khoá nút và hai ô nhập, không ghi password/token ra console.
- [ ] Mock thành công lưu `localStorage.pos_auth` với `expires_at`.
- [ ] Role `CASHIER`/`WAITER` vào sơ đồ bàn; `KITCHEN` vào `kitchen.html` và thấy “Màn bếp sắp có”.
- [ ] Khi đang đăng nhập bằng role `KITCHEN`, mở trực tiếp `tables.html` hoặc `open-table.html?table_id=...` đều quay về `kitchen.html`.
- [ ] Thử `mock_error=401`, `500`, `network`.

### Sơ đồ bàn

- [ ] Hiện đúng code, số chỗ, số khách, thời gian mở bàn và badge màu + chữ.
- [ ] Bộ lọc hoạt động với đủ tám trạng thái.
- [ ] Nút Làm mới có trạng thái đang tải.
- [ ] Bàn `AVAILABLE` mở trang `open-table.html?table_id=...`.
- [ ] Bàn trạng thái khác hiện “Chi tiết bàn sắp có”.
- [ ] Thử `mock_error=empty`, `403`, `500`, `network`; trạng thái error có nút Thử lại.

### Mở bàn

- [ ] Nút +/- và nhập tay chỉ chấp nhận số nguyên từ 1 đến 100.
- [ ] Khi gửi: nút và bộ đếm bị khoá.
- [ ] POST có `Idempotency-Key`; retry nội bộ của cùng lần bấm dùng lại key đó.
- [ ] Thành công quay về sơ đồ và hiện “Đã mở bàn”.
- [ ] Thử `mock_error=403`, `409`, `422`, `500`, `network`.

## Khoảng trống giữa Figma và API

Không triển khai các phần sau vì API hiện chưa có field tương ứng:

- Khu vực bàn như Khu chung, VIP, Ngoài trời.
- Ghi chú khi mở bàn.
- Chọn nhân viên phục vụ.
- Chọn khách thành viên/tên khách.
- WebSocket cập nhật bàn theo thời gian thực.

## Giả định của batch

- Tên chi nhánh “Chi nhánh Quận 1” chỉ là nhãn giao diện vì `TableDashboardItem` không trả outlet; không gửi nó lên API.
- `OpenSessionRequest.guest_count` áp dụng giới hạn 1–100 theo OpenAPI.
- Backend quyết định quyền mở bàn. UI vẫn cho người đã đăng nhập đi tới thao tác và hiển thị lỗi 403 rõ ràng nếu role không được phép.
- Một lần bấm tạo một UUID idempotency mới; retry tự động do timeout/mất kết nối của chính lần bấm đó dùng lại UUID.
- Thời lượng mở bàn được tính theo thời gian trình duyệt từ `opened_at`.
