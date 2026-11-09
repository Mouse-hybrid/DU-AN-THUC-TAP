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

| Route | Màn | Ai được vào (mặc định; quản lý chỉnh được ở màn 94) |
|---|---|---|
| `/login` | Đăng nhập (`/login?area=kitchen` dùng lời dẫn của màn bếp) | Chưa đăng nhập |
| `/tables` | Sơ đồ bàn | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id` | Chi tiết bàn | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/open` | Mở bàn (chỉ `guest_count`, 1–100) | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/order` | Gọi món (màn 09) | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/search` | Tìm món nhanh (màn 12) | CASHIER, WAITER, SUPERVISOR |
| `/tables/:id/summary` | Tóm tắt đơn, yêu cầu thanh toán, xác nhận thanh toán, đóng đơn | CASHIER, WAITER, SUPERVISOR |
| `/history` | Lịch sử đơn (màn 25) | CASHIER, WAITER, SUPERVISOR |
| `/kitchen` | Màn bếp, gồm tab Món trễ (màn 33) | Quyền `VIEW_KDS`: KITCHEN, SUPERVISOR |
| `/kitchen/orders/:orderId/items/:itemId` | Chi tiết món bếp (màn 35): tiến trình, nấu/sẵn sàng; giám sát hủy món hoặc làm lại món | `VIEW_KDS` (nấu/sẵn sàng cần `KITCHEN_ACTION`; hủy/làm lại cần `OVERRIDE`: mặc định chỉ SUPERVISOR) |
| `/admin/menu/categories` | Nhóm món và danh sách món (màn 102) | Quyền `MENU_WRITE`: SUPERVISOR |
| `/admin/menu/new` | Thêm món (màn 103) | `MENU_WRITE` |
| `/admin/menu/:id/edit` | Sửa món (màn 103) | `MENU_WRITE` |
| `/admin/audit-logs` | Nhật ký hệ thống (màn 97); `?order=<id>` lọc theo một đơn | Quyền `AUDIT_READ`: SUPERVISOR |
| `/admin/staff` | Quản trị nhân viên (màn 93): thêm, sửa họ tên/vai trò, khóa/mở khóa, đặt lại mật khẩu | Quyền `STAFF_MANAGE`: SUPERVISOR |
| `/admin/roles` | Vai trò & quyền (màn 94): quản lý tick sửa quyền từng vai trò, khôi phục mặc định | `STAFF_MANAGE` |
| `/profile` | Hồ sơ của tôi (màn 98): thông tin tài khoản, đổi mật khẩu | Mọi vai trò đã đăng nhập (kể cả KITCHEN) |

- `KITCHEN` bị chuyển về `/kitchen` nếu mở route POS. Ai chưa có quyền của một trang (theo bảng trên) thì quay về trang chủ của vai trò đó (`/tables`, hoặc `/kitchen` cho KITCHEN). Riêng KITCHEN bị gỡ `VIEW_KDS` thì ở lại `/kitchen` với thông báo “Chưa được cấp quyền” (chuyển hướng sẽ bị lặp).
- Chưa đăng nhập mà mở `/kitchen` thì chuyển tới `/login?area=kitchen`; sau khi đăng nhập, mọi role đều về trang chủ của role đó.
- Phân quyền ở FE chỉ để ẩn nút và chặn route. Backend vẫn là nơi quyết định (lỗi 403 được hiển thị bằng tiếng Việt).
- Màn hình không còn ẩn/hiện nút theo tên vai trò. Quản lý có thể chỉnh quyền từng vai trò ở màn 94 nên FE đọc danh sách `permissions` từ `GET /auth/me` (`src/auth/permissions.ts`, hook `usePermissions().can("MÃ_QUYỀN")`). Danh sách này được gọi lại mỗi lần mở một trang (đổi route) và mỗi khi backend trả 403; sửa quyền xong nhân viên không cần đăng nhập lại.
- Bản sao quyền lưu ở `localStorage` key `pos_permissions`, gắn với access token của phiên (đăng xuất hoặc đổi tài khoản thì không dùng lại) để màn hình không nhấp nháy khi mở trang. Chưa biết quyền (lần vào đầu tiên) thì trang được bảo vệ hiện “Đang kiểm tra quyền”; `/auth/me` lỗi thì hiện “Không thể kiểm tra quyền” kèm nút Thử lại.

