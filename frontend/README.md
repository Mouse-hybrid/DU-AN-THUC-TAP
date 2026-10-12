# NOVA POS Frontend

Frontend độc lập dùng Vite, React và TypeScript strict. Ứng dụng gọi API thật, không có mock data và không dùng CDN.

## Yêu cầu

- Node.js 24 trở lên (xem `.nvmrc`)
- npm
- Backend NOVA POS đang chạy và cho phép origin của frontend

## Cài đặt và chạy

```powershell
cd frontend
Copy-Item .env.example .env.local
npm ci
npm run dev
```

Mở `http://localhost:5173/login`. Vite cố định cổng `5173`; nếu cổng đang bận, lệnh sẽ báo lỗi thay vì tự đổi cổng.

`VITE_API_BASE_URL` phải trỏ tới gốc API có `/api/v1`, ví dụ:

```dotenv
VITE_API_BASE_URL=http://160.191.47.17/api/v1
```

Nếu không cấu hình biến này, ứng dụng dùng `/api/v1` trên cùng origin. Khi triển khai production với `BrowserRouter`, web server cần trả `index.html` cho các route `/login`, `/tables`, `/tables/:id/open` và `/kitchen`.

## Các lệnh

```powershell
npm run dev
npm run lint
npm run typecheck
npm run build
npm run gen:api
```

`npm run gen:api` sinh lại `src/api/schema.d.ts` từ `../docs/api/openapi.json`. Không sửa tay file sinh ra.

## Route và phân quyền

- `/login`: đăng nhập bằng mã nhân viên và mã PIN.
- `/tables`: sơ đồ bàn, lọc trạng thái và làm mới.
- `/tables/:id/open`: mở bàn với duy nhất `guest_count` từ 1 đến 100.
- `/kitchen`: trang tạm “Màn bếp sắp có”.
- Role `KITCHEN` chỉ truy cập `/kitchen`; các role khác chỉ truy cập luồng POS.

Token được lưu trong `localStorage` với key `pos_auth` cùng thời điểm hết hạn. Không lưu mật khẩu. Các request thay đổi dữ liệu dùng một `Idempotency-Key` cho toàn bộ lần thử lại của cùng một thao tác.

## Checklist kiểm tra tay

1. Mở `/login`, thử để trống từng ô và xác nhận có lỗi tiếng Việt.
2. Tắt mạng, thử đăng nhập và xác nhận banner “Đang ngoại tuyến” cùng thông báo lỗi.
3. Đăng nhập role thường, xác nhận vào `/tables`; mở thẳng `/kitchen` phải quay lại `/tables`.
4. Đăng nhập role `KITCHEN`, xác nhận vào `/kitchen`; mở thẳng `/tables` hoặc `/tables/<id>/open` phải quay lại `/kitchen`.
5. Ở `/tables`, kiểm tra đủ chữ và màu của 8 trạng thái, bộ lọc, loading, empty, error và nút “Thử lại”.
6. Chọn bàn `AVAILABLE`, tăng/giảm số khách ở biên 1 và 100, bấm “Mở bàn”; xác nhận request chỉ có `guest_count` và nút bị khóa lúc gửi.
7. Sau khi mở bàn thành công, xác nhận quay về `/tables` và hiện “Đã mở bàn”.
8. Giả lập lỗi FastAPI 422 có `detail` dạng mảng và xác nhận thông báo không chứa `[object Object]`.
9. Xóa hoặc làm hết hạn `pos_auth`, mở route bảo vệ và xác nhận quay về `/login`.
