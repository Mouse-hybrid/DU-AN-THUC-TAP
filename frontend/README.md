# NOVA POS Frontend

Frontend độc lập dùng Vite, React và TypeScript strict. Ứng dụng gọi API thật, không có mock data và không dùng CDN. Không dùng thư viện UI; style là CSS thuần với token `--nova-*`.

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

Nếu không cấu hình biến này, ứng dụng dùng `/api/v1` trên cùng origin. WebSocket dùng cùng gốc với API (đổi `http` thành `ws`, `https` thành `wss`). Khi triển khai production với `BrowserRouter`, web server cần trả `index.html` cho mọi route ở bảng dưới.

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

| Route | Màn | Vai trò được vào |
|---|---|---|
| `/login` | Đăng nhập (`/login?area=kitchen` dùng lời dẫn của màn bếp) | Chưa đăng nhập |
| `/tables` | Sơ đồ bàn | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id` | Chi tiết bàn | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/open` | Mở bàn (chỉ `guest_count`, 1–100) | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/order` | Gọi món (màn 09) | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/search` | Tìm món nhanh (màn 12) | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/summary` | Tóm tắt đơn, yêu cầu thanh toán, xác nhận thanh toán | CASHIER, WAITER, SUPERVISOR |
| `/kitchen` | Màn bếp, gồm tab Món trễ (màn 33) | KITCHEN, SUPERVISOR |
| `/admin/menu/categories` | Nhóm món và danh sách món (màn 102) | SUPERVISOR |
| `/admin/menu/new` | Thêm món (màn 103) | SUPERVISOR |
| `/admin/menu/:id/edit` | Sửa món (màn 103) | SUPERVISOR |

- `KITCHEN` bị chuyển về `/kitchen` nếu mở route POS hoặc `/admin`. CASHIER/WAITER mở `/kitchen` hoặc `/admin` thì quay về `/tables`.
- Chưa đăng nhập mà mở `/kitchen` thì chuyển tới `/login?area=kitchen`; sau khi đăng nhập, mọi role đều về trang chủ của role đó.
- Phân quyền ở FE chỉ để ẩn nút và chặn route. Backend vẫn là nơi quyết định (lỗi 403 được hiển thị bằng tiếng Việt).

Quyền theo hành động (theo code hiện tại):

| Hành động | Role |
|---|---|
| Mở bàn, thêm/sửa/xóa món, gửi bếp | CASHIER, WAITER, SUPERVISOR |
| Dọn xong bàn, Lấy món, Đã mang ra | WAITER, SUPERVISOR |
| Yêu cầu thanh toán | CASHIER, WAITER, SUPERVISOR |
| Xác nhận đã thanh toán | CASHIER, SUPERVISOR |
| Bắt đầu nấu, Món xong | KITCHEN, SUPERVISOR |
| Tạo/sửa nhóm món, tạo/sửa món | SUPERVISOR |

Token được lưu trong `localStorage` với key `pos_auth` cùng thời điểm hết hạn. Không lưu mật khẩu.

## Cách gọi API

- Mọi request đi qua `src/api/client.ts`: timeout 12 giây, thử lại 1 lần cho lỗi mạng/timeout, lỗi trả về là `ApiError` có `status`. `status = 0` nghĩa là offline hoặc timeout.
- Mọi `POST`, `PATCH`, `DELETE` bắt buộc có `Idempotency-Key`. Handler tạo khóa bằng `createIdempotencyKey()` (UUID v4, có phương án dự phòng khi trình duyệt không có `crypto.randomUUID`) và dùng đúng một khóa cho mọi lần thử lại của cùng thao tác. Hai thao tác khác nhau luôn dùng hai khóa khác nhau.
- Mọi nút ghi dữ liệu có trạng thái bận, chặn bấm đúp bằng `useRef`, dùng `try/finally`, không gửi request khi đang offline và giữ nguyên dữ liệu đang hiển thị khi lỗi.
- Lỗi 401 chuyển về `/login`; 403, 404, 409, 422 (kể cả `detail` dạng mảng), timeout, offline và 5xx đều có câu tiếng Việt. Không bao giờ hiện `[object Object]`.
- Tiền hiển thị bằng `Intl.NumberFormat("vi-VN")`. Giá gửi lên API là chuỗi thập phân (ví dụ `"52000"`), tối đa 2 chữ số thập phân, lớn hơn 0.

## Thời gian thực

`src/realtime/useRealtime.ts` kết nối `GET /api/v1/ws?token=...&channel=tables|kitchen`. Tin nhắn có dạng `{type, channel, data, at}`.

- Sơ đồ bàn và chi tiết bàn nghe kênh `tables` (`TABLE_SESSION_OPENED`, `TABLE_STATUS_CHANGED`, `ORDER_UPDATED`). Màn bếp nghe kênh `kitchen` (`KITCHEN_QUEUE_UPDATED`, `ORDER_ITEM_STATUS_CHANGED`, `ORDER_ITEM_VOIDED`, `ORDER_ITEM_REFIRED`). Sự kiện không thuộc danh sách bị bỏ qua.
- Sự kiện chỉ là tín hiệu: màn hình tải lại dữ liệu bằng REST, không tự vá dữ liệu từ nội dung sự kiện.
- Rớt kết nối thì tự nối lại với backoff có jitter (tối đa 15 giây) và tải lại dữ liệu sau khi nối lại. Khi offline hoặc tab bị ẩn, FE không nối lại; có mạng hoặc tab hiện lại thì nối ngay. Luôn chỉ có một socket cho mỗi màn, rời màn thì đóng socket và dọn timer.
- Polling dự phòng: sơ đồ bàn 5 giây khi không có WebSocket, 30 giây khi WebSocket đang nối; màn bếp tương tự. Polling không chồng request, tạm dừng khi tab ẩn, khi offline hoặc khi đang có thao tác ghi.
- Token nằm trong URL WebSocket nên FE không in URL này ra console.

## Giới hạn hiện tại của màn quản trị thực đơn (102, 103)

API hiện chỉ có `name`, `price`, `category_id`, `station_id`, `is_available` cho món và `name`, `sort_order`, `is_active` cho nhóm món. Vì vậy các trường trong thiết kế như ảnh, mô tả, nhãn món, hiển thị trên QR, topping không có ô nhập giả; màn 103 hiện một dòng ghi chú “chưa được API hỗ trợ”. Khi backend bổ sung, chạy `npm run gen:api` rồi thêm trường.

Màn 12 tìm món theo tên (`GET /menu?q=`). Backend chưa có tìm theo mã SKU nên ô tìm kiếm ghi “Tìm theo tên món”.

Các màn thuộc Pha 2 chưa được code; xem `PHASE2-READINESS.md`.

## Checklist kiểm tra tay (Pha 1)

Đăng nhập và phân quyền
1. Mở `/login`, để trống từng ô và xác nhận có lỗi tiếng Việt. Nhập sai PIN và xác nhận câu “Mã nhân viên hoặc mã PIN không đúng.”.
2. Tắt mạng, thử đăng nhập và xác nhận banner “Đang ngoại tuyến” cùng thông báo lỗi.
3. CASHIER/WAITER: vào `/tables`; mở thẳng `/kitchen` hoặc `/admin/menu/categories` phải quay về `/tables`.
4. KITCHEN: vào `/kitchen`; mở `/tables` hoặc `/admin/menu/categories` phải quay về `/kitchen`. Chưa đăng nhập mà mở `/kitchen` phải tới `/login?area=kitchen` (“Sẵn sàng cho ca bếp”).
5. SUPERVISOR: vào được `/tables`, `/kitchen` và `/admin/menu/categories`; menu có mục “Thực đơn”.
6. Xóa hoặc làm hết hạn `pos_auth`, mở route bảo vệ và xác nhận quay về `/login`.

Sơ đồ bàn, mở bàn, chi tiết bàn
7. `/tables`: đủ chữ và màu của 8 trạng thái, bộ lọc, loading, empty, error và nút “Thử lại”.
8. Bàn Đang dọn: WAITER thấy “Dọn xong”, CASHIER không thấy. Bấm một lần chỉ gửi một request.
9. Bàn Trống: tăng/giảm số khách ở biên 1 và 100, bấm “Mở bàn”; request chỉ có `guest_count`, nút bị khóa lúc gửi; xong quay về `/tables` và hiện “Đã mở bàn”.
10. Chi tiết bàn: món Sẵn sàng có nút “Lấy món”, món đã lấy có “Đã mang ra” (chỉ WAITER/SUPERVISOR).

Gọi món, tìm món (màn 09, 12), thanh toán
11. `/tables/:id/order`: thêm món, gửi bếp. Có nút “Tìm món” dẫn tới `/tables/:id/search`.
12. Màn 12: gõ tên món (chờ khoảng 0,3 giây mới gọi API), đổi nhóm món, món “Hết món” không thêm được, tìm không ra thì hiện “Không tìm thấy món”. Gõ nhanh nhiều chữ: kết quả cũ không đè kết quả mới.
13. Màn 12: bàn chưa có đơn, thêm món đầu tiên phải tạo đơn một lần; thêm tiếp dùng lại đơn. Bấm đúp “Thêm vào đơn” chỉ thêm một lần. Bàn Chờ thanh toán chỉ xem.
14. `/tables/:id/summary`: “Yêu cầu thanh toán” (có hộp xác nhận), rồi “Xác nhận đã thanh toán” (CASHIER/SUPERVISOR).
15. Giả lập lỗi FastAPI 422 có `detail` dạng mảng và xác nhận thông báo không chứa `[object Object]`.

Màn bếp (33)
16. `/kitchen`: 4 tab Món mới, Đang chế biến, Món trễ, Sẵn sàng. Món trễ gọi `delayed_only=true`, xếp món trễ nhất lên đầu, có nhãn “Trễ” / “Rất trễ”. Lọc theo trạm giữ nguyên tab.
17. Món mới có “Bắt đầu nấu”, món đang chế biến có “Món xong”, món Sẵn sàng không có nút. Hai người cùng bấm một món: người sau thấy thông báo “Trạng thái món vừa thay đổi” và danh sách tự tải lại.

Quản trị thực đơn (102, 103), cần tài khoản SUPERVISOR
18. `/admin/menu/categories`: thấy cả nhóm đã tắt; thêm nhóm (tên 1–100 ký tự, thứ tự 0–10000); đổi tên/thứ tự (PATCH chỉ gửi trường đã đổi); Bật/Tắt nhóm.
19. `/admin/menu/new`: tên và giá bắt buộc; giá phải lớn hơn 0 và tối đa 2 chữ số thập phân (“45.000” bị từ chối); nhóm món và trạm bếp bỏ trống được. Thành công thì quay về danh sách và hiện thông báo.
20. `/admin/menu/:id/edit`: dữ liệu điền sẵn; không đổi gì thì báo “Chưa có thay đổi nào để lưu.”; id không tồn tại hiện “Không tìm thấy món”. Lỗi 403/404/409/422/5xx đều giữ nguyên dữ liệu đang nhập.

Thời gian thực và mất mạng
21. Mở `/tables` ở hai trình duyệt, đổi trạng thái bàn ở một bên: bên kia tự cập nhật trong vài giây mà không cần bấm “Làm mới”.
22. Tắt mạng khi đang ở `/tables` hoặc `/kitchen`: banner offline hiện, dữ liệu cũ được giữ và có nhãn “Dữ liệu có thể đã cũ”, không có request nào bị gửi. Bật lại mạng thì tự tải lại.
23. Mở DevTools, tab Network: không có hai kết nối WebSocket cùng lúc; chuyển sang màn khác thì kết nối cũ đóng. Console không in token.