Quyền theo hành động (mã quyền của backend; vai trò là mặc định, quản lý chỉnh ở màn 94):

| Hành động | Mã quyền | Mặc định |
|---|---|---|
| Thêm/sửa/xóa món trong đơn (màn 09, 12) | `ORDER_WRITE` | CASHIER, WAITER, SUPERVISOR |
| Dọn xong bàn | `TABLE_MARK_CLEAN` | WAITER, SUPERVISOR |
| Lấy món, Đã mang ra | `SERVE_FOOD` | WAITER, SUPERVISOR |
| Yêu cầu thanh toán | `REQUEST_BILLING` | CASHIER, WAITER, SUPERVISOR |
| Xác nhận đã thanh toán, Đóng đơn (PAID → CLOSED) | `PROCESS_PAYMENT` | CASHIER, SUPERVISOR |
| Thu tiền nhiều lần (tiền mặt/thẻ) | `PROCESS_PAYMENT` | CASHIER, SUPERVISOR |
| Hủy lần thu (đơn còn Chờ thanh toán), hoàn tiền (đơn đã thanh toán) | `PAYMENT_REFUND` | SUPERVISOR |
| Hủy món (bắt buộc nhập lý do), Làm lại món | `OVERRIDE` | SUPERVISOR |
| Bắt đầu nấu, Món xong | `KITCHEN_ACTION` | KITCHEN, SUPERVISOR |
| Xem màn bếp | `VIEW_KDS` | KITCHEN, SUPERVISOR |
| Tạo/sửa nhóm món, tạo/sửa món | `MENU_WRITE` | SUPERVISOR |
| Xem nhật ký, nút “Nhật ký” ở Lịch sử | `AUDIT_READ` | SUPERVISOR |
| Quản trị nhân viên và phân quyền | `STAFF_MANAGE` | SUPERVISOR |

Token được lưu trong `localStorage` với key `pos_auth` cùng thời điểm hết hạn. Không lưu mật khẩu.

## Cách gọi API

- Mọi request đi qua `src/api/client.ts`: timeout 12 giây, thử lại 1 lần cho lỗi mạng/timeout, lỗi trả về là `ApiError` có `status`. `status = 0` nghĩa là offline hoặc timeout.
- Mọi `POST`, `PUT`, `PATCH`, `DELETE` bắt buộc có `Idempotency-Key`. Handler tạo khóa bằng `createIdempotencyKey()` (UUID v4, có phương án dự phòng khi trình duyệt không có `crypto.randomUUID`) và dùng đúng một khóa cho mọi lần thử lại của cùng thao tác. Hai thao tác khác nhau luôn dùng hai khóa khác nhau.
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
1. Mở `/login`, để trống từng ô và xác nhận có lỗi tiếng Việt. Hai ô là “Tên đăng nhập” và “Mật khẩu” (không còn “Mã PIN” hay ví dụ NV-2048). Nhập sai mật khẩu và xác nhận câu “Tên đăng nhập hoặc mật khẩu không đúng.”.
2. Tắt mạng, thử đăng nhập và xác nhận banner “Đang ngoại tuyến” cùng thông báo lỗi.
3. CASHIER/WAITER: vào `/tables`; mở thẳng `/kitchen` hoặc `/admin/menu/categories` phải quay về `/tables`.
4. KITCHEN: vào `/kitchen`; mở `/tables` hoặc `/admin/menu/categories` phải quay về `/kitchen`. Chưa đăng nhập mà mở `/kitchen` phải tới `/login?area=kitchen` (“Sẵn sàng cho ca bếp”).
5. SUPERVISOR: vào được `/tables`, `/history`, `/kitchen`, `/admin/menu/categories` và `/admin/audit-logs`; menu có các mục “Lịch sử”, “Bếp”, “Thực đơn”, “Nhân viên”, “Vai trò”, “Nhật ký” (mỗi mục hiện theo quyền của tài khoản, không theo tên vai trò). CASHIER/WAITER có “Bàn” và “Lịch sử”. Thanh trên cùng của mọi màn không còn dòng “Chi nhánh” (dự án chưa có chi nhánh), chỉ còn chip người dùng và nút đăng xuất.
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

