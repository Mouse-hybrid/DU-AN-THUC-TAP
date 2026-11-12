# SDD 0001: Backend NOVA POS — các việc còn lại đến go-live

- Trạng thái: Đang thực hiện — cập nhật 12/11/2026
- Người viết: Backend Developer (Linh), soạn cùng Claude
- Bản để góp ý: [Claude Docs](https://claude.ai/artifact/ETivRA2nzTRjS6zM7dMkkS) (bản đầu ngày 09/11). **File này là bản chuẩn**; thay đổi thiết kế thì sửa ở đây qua PR.
- Spec từng tính năng (Spec-Driven Development): `.specify/memory/constitution.md` và `specs/` — R2 ở `specs/001-vnpay-sandbox/`, R5 ở `specs/002-rewards-dot-3/`
- Nguồn đối chiếu: Pos System BRD 1.0 (28/04/2026), Rollout Board, `docs/api/api-catalog.md`, code trên `main`

## 1. Mục đích và phạm vi

Liệt kê phần BRD mà backend chưa làm, thiết kế cho từng phần, và xếp vào các pha còn lại:

| Pha | Thời gian | Nội dung |
|---|---|---|
| Pha 2 | đến 20/11 | Làm chức năng |
| Pha 3 | 23/11 – 04/12 | SIT/UAT |
| Pha 4 | 07/12 – 18/12 | Go-live |

- **Phạm vi:** chỉ backend (API, dữ liệu, nghiệp vụ, vận hành). Phần FE ghi ở dòng "Việc của FE" trong từng mục.
- **Quyết định giữ nguyên:**
  - Một nhà hàng nhiều tầng, chưa có chi nhánh.
  - Kho/BOM để giai đoạn sau.
  - QR và Rewards làm trong Pha 2.
  - VNPay chỉ làm trên sandbox.
  - Mã QR cấp theo phiên bàn.
  - Món khách gọi qua QR phải chờ phục vụ xác nhận (phiếu B6).
  - Khách trên QR chỉ tích điểm; đổi điểm làm ở quầy thu ngân.
- **Lưu ý về BRD:** từ mục Payment & Billing trở đi, BRD chỉ có tiêu đề, không có quy tắc chi tiết. Phần thiết kế cho các mục đó dựa vào yêu cầu chức năng và các quyết định đã chốt, nên cần PO duyệt lại (mục 6).

## 2. Hiện trạng (12/11)

| Mảng | Đã có trên `main` | Còn thiếu |
|---|---|---|
| Đơn hàng | Tạo đơn tại quầy và qua QR, sửa/bỏ món trước khi gửi bếp, lịch sử phiên bản đơn, Idempotency-Key, tùy chọn món (#54) | Gửi món theo lượt, kiểm tra xung đột phiên bản, `device_id` |
| Bếp (KDS) | Hàng đợi theo trạm, nấu/xong/lấy/mang ra, SLA 4 mức, hủy và làm lại món, realtime | Bước nhận món, màn điều phối (Expeditor), ưu tiên món, thu hồi món, trạng thái trạm, báo trễ lên quản lý |
| QR | Mã theo phiên, thực đơn công khai, gọi món, theo dõi món, giới hạn số request (#53) | Số điện thoại tích điểm, khách tự yêu cầu thanh toán |
| Bàn | Mở/dọn bàn, sơ đồ, tầng/khu (#52), chuyển (#59), gộp (#60), tách đơn (#61) | Sửa số khách, hủy phiên, bỏ gộp |
| Rewards | Khách hàng, luật điểm theo phiên bản, sổ điểm, tích điểm, ưu đãi, đổi điểm (#55, #56) | Hoàn điểm khi hoàn tiền, hết hạn điểm, voucher, trần giảm giá theo Nghị định 81 |
| Thanh toán | Trả nhiều lần, tiền mặt/thẻ, tiền thối, hủy lần ghi nhầm, hoàn tiền (#63); khóa phiên bàn khi thu tiền (#65) | VNPay (R2), VAT và hóa đơn (R6) |
| Giám sát | Audit, báo cáo, CSV (#62); `request_id`, log JSON, Sentry, `/ops/metrics`, kiểm tra staging còn chạy (#64); bộ test chịu tải (#65) | Chạy test 200 người dùng trên staging; DSN Sentry thật |
| Phân quyền | 4 vai trò, ma trận quyền, quản lý nhân viên, thu hồi token (#50); Supervisor sửa quyền trên màn Vai trò (đang làm) | Duyệt bằng PIN, khóa tài khoản sau nhiều lần đăng nhập sai |
| Thực đơn | Nhóm món, món, hết hàng, gán trạm, tùy chọn | API trạm bếp, ảnh và mô tả món, combo, giá theo khung giờ |
| Offline | Idempotency-Key cho mọi API ghi | Hàng đợi đồng bộ, giải quyết xung đột |

**Nợ kỹ thuật đã biết:**
- Khóa tài khoản không ngắt WebSocket đang mở.
- Realtime và số đo API chỉ chạy trong 1 tiến trình.
- Mỗi lần deploy, script seed đặt lại mật khẩu các tài khoản seed.
- Báo cáo audit tổng hợp trong Python, chưa dùng `GROUP BY` của SQL.
- Bộ test mất khoảng 7 phút.

## 3. Việc còn lại theo pha

- **Ưu tiên:** P0 = bắt buộc cho go-live; P1 = làm nếu kịp trong pha; P2 = cần PO chốt giữ hay lùi.
- **Ước lượng:** tính bằng ngày làm của 1 người (BE).

| # | Hạng mục | Pha | Ưu tiên | Ước lượng | Trạng thái |
|---|---|---|---|---|---|
| R1 | Thanh toán v2: trả nhiều lần, tiền mặt/thẻ, hủy, hoàn | 2 | P0 | 2 ngày | **Xong** (#63) |
| R2 | VNPay sandbox: tạo link, Return URL + QueryDR, IPN viết sẵn | 2 | P0 | 2 ngày | Chờ tài khoản sandbox (mốc 13/11) |
| R3 | Giám sát: Sentry, log JSON, số đo, cảnh báo | 2 | P0 | 1 ngày | **Xong** (#64), còn đặt DSN |
| R4 | Chịu tải 200 người dùng, khóa đồng thời trên Postgres | 2 | P0 | 1 ngày | **Xong phần code** (#65), còn chạy trên staging |
| R5 | Rewards đợt 3: số điện thoại trên QR, hoàn điểm, hết hạn điểm | 2 | P0 | 1,5 ngày | **Xong** (PR `feat/rewards-dot-3`), còn đo hiệu năng job |
| R6 | Thuế VAT, phí phục vụ, dữ liệu in hóa đơn | 3 | P0 | 1,5 ngày | Chờ PO chốt thuế suất |
| R7 | KDS theo BRD: nhận món, ưu tiên, thu hồi, Expeditor, trạng thái trạm | 3 | P1 | 3 ngày | Chưa làm |
| R8 | Bàn và đơn: sửa số khách, hủy phiên, bỏ gộp, `expected_version` | 3 | P1 | 1,5 ngày | Chưa làm |
| R9 | Supervisor duyệt bằng PIN, khóa sau N lần đăng nhập sai | 3 | P1 | 1,5 ngày | Chờ chốt số PIN, số lần |
| R10 | Menu: API trạm bếp, ảnh và mô tả món | 3 | P1 | 1 ngày | Chưa làm |
| R11 | Realtime nhiều tiến trình (Redis), ngắt WebSocket khi khóa tài khoản | 3 | P1 | 1 ngày | Chưa làm |
| R12 | Stub tích hợp: đồng bộ offline, ERP, hóa đơn điện tử | 3 | P1 | 1,5 ngày | Chưa làm |
| R13 | Hạ tầng production: domain, HTTPS, rollback, backup, runbook | 4 | P0 | 3 ngày | Chờ domain, server |
| R14 | Gửi món theo lượt | — | P2 | 2 ngày | Chờ PO |
| R15 | Combo, giá theo khung giờ, phiên bản thực đơn, đặt bàn, offline thật | Sau go-live | P2 | — | Chờ PO |
| R16 | Supervisor sửa ma trận quyền trên màn Vai trò | 2 | P1 | 0,5 ngày | FE xong (#66); BE xong, chưa merge |

**Ước lượng cho phần còn lại (P0, P1, trừ các mục đã xong):** khoảng 16 ngày làm. Từ 12/11 đến 18/12 còn khoảng 26 ngày làm, nhưng Pha 3 phải dành phần lớn cho sửa lỗi SIT/UAT. Vì vậy P1 chỉ làm khi Pha 3 ít lỗi.

## 4. Thiết kế chi tiết

Mọi API mới tuân theo các quy ước đã dùng:
- Idempotency-Key cho mọi thao tác ghi.
- Quyền khai báo bằng `require_permission`. Quyền thực tế lấy qua `app/core/rbac.py`: ma trận mặc định cộng các ô Supervisor đã sửa.
- Khóa dòng khi ghi đồng thời, theo thứ tự cố định (phiên bàn → đơn → thanh toán).
- Ghi audit cho mọi thao tác ghi.
- Phát event WebSocket sau khi commit.
- Migration Alembic có bản hạ cấp.

### R1. Thanh toán v2 — đã xong (#63)

- **Dữ liệu:**
  - `payment(order_id, outlet_id, method CASH|CARD|VNPAY, amount, status, refunded_amount, cash_received, change_due, provider_ref, …)`
  - `payment_refund(payment_id, order_id, amount, reason, …)`
  - Trạng thái gồm PENDING, SUCCEEDED, FAILED, UNKNOWN, EXPIRED, CANCELLED, REFUNDED.
- **API:**
  - `POST /orders/{id}/payments`: thu tiền.
  - `GET /orders/{id}/payments`: xem các lần đã thu.
  - `POST /payments/{id}/cancel`: hủy lần ghi nhầm, chỉ Supervisor.
  - `POST /payments/{id}/refunds`: hoàn tiền, chỉ Supervisor.
  - `/pay` giữ làm lối tắt "trả nốt bằng tiền mặt".
- **Quy tắc:**
  - Không nhận quá số còn phải trả.
  - Lần trả đủ tiền chạy đúng logic `/pay`: chốt ưu đãi, tích điểm, đóng phiên bàn khi là đơn cuối.
  - Đã nhận một phần tiền thì không áp thêm ưu đãi và không đổi khách.
- **Hoàn điểm:** đã làm ở R5 (hoàn hết đơn thì đảo điểm và lượt dùng ưu đãi).

### R2. VNPay (sandbox)

- **Chuẩn bị:**
  - Người phụ trách tự đăng ký merchant sandbox.
  - Đặt `VNPAY_TMN_CODE` và `VNPAY_HASH_SECRET` vào `.env.staging`, không đưa vào repo hay chat.
  - Thẻ test NCB lấy từ tài liệu sandbox của VNPay.
- **Luồng:**
  1. BE tạo `payment` ở trạng thái PENDING.
  2. BE ký HMAC-SHA512 rồi trả link `vpcpay.html`:
     - `vnp_TxnRef` = id thanh toán;
     - `vnp_Amount` = số tiền × 100;
     - link hết hạn sau 15 phút.
  3. FE hiện link thành mã QR.
  4. Khách trả bằng thẻ test.
  5. VNPay chuyển trình duyệt về `GET /payments/vnpay/return`.
  6. BE kiểm chữ ký, rồi gọi QueryDR để xác nhận. QueryDR là chiều gọi ra nên không cần HTTPS.
  7. Xác nhận thành công thì đóng đơn bằng `finalize_paid_order`.
- **API:**
  - `GET /payments/vnpay/return`.
  - `POST /payments/{id}/check`: thu ngân bấm kiểm tra lại.
  - `GET /payments/vnpay/ipn`: trả `RspCode` theo tài liệu VNPay. Viết sẵn và test bằng khóa giả; chỉ bật khi có HTTPS.
- **Quy tắc:**
  - Không tin Return URL một mình; phải có QueryDR hoặc IPN xác nhận.
  - Xác nhận idempotent: nhiều đường xác nhận cùng tới thì đơn vẫn chỉ đóng một lần.
  - Số tiền lệch tổng đơn thì không đóng đơn.
  - Quá hạn mà QueryDR không trả kết quả thì chuyển `UNKNOWN`; hết hạn hẳn thì chuyển `EXPIRED`.
- **Điều kiện:** cần tài khoản sandbox, không cần HTTPS. Production cần domain và HTTPS (R13) để bật IPN.
- **Việc của FE:** màn 21, 49–51, nút "Kiểm tra lại".

### R3. Giám sát — đã xong (#64)

- **Request và log:**
  - Mỗi response có header `X-Request-ID`. Lỗi 500 trả kèm `request_id`.
  - Log JSON ghi theo mẫu route, không ghi mã QR trong đường dẫn.
- **Sentry:** chỉ bật khi có `SENTRY_DSN`. Dữ liệu gửi đi đã bỏ body, cookie, header đăng nhập, mã QR và số điện thoại.
- **`GET /api/v1/ops/metrics` (Supervisor):**
  - độ trễ p50/p95 và tỉ lệ lỗi 5xx theo route;
  - tỉ lệ món trễ ở bếp;
  - tỉ lệ thanh toán thành công;
  - cảnh báo khi vượt ngưỡng `ALERT_*`.
- **Báo staging ngừng:** workflow `uptime-staging.yml` gọi `/health` 15 phút một lần.
- **Hướng dẫn:** `docs/runbooks/monitoring.md`.

### R4. Chịu tải — đã xong phần code (#65)

- **Kịch bản Locust:** mỗi người dùng ảo giữ một bàn và đi hết luồng từ mở bàn đến dọn bàn. Ngưỡng đạt:
  - thêm món p95 ≤ 1 giây;
  - gửi bếp p95 ≤ 2 giây;
  - không có lỗi 5xx.
- **Dữ liệu tải:** `scripts/loadtest_data.py` tạo, kiểm tra và dọn outlet riêng "Load test", không đụng dữ liệu QA.
- **Test đồng thời trên Postgres:**
  - đổi điểm cùng khách ở 2 đơn;
  - gộp bàn chéo nhau;
  - chuyển 2 bàn vào cùng 1 bàn trống;
  - trả 2 hóa đơn tách cùng lúc. Trường hợp này từng có nguy cơ kẹt khóa, đã sửa.
- **Còn lại:** chạy 200 người dùng trên staging ngoài giờ QA test (`docs/runbooks/load-test.md`).

### R5. Rewards đợt 3

- **Số điện thoại trên QR:** `POST /public/qr/{token}/member`.
  - Khách nhập số điện thoại để tích điểm, không đổi điểm được.
  - API chỉ trả số đã che.
  - Có giới hạn số lần thử.
- **Hoàn điểm:** khi hoàn tiền (R1), ghi `REVERSAL` cho cả điểm đã đổi và điểm đã tích, chuyển `order_reward` sang `REVERSED`.
- **Hết hạn điểm:** job chạy hằng ngày, ghi dòng trừ cho điểm quá `expires_at`. Điểm tích trước thì hết hạn trước.

### R6. Thuế VAT, phí phục vụ, hóa đơn

- **Cấu hình theo nhà hàng:**
  - thuế suất (Figma đang ghi 8%);
  - giá trên thực đơn đã gồm thuế hay chưa;
  - phí phục vụ tính theo %.
- **Đơn hàng:** trả thêm `tax_total`, `service_charge`, `total`; tính lại cho từng hóa đơn tách (BR-SB-004, BR-SB-005).
- **In hóa đơn:** `GET /orders/{id}/invoice` trả dữ liệu cho màn 24. Hóa đơn điện tử thật nằm ở R12, dạng stub.

### R7. KDS theo BRD

- **Nhận món:**
  - `POST .../accept`, trạng thái `ACCEPTED` nằm giữa `SENT` và `PREPARING`.
  - Món chưa nhận quá ngưỡng thì báo (BR-KDS-ACC).
  - Cần PO chốt có bắt buộc bước này không.
- **Ưu tiên món:**
  - Mức `NORMAL|VIP|RUSH|ALLERGY`.
  - Món làm lại tự thành `RUSH` (BR-KDS-EXC-006).
  - Hàng đợi xếp theo ưu tiên, rồi theo thời gian.
- **Thu hồi món và điều phối:**
  - Thu hồi món (`RECALLED`).
  - `GET /kitchen/expeditor` gom theo bàn, có trạng thái `PARTIAL_READY`.
- **Trạng thái trạm:**
  - Trạm có trạng thái `ONLINE|OFFLINE|HOLD`.
  - Món trễ mức CRITICAL thì báo lên quản lý (BR-KDS-SLA-010).

### R8. Bàn và đơn còn thiếu

- **Phiên bàn:**
  - `PATCH /table-sessions/{id}` để sửa số khách.
  - `POST .../cancel` khi khách về trước khi gọi món.
- **Bỏ gộp bàn** trước khi thanh toán, nếu PO cần.
- **Phiên bản đơn:**
  - Client gửi `expected_version` khi sửa đơn; lệch phiên bản thì trả 409 (BR-OM-VER-005).
  - Ghi `device_id` vào phiên bản đơn.

### R9. Supervisor duyệt bằng PIN

- **Duyệt bằng PIN:**
  - PIN 4–6 số (phiếu B4), lưu bằng bcrypt.
  - `POST /auth/approve` trả token duyệt, có hạn 60 giây, dùng cho một thao tác. Ví dụ: hủy món, giảm số lượng sau khi gửi bếp (BR-OM-MOD-003).
  - Audit ghi cả người làm và người duyệt.
- **Khóa đăng nhập:** khóa 15 phút sau 5 lần sai (SEC-02). Các con số này chờ chốt.

### R10. Menu còn thiếu

- `POST/PATCH /kitchen/stations` để quản lý trạm bếp.
- Thêm `image_url` và `description` cho món. FE đang chờ phần này cho màn 41, 42, 103.

### R11. Realtime nhiều tiến trình

- Đổi bộ phát event trong bộ nhớ sang Redis pub/sub. Số đo API (R3) cũng đưa sang Redis hoặc Prometheus.
- Ngắt WebSocket của tài khoản vừa bị khóa hoặc đổi quyền.

### R12. Stub tích hợp

- **Đồng bộ offline:** `POST /sync/batch` nhận danh sách thao tác kèm `request_id`.
  - Chạy lần lượt theo `created_at`.
  - Báo xung đột theo `version_no`.
- **ERP, hóa đơn điện tử:**
  - Chỉ làm interface và hàng đợi gửi lại.
  - Dịch vụ ngoài lỗi thì không chặn luồng chính.

### R13. Hạ tầng production

- **Truy cập:** domain, Nginx và Certbot.
- **Triển khai:** `compose.prod.yml`, tự rollback khi deploy lỗi.
- **Dữ liệu:** backup trước khi chạy migration, backup tự động hằng ngày.
- **Khôi phục:** runbook để khôi phục được trong vòng 1 giờ.

### R14, R15. Cần PO chốt

- **Gửi món theo lượt:** BRD đặt `COURSE_BASED` làm mặc định cho ăn tại bàn, nhưng Rollout Board không có mục này. Nếu giữ thì cần:
  - `course` cho nhóm món;
  - `HOLD` cho món;
  - `POST /orders/{id}/fire?course=MAIN`.
- **Combo, giá theo khung giờ, phiên bản thực đơn, đặt bàn, offline thật:** đề xuất làm sau go-live.

### R16. Sửa ma trận quyền trên màn Vai trò

- **Dữ liệu:** bảng `role_permission_override(outlet_id, permission, role, allowed)` chỉ lưu các ô khác mặc định. Khôi phục mặc định = xóa hết dòng của outlet.
- **API:**
  - `GET /staff/permissions` trả thêm `default_roles`, `locked_roles`, `customized`.
  - `PUT /staff/permissions/{permission}` gửi danh sách vai trò đầy đủ của dòng đó.
  - `POST /staff/permissions/reset` khôi phục mặc định.
- **Quy tắc:**
  - Có hiệu lực ngay ở request kế tiếp, không cần đăng nhập lại.
  - Không bỏ được quyền `STAFF_MANAGE` của Supervisor.
  - Ghi audit `ROLE_PERMISSION_UPDATED` và `ROLE_PERMISSIONS_RESET`, tính là thao tác ngoại lệ.
- **FE đã làm (#66, 09/11):** ô tick trên màn Vai trò, nút khôi phục mặc định, ẩn/hiện nút trên các màn theo `permissions[]` của `/auth/me`. Màn này chỉ chạy đúng sau khi PR BE của R16 merge.

## 5. Lộ trình

| Tuần | Việc BE |
|---|---|
| 10/11 – 14/11 | R1 (xong), R3 (xong), R4 (xong phần code), R16; mốc tài khoản VNPay sandbox 13/11 |
| 17/11 – 20/11 | R5, R2; chạy R4 trên staging; hết Pha 2 ngày 20/11 |
| 23/11 – 04/12 (Pha 3) | Sửa lỗi SIT/UAT trước. R6, R8 đầu pha; R7, R9–R12 chỉ làm khi ít lỗi |
| 07/12 – 18/12 (Pha 4) | R13, trực go-live ngày 18/12 |

## 6. Rủi ro và câu hỏi cần chốt

| Rủi ro | Ảnh hưởng | Cách xử lý |
|---|---|---|
| Chưa có tài khoản sandbox VNPay | Không chạy được thanh toán QR thật | Code và test R2 bằng khóa giả; quá 13/11 thì chuyển R2 sang Pha 3, báo mentor |
| BE do 1 người làm | Không có thời gian dự phòng cho ốm, review | P1 chỉ làm khi Pha 3 ít lỗi; PR nhỏ, CI bắt buộc |
| FE vừa ghép toàn bộ API Pha 2 trong một PR lớn (#67, 09/11) | Lỗi ghép nối dồn lại, QA phát hiện muộn | QA test theo từng màn ngay tuần này; BE giữ API ổn định, báo FE ngay khi có API mới |
| Quy tắc thanh toán, Rewards trong BRD chỉ có tiêu đề | Thiết kế lệch kỳ vọng của PO | PO duyệt R1, R2, R5, R6 |
| Realtime chỉ 1 tiến trình | Không mở rộng ngang được khi production | Làm R11 trước go-live nếu chạy nhiều worker |

**Cần PO hoặc mentor chốt:**

- [ ] Thuế suất VAT, giá trên thực đơn đã gồm thuế chưa, có phí phục vụ không (R6)
- [ ] Có giữ gửi món theo lượt cho Pha 3 không (R14)
- [ ] Bếp có bắt buộc bấm "nhận món" trước khi nấu không (R7)
- [ ] Số chữ số PIN, số lần đăng nhập sai trước khi khóa (R9)
- [ ] Cashier có được tự hủy lần thanh toán ghi nhầm không, hiện chỉ Supervisor được (R1)
- [ ] Con số luật điểm (đang tạm: 10.000đ = 1 điểm, 1 điểm = 100đ) và trần giảm giá theo Nghị định 81
- [ ] Danh sách thao tác ngoại lệ trong báo cáo audit
- [ ] Ngưỡng cảnh báo giám sát (lỗi 5xx 5%, thanh toán thành công 95%, món trễ 20%)
- [ ] Domain cho staging và production; ai đứng tên tài khoản VNPay
- [ ] Mật khẩu tài khoản seed (6 ký tự) có nâng lên 8 cho khớp quy tắc tài khoản thật không

## 7. Phụ lục: đối chiếu chức năng BRD

Theo bảng "Functional Architecture" của BRD. Cột Trạng thái: **Có** = đã có API trên `main`; **Một phần** = có nhưng còn thiếu ý chính; **Chưa** = chưa có.

| Module | Chức năng BRD | Trạng thái | Hạng mục |
|---|---|---|---|
| Order | POS Order Creation | Có | — |
| Order | QR Order Creation | Có | — |
| Order | Order Modification | Một phần (thiếu duyệt khi giảm món sau gửi bếp) | R9 |
| Order | Course Firing | Chưa | R14 |
| Order | Order Merge (QR + POS) | Có | — |
| Order | Order Versioning | Một phần (thiếu kiểm tra phiên bản, `device_id`) | R8 |
| Order | Order Cancellation | Một phần (hủy từng món, chưa hủy phiên) | R8 |
| Order | Item Void / Edit | Có | — |
| Order | Special Instructions | Có (ghi chú, tùy chọn món) | — |
| KDS | Order Routing, Station Assignment | Có | — |
| KDS | KDS Acceptance | Chưa | R7 |
| KDS | Cooking Workflow | Có | — |
| KDS | Expeditor Control | Một phần (có lấy món, chưa có màn điều phối) | R7 |
| KDS | SLA Tracking | Một phần (4 mức, chưa báo lên quản lý) | R7 |
| KDS | Queue / Load Management | Chưa | R7 |
| KDS | Item Re-fire / Recall | Một phần (có làm lại, chưa thu hồi) | R7 |
| KDS | Priority Handling | Chưa | R7 |
| Table | Table Overview, Session, Lifecycle | Có | — |
| Table | Table Merge, Transfer, Split Bill | Có | — |
| Table | Guest Count Management | Một phần (nhập lúc mở bàn, chưa sửa được) | R8 |
| Table | Cleaning Control, Table Lock | Có | — |
| Payment | Bill Generation, Billing Validation | Một phần (chưa có thuế, hóa đơn) | R6 |
| Payment | Payment Method Selection, Processing | Một phần (tiền mặt, thẻ; chưa có VNPay) | R2 |
| Payment | Payment UNKNOWN Handling | Một phần (có trạng thái, chưa có đối soát) | R2 |
| Payment | Split Payment, Mixed Payment | Có | — |
| Payment | Refund / Void / Adjustment | Một phần (chưa hoàn điểm) | R5 |
| Payment | VAT / E-Invoice | Chưa | R6, R12 |
| Rewards | Customer Identification | Một phần (có ở quầy thu ngân, chưa có trên QR) | R5 |
| Rewards | Reward Retrieval, Eligibility Engine | Có | — |
| Rewards | Promotion / Reward Conflict | Có (mỗi đơn 1 ưu đãi) | — |
| Rewards | Apply Discount / Reward | Có | — |
| Rewards | Voucher Handling | Chưa | R15 |
| Rewards | Loyalty Points (Earn / Redeem) | Có | — |
| Rewards | Legal Cap Enforcement | Một phần (trần theo luật điểm, chưa theo Nghị định 81) | R6 |
| Menu | Category, Item Setup, Availability, Station Mapping | Có | — |
| Menu | Modifier Setup | Có | — |
| Menu | Combo / Set, Pricing Rules, Menu Versioning | Chưa | R15 |
| User | Staff Login, Role Management, Permission Matrix | Có (sửa được trên màn Vai trò từ R16) | — |
| User | Supervisor Approval, Critical Action Control | Một phần (chặn theo quyền, chưa duyệt bằng PIN) | R9 |
| User | Session Management | Một phần (thu hồi token, chưa khóa khi sai nhiều lần) | R9 |
| Audit | Order, Discount, Override Audit, Activity Log | Có | — |
| Audit | Payment Audit | Có (#63) | — |
| Audit | Audit Reporting | Có (#62) | — |
| Offline | Offline POS, KDS, QR; Sync Queue; Conflict Resolution | Chưa | R12, R15 |
| Offline | Retry / Idempotency | Có | — |