Chi tiết món bếp (35)
29. `/kitchen`: mỗi phiếu có liên kết “Chi tiết” mở `/kitchen/orders/<mã đơn>/items/<mã món>`. Trang hiện tên món × số lượng, bàn, mã phiếu, ghi chú, tùy chọn (nếu có), trạm, huy hiệu trạng thái và tiến trình Nhận phiếu → Bắt đầu chế biến → Sẵn sàng kèm giờ. Món chờ nấu có “Bắt đầu nấu”, món đang nấu có “Đánh dấu sẵn sàng” (bấm đúp chỉ gửi một request). “Quay lại bảng điều khiển” về `/kitchen`.
30. SUPERVISOR có thêm khối “Thao tác quản lý”: món chưa xong có “Hủy món”, món đã phục vụ/đã lấy có “Làm lại món”. “Hủy món” bắt buộc nhập lý do (để trống thì báo lỗi, không gửi request); lý do được lưu trong nhật ký (`/admin/audit-logs`). Món Sẵn sàng hoặc đơn đã yêu cầu thanh toán không có hai nút này và có dòng giải thích. KITCHEN không thấy khối này; CASHIER/WAITER mở route này thì về `/tables`.
31. Mở thẳng một mã món không có trong đơn: hiện “Không tìm thấy món hoặc đơn này”, không hiện khối chi tiết.

Quản trị thực đơn (102, 103), cần tài khoản SUPERVISOR
18. `/admin/menu/categories`: thấy cả nhóm đã tắt; thêm nhóm (tên 1–100 ký tự, thứ tự 0–10000); đổi tên/thứ tự (PATCH chỉ gửi trường đã đổi); Bật/Tắt nhóm.
19. `/admin/menu/new`: tên và giá bắt buộc; giá phải lớn hơn 0 và tối đa 2 chữ số thập phân (“45.000” bị từ chối); nhóm món và trạm bếp bỏ trống được. Thành công thì quay về danh sách và hiện thông báo.
20. `/admin/menu/:id/edit`: dữ liệu điền sẵn; không đổi gì thì báo “Chưa có thay đổi nào để lưu.”; id không tồn tại hiện “Không tìm thấy món”. Lỗi 403/404/409/422/5xx đều giữ nguyên dữ liệu đang nhập.

Lịch sử đơn, hủy/làm lại món, đóng đơn, nhật ký (Pha 2, phần backend đã có API)
21. `/history` (CASHIER/WAITER/SUPERVISOR; KITCHEN bị chuyển về `/kitchen`): mặc định “Hôm nay”, đổi sang 7/30 ngày thì gọi lại `GET /orders` với `created_from`. Các chip Tất cả / Đang mở / Đã thanh toán / Đã đóng có số đếm; ô tìm lọc theo 4 ký tự mã đơn hoặc mã bàn; 20 đơn mỗi trang. “Xuất danh sách” tải file CSV của danh sách đang lọc.
22. `/history`, đơn Đã thanh toán có nút “Đóng đơn” (chỉ CASHIER/SUPERVISOR) kèm hộp xác nhận; bấm đúp chỉ gửi một request; lỗi 409 hiện thông báo và tải lại danh sách. Đơn đang mở có “Xem bàn”; SUPERVISOR có thêm “Nhật ký” (mở `/admin/audit-logs?order=<id>`).
23. `/tables/:id` và `/tables/:id/summary` với SUPERVISOR: món chưa phục vụ (Chưa gửi bếp/Đã gửi bếp/Bếp đã nhận/Đang chế biến) có “Hủy món” (bắt buộc nhập lý do: để trống hoặc chỉ có khoảng trắng thì báo “Vui lòng nhập lý do hủy món.” và không gửi request), món Đã phục vụ/Đã lấy món có “Làm lại”. Đơn đã yêu cầu thanh toán thì không có hai nút này. CASHIER/WAITER không thấy. Bấm thử lại sau lỗi mạng dùng cùng Idempotency-Key.
24. `/tables/:id/summary` với CASHIER/SUPERVISOR: sau “Xác nhận đã thanh toán” hiện “Đóng đơn”; đóng xong trạng thái là “Đã đóng”.
25. `/admin/audit-logs` (SUPERVISOR; CASHIER/WAITER quay về `/tables`): thao tác mới nhất ở trên cùng, có người thực hiện + vai trò, đối tượng, hành động, chi tiết (ví dụ “Lý do: …” của Hủy món). Lọc nhóm Đơn hàng/Bàn/Thực đơn, tìm theo người dùng, đổi Hôm nay/7/30 ngày, “Xuất nhật ký” tải CSV. Từ `/history` bấm “Nhật ký” thì chỉ còn thao tác của đơn đó và có chip “Đang lọc theo đơn”.

Pha 2: nhân viên, phân quyền, hồ sơ
31. `/admin/staff` (SUPERVISOR; CASHIER/WAITER quay về `/tables`, KITCHEN về `/kitchen`): 4 thẻ thống kê (Tổng, Đang hoạt động, Đã khóa, Quản lý), chip vai trò có số đếm, lọc Tất cả/Đang hoạt động/Đã khóa, tìm theo tên hoặc tên đăng nhập (gõ không dấu vẫn ra), 10 dòng mỗi trang, “Xuất danh sách” tải CSV. Dòng của chính mình có nhãn “Bạn”, không có nút Khóa/Đặt lại, chỉ có “Sửa” và liên kết “Đổi mật khẩu” sang `/profile`.
32. “Thêm nhân viên”: bắt buộc họ tên, tên đăng nhập (3–100 ký tự chữ không dấu, số, `.`, `_`, `-`) và mật khẩu ≥ 8 ký tự; sai thì báo ngay, không gửi request. Trùng tên đăng nhập thì báo “Tên đăng nhập này đã tồn tại” và giữ hộp thoại. Bấm đúp “Tạo nhân viên” chỉ gửi một request.
33. “Sửa”: chỉ gửi trường đã đổi; đổi vai trò có cảnh báo người đó bị đăng xuất. Tự sửa mình thì ô Vai trò bị khóa (backend chặn tự đổi vai trò). “Khóa”/“Mở khóa”/“Đặt lại mật khẩu” đều có hộp xác nhận, chống bấm đúp, nêu rõ người đó bị đăng xuất khỏi mọi thiết bị. Tài khoản không có nút Xóa (backend không có API xóa).
34. `/admin/roles` (quyền `STAFF_MANAGE`): bảng 20 quyền × 4 vai trò, mỗi ô là một ô tick. Tick/bỏ tick gửi `PUT /staff/permissions/{permission}` với danh sách vai trò đầy đủ của dòng đó (ô hiện ngay, lỗi thì trả về như cũ và có thông báo); nhãn “Đã sửa” + dòng “Mặc định: …” hiện ở dòng khác mặc định; ô có biểu tượng khóa (`locked_roles`) bị vô hiệu và có giải thích, không gửi request. “Khôi phục mặc định” (chỉ bật khi có dòng đã sửa) hỏi xác nhận rồi gọi `POST /staff/permissions/reset`. Mọi lần ghi có `Idempotency-Key`, chống bấm đúp, có thông báo riêng cho 403/404/409/500/offline. Sau khi ghi, FE gọi lại `/auth/me` nên nếu quản lý tự gỡ quyền của mình thì menu/nút đổi ngay.
34b. Kiểm tra quyền có hiệu lực ngay: dùng một trình duyệt khác đăng nhập WAITER, giữ trang Tìm món mở; ở trình duyệt quản lý bỏ tick “Tạo và sửa đơn” của Phục vụ; ở trình duyệt WAITER chuyển sang trang khác rồi quay lại (hoặc bấm một nút bị từ chối) và xác nhận các nút gọi món biến mất, không cần đăng nhập lại.
35. Bấm chip tên ở góc trên phải (mọi vai trò, kể cả trên điện thoại) để vào `/profile`: xem họ tên, tên đăng nhập, vai trò, số quyền. “Đổi mật khẩu” cần mật khẩu hiện tại, mật khẩu mới ≥ 8 ký tự và nhập lại khớp; sai mật khẩu hiện tại thì hiện lời backend trả về và không bị đăng xuất; thành công thì lưu token mới (không bị đẩy ra màn đăng nhập).

Thanh toán (màn 20, 21, 100)
36. `/tables/:id/summary` khi đơn Chờ thanh toán có khung “Thanh toán”: Phải trả / Đã thu / Còn lại. Chọn Tiền mặt hoặc Thẻ, để trống số tiền = thu hết, nhập số nhỏ hơn để thu nhiều lần. Tiền mặt có ô “Khách đưa” và tự hiện tiền thối (để trống = đưa vừa đủ); thẻ có ô số hóa đơn máy POS và không có “Khách đưa”. Thu quá số còn lại hoặc khách đưa thiếu thì báo ngay, không gửi request. Lần thu cuối đủ tiền thì đơn chuyển Đã thanh toán. Nút “Xác nhận đã thanh toán” cũ vẫn dùng được (thu nốt bằng tiền mặt).
37. Quản lý (`PAYMENT_REFUND`) thấy “Hủy” ở từng lần thu khi đơn còn Chờ thanh toán, và “Hoàn tiền” khi đơn đã thanh toán (hoàn một phần hoặc hết). Cả hai bắt buộc lý do (≥ 3 ký tự), có chống bấm đúp và Idempotency-Key. Điểm đã tích không tự trừ lại khi hoàn (backend làm ở đợt Rewards). VNPay chưa có.
38. `/tables/:id` (bàn Đang phục vụ): người có quyền `TABLE_TRANSFER` (Phục vụ, Quản lý) thấy “Chuyển bàn” và “Gộp bàn”. Chuyển bàn chỉ liệt kê bàn Trống/Đã đặt; gộp bàn cho tick nhiều bàn (tối đa 10) và loại bàn đang chờ thanh toán/dọn. Lỗi 409/422 hiện ngay trong hộp thoại. Bàn đã gộp hiện “Đã gộp vào bàn X” ở sơ đồ và bấm vào sẽ mở bàn chính. Backend không có “hoàn tác gộp”.
39. `/tables/:id/summary`: nút “Tách bill” (quyền `TABLE_TRANSFER`) chọn món chuyển sang hóa đơn mới của cùng bàn. Món chưa gửi bếp hoặc đã phục vụ tách được theo số lượng; món đã vào bếp chỉ tách cả dòng; luôn phải để lại ít nhất 1 món. Khi bàn có nhiều hóa đơn, thanh “Hóa đơn 1/2…” để chuyển qua lại.
40. Gọi món (`/tables/:id/order`, `/tables/:id/search`): món có `has_modifiers` mở hộp thoại size/topping. Nhóm bắt buộc/tối đa kiểm tra ngay trên máy; cùng món nhưng khác tùy chọn là dòng riêng; giá tạm tính cộng thêm; dòng món hiện tùy chọn đã chọn.
41. `/tables`: bàn nhóm theo khu vực (thứ tự theo `sort_order` của `GET /areas`, bàn chưa gán khu xếp cuối) kèm lọc theo khu; nếu chưa có khu nào thì giữ lưới phẳng như trước.
42. `/tables/:id/summary`: khung “Khách hàng & ưu đãi”. Thu ngân/Quản lý (`CUSTOMER_ACCESS`) tra khách theo số điện thoại (chuẩn hóa `0xxxxxxxxx`), tạo mới khi có tick đồng ý, gắn/bỏ khách. Người có `REWARD_APPLY` áp/gỡ ưu đãi (đổi điểm nhập số điểm ≤ mức tối đa); Quản lý có thêm “Áp ngoại lệ” với lý do (bỏ qua hạn, đơn tối thiểu, số lượt). Tóm tắt đơn hiện Giảm giá và Phải trả. Đơn đã thanh toán một phần thì không đổi khách/ưu đãi.
43. QR gọi món: nút “Mã QR” ở chi tiết bàn (`QR_SESSION_MANAGE`) cấp, xem, cấp lại, thu hồi mã; mã vẽ ngay trên máy bằng thư viện `qrcode-generator` (thêm mới vào dependencies). Khách quét mở `/qr/:token` (không đăng nhập): xem thực đơn, chọn size/topping, gửi món, xem trạng thái (tự hỏi lại mỗi 10 giây). Món khách gọi có nhãn “Khách gọi QR” và banner chờ xác nhận; phục vụ bấm “Gửi bếp” để xác nhận hoặc “Xóa” để từ chối.
44. `/admin/audit-logs`: khung báo cáo tổng hợp (`GET /audit-logs/summary`: tổng, ngoại lệ, theo ngày/hành động/nhân viên) và nút “Tải báo cáo Excel” (`GET /audit-logs/export`, CSV UTF-8 có BOM mở bằng Excel, tối đa 10.000 dòng, báo khi bị cắt). Nút “Xuất nhật ký” cũ vẫn xuất phần đang hiển thị.

Thời gian thực và mất mạng
26. Mở `/tables` ở hai trình duyệt, đổi trạng thái bàn ở một bên: bên kia tự cập nhật trong vài giây mà không cần bấm “Làm mới”.
27. Tắt mạng khi đang ở `/tables` hoặc `/kitchen`: banner offline hiện, dữ liệu cũ được giữ và có nhãn “Dữ liệu có thể đã cũ”, không có request nào bị gửi. Bật lại mạng thì tự tải lại.
28. Mở DevTools, tab Network: không có hai kết nối WebSocket cùng lúc; chuyển sang màn khác thì kết nối cũ đóng. Console không in token.

## Đối chiếu giao diện với Figma (NOVA POS — UI/UX Screen System)

Đã chỉnh theo frame Figma: khung chung (sidebar tối 188px, topbar có chip vai trò và nút đăng xuất, không có chi nhánh, bảng màu "POS code · Vibrant"), màn 04 (thẻ thống kê, thẻ bàn theo màu trạng thái), màn 05 (chi tiết bàn: nút Lấy món/Đã mang ra nằm trong dòng món, huy hiệu theo màu Figma), màn 06 (thẻ Mở bàn có biểu tượng cửa, ô bàn chỉ đọc), màn 09 (thẻ món có ảnh 3 cột, nút "Gửi bếp" màu cam), màn 12 (một cột, ô tìm có biểu tượng, danh sách món, nút "Thêm món" cao 48px), màn 30–33 (phiếu bếp: huy hiệu bàn, đồng hồ, viền theo mức trễ, banner phiếu trễ nghiêm trọng), màn 35 (chi tiết món bếp: ảnh, tên × số lượng, danh sách thông tin, thẻ Tiến trình), màn 19 (tóm tắt đơn 2 cột: danh sách món | tổng tiền và thao tác), màn 29 (đăng nhập bếp nền tối, thẻ trắng giữa trang), màn 102 (cột danh mục + bảng món + công tắc hiển thị), màn 103 (form 2 cột + xem trước trên POS), màn 25 (lịch sử đơn: ô tìm, chip trạng thái có số đếm, bảng 7 cột, phân trang), màn 97 (nhật ký hệ thống: ô tìm, chip nhóm, bảng thời gian/người dùng/đối tượng/hành động/chi tiết, phân trang).

Khác Figma có chủ đích (API chưa hỗ trợ, không giả dữ liệu):

| Trong Figma | Trong code | Lý do |
|---|---|---|
| Ảnh món | Ảnh lấy từ Figma trong `public/menu-images/`, ghép theo tên món; món không có ảnh hiện ô chữ cái đầu | API món chưa có `image_url`; khi có thì sửa `src/components/MenuThumb.tsx` |
| Khối "Có thể bạn cần" (màn 12) | Không hiển thị | Chưa có API gợi ý |
| Nhập từ Excel, phân trang, "..." (màn 102) | Chưa có | Chưa có API / chưa có thiết kế chi tiết |
| Mã món, VAT, thời gian chế biến, mô tả, giá vốn (màn 103) | Trường khóa, nhãn "CHỜ API" | API món chỉ có name, price, category_id, station_id, is_available |
| Sidebar: Đặt chỗ, Đơn hàng, Thanh toán, Ca làm việc, Tìm đơn, Hiệu suất, Máy in | Không hiển thị | Thuộc Pha 2 hoặc chưa có API. Đã có “Lịch sử” (màn 25) và “Nhật ký” (màn 97, chỉ SUPERVISOR) |
| Màn 25: cột Thanh toán (phương thức), Nhân viên; chip Đã hủy, Hoàn tiền; “Ca tối”; nút “Xuất ca” | Cột Số món thay cho hai cột đầu; chip theo trạng thái đơn thật (Đang mở, Đã thanh toán, Đã đóng); khoảng thời gian Hôm nay/7/30 ngày; nút “Xuất danh sách” (CSV từ dữ liệu đang hiển thị) | `GET /orders` chỉ trả mã/bàn/giờ/số món/tiền/trạng thái; trạng thái đơn chỉ có NEW, SENT, SERVED, BILLING, PAID, CLOSED; chưa có API ca làm việc, hoàn tiền, phương thức thanh toán |
| Màn 97: cột Nhóm, Chi nhánh (dự án chưa có chi nhánh), IP/thiết bị, Kết quả; chip Đăng nhập/Bảo mật; tên đầy đủ người dùng | Cột Đối tượng (Đơn hàng/Món trong đơn/Bàn/Phiên bàn/Món/Nhóm món) và Chi tiết; chip Đơn hàng/Bàn/Thực đơn; hiển thị mã nhân viên và vai trò; “Xuất nhật ký” (CSV) | `GET /audit-logs` không trả IP, kết quả, tên đầy đủ; chưa ghi nhật ký đăng nhập. API trả cũ nhất trước nên FE gom các trang rồi đảo thứ tự (tối đa 2.000 dòng/khoảng) |
| Xem phiên bản đơn (`/orders/{id}/versions`) | Chưa làm | Chưa có thiết kế; API đã có (SUPERVISOR) |
| Nút "Ưu tiên lại" (màn 33) | Không hiển thị | Chưa có API |
| Chọn trạm bếp trước khi đăng nhập (màn 29) | Không hiển thị; lọc trạm bằng ô “Trạm bếp” ngay trên màn bếp | Nhóm đã chốt giữ cách lọc trạm trên màn bếp, chưa cần chọn trạm lúc đăng nhập (`/auth/login` cũng chưa nhận `station_id`) |
| Màn 35: “Thời gian chuẩn”, khối “Lưu ý” (ví dụ khách hỏi món nhiều lần), nút “Báo hết nguyên liệu” | Không hiển thị | API chưa có thời gian chuẩn của món, cảnh báo theo phiếu, hay báo hết nguyên liệu |
| Màn 35: topbar “Trạm làm việc · Bếp nóng · Ca tối”, mục sidebar Món trễ, Tìm đơn, Hiệu suất, Máy in | Topbar “NOVA Kitchen · Chi tiết món”; sidebar dùng chung (Bếp) | Chưa có API ca làm việc/trạm đang làm của nhân viên; các mục còn lại thuộc Pha 2 hoặc chưa có API |
| Màn 35: chỉ có “Đánh dấu sẵn sàng” | Thêm “Bắt đầu nấu” khi món còn chờ, và khối “Thao tác quản lý” (Hủy món có lý do bắt buộc, Làm lại món) cho SUPERVISOR | Theo yêu cầu nhóm; dùng `start-cooking`, `mark-ready`, `void`, `refire` đã có |
| Mã phiếu “#N1043” (màn 35) | Mã tạm `#<bàn>-<4 ký tự cuối mã đơn>`, giống phiếu bếp | Backend chưa có mã phiếu riêng |
| Màn 93: ảnh đại diện, số điện thoại, email, ca, “Lần đăng nhập cuối”, nút Xóa, chọn nhiều dòng | Chỉ họ tên, tên đăng nhập, vai trò, trạng thái, ngày tạo; Khóa thay cho Xóa | `StaffDetailOut` chưa có các trường này; backend không có API xóa |
| Màn 94: tạo vai trò mới | Chỉ bật/tắt quyền của 4 vai trò có sẵn (ô tick), khôi phục mặc định, thẻ đếm | Backend chưa có API tạo vai trò mới; sửa quyền dùng `PUT /staff/permissions/{permission}` và `POST /staff/permissions/reset` |
| Kiểu dữ liệu `PermissionRule` (`default_roles`, `locked_roles`, `customized`) | Khai báo tay trong `src/api/staff.ts` | `src/api/schema.d.ts` trên main chưa có các trường này và chưa có hai endpoint sửa quyền; khi backend cập nhật openapi, chạy `npm run gen:api` rồi đổi về type sinh ra |
| Màn 98: sửa họ tên, ảnh, liên hệ, danh sách phiên, 2FA | Chỉ xem thông tin và đổi mật khẩu (không hiện mã cơ sở) | Chưa có API tự sửa hồ sơ, phiên, 2FA |
| Màn 93/94/98: khung Backoffice 1440 riêng | Dùng khung chung của ứng dụng (sidebar + topbar) | Giữ một khung duy nhất cho mọi màn; sidebar thêm “Nhân viên”, “Vai trò” (trang có tiêu đề “Vai trò & quyền”, tên ngắn để vừa sidebar) cho SUPERVISOR |
| Màu chính | #008573 (theo Figma) | Trước đây #147d6f; cần anh Thanh/Linh xác nhận lần cuối |
