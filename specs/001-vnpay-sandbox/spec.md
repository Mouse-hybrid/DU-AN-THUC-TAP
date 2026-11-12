# Feature Specification: Thanh toán VNPay (sandbox)

- **Feature Branch**: `feat/vnpay-sandbox`
- **Created**: 2026-11-12
- **Status**: Implemented — chờ chạy thử trên sandbox thật (PR `feat/vnpay-sandbox`, 12/11/2026)
- **Hạng mục SDD**: R2 (Pha 2, P0)
- **Input**: "Thanh toán QR qua VNPay, thử trên môi trường sandbox; staging chưa có HTTPS."

## User Scenarios & Testing

### User Story 1 - Khách trả tiền qua VNPay tại bàn (Priority: P1)

Đơn đang chờ thanh toán. Thu ngân chọn "VNPay"; màn hình hiện mã QR. Khách mở link bằng điện thoại, trả bằng thẻ test trên trang VNPay sandbox. Trả xong, trang chuyển về hệ thống và báo thành công; đơn chuyển sang đã thanh toán, bàn chuyển sang chờ dọn.

**Why this priority**: Là thanh toán điện tử duy nhất trong phạm vi Pha 2; tiền mặt và thẻ đã có từ R1.

**Independent Test**: Với tài khoản sandbox, đi hết luồng trên một đơn có món; đơn thành PAID, có một dòng thanh toán VNPAY SUCCEEDED, điểm được tích như thanh toán tiền mặt.

**Acceptance Scenarios**:

1. **Given** đơn ở BILLING còn phải thu 200.000đ, **When** thu ngân chọn VNPay, **Then** hệ thống trả link thanh toán hết hạn sau 15 phút và một lần thanh toán ở trạng thái chờ.
2. **Given** khách trả thành công trên VNPay, **When** trình duyệt quay về hệ thống, **Then** hệ thống xác nhận lại với VNPay rồi mới đóng đơn, và trang hiện "Thanh toán thành công".
3. **Given** khách bấm hủy trên trang VNPay, **When** trình duyệt quay về, **Then** lần thanh toán thành thất bại, đơn vẫn chờ thanh toán, thu ngân chọn cách trả khác được.

---

### User Story 2 - Thu ngân kiểm tra lại khi chưa thấy kết quả (Priority: P2)

Khách nói đã trả nhưng màn hình thu ngân vẫn "đang chờ" (khách tắt trình duyệt trước khi quay về). Thu ngân bấm "Kiểm tra lại"; hệ thống hỏi VNPay và cập nhật đúng kết quả.

**Why this priority**: Staging chưa có HTTPS nên chưa nhận được thông báo chủ động từ VNPay (IPN); không có bước này thì tiền đã trừ mà đơn không đóng.

**Independent Test**: Trả thành công nhưng không mở trang quay về; bấm kiểm tra lại; đơn thành PAID.

**Acceptance Scenarios**:

1. **Given** lần thanh toán đang chờ và khách đã trả, **When** thu ngân bấm kiểm tra lại, **Then** đơn được đóng đúng một lần.
2. **Given** lần thanh toán đang chờ và khách chưa trả, **When** kiểm tra lại, **Then** trạng thái vẫn chờ, báo "Khách chưa thanh toán".
3. **Given** quá hạn link mà VNPay báo không có giao dịch, **When** kiểm tra lại hoặc job đối soát chạy, **Then** lần thanh toán thành hết hạn và thu ngân tạo link mới được.

---

### User Story 3 - Nhận thông báo IPN khi có HTTPS (Priority: P3)

Khi production có domain HTTPS, VNPay gọi thẳng vào hệ thống báo kết quả, không phụ thuộc trình duyệt khách.

**Why this priority**: Chỉ bật được khi có HTTPS (SDD R13); code và test sẵn để không phải làm lại.

**Independent Test**: Test tự động gọi endpoint IPN với chữ ký tạo bằng khóa giả.

**Acceptance Scenarios**:

1. **Given** IPN hợp lệ báo thành công, **When** hệ thống nhận, **Then** đóng đơn và trả mã `00`.
2. **Given** IPN gửi lại lần hai, **When** hệ thống nhận, **Then** không đóng đơn lần nữa và trả mã `02` (đã xác nhận).
3. **Given** chữ ký sai, **When** hệ thống nhận, **Then** không đổi gì và trả mã `97`.

### Edge Cases

- **Return URL bị sửa tay:** khách sửa tham số trên Return URL để giả thành công → chữ ký sai, hoặc QueryDR báo khác. Không đóng đơn.
- **Lệch số tiền:** số tiền VNPay báo khác số của lần thanh toán → không đóng đơn, ghi audit, thu ngân xử lý tay.
- **Nhiều kết quả tới cùng lúc:** Return URL, kiểm tra lại và IPN tới gần như đồng thời → đơn chỉ đóng một lần.
- **Thanh toán sau khi hủy:** lần thanh toán đã bị Supervisor hủy mà VNPay vẫn báo đã trả → không đóng đơn; ghi audit để hoàn tiền tay.
- **Đơn đổi số tiền:** chỉ lần thanh toán đang chờ mới được tạo link mới, và tổng các lần không vượt số còn phải thu. Đơn đã có lần thanh toán khác thành công thì link VNPay chỉ cho số còn lại.
- **VNPay không trả lời hoặc trả lỗi:** QueryDR quá thời gian chờ → giữ trạng thái chờ, báo thu ngân thử lại; không đổi sang thất bại.

## Requirements

### Functional Requirements

- **FR-001**: Hệ thống MUST tạo được lần thanh toán VNPay ở trạng thái PENDING cho đơn BILLING, với số tiền mặc định là số còn phải thu và không vượt quá số đó.
- **FR-002**: Hệ thống MUST tạo link thanh toán VNPay có chữ ký HMAC-SHA512, mã tham chiếu duy nhất theo lần thanh toán, thời hạn 15 phút (cấu hình được).
- **FR-003**: Hệ thống MUST kiểm tra chữ ký của mọi dữ liệu VNPay gửi về; chữ ký sai thì bỏ qua và ghi log cảnh báo.
- **FR-004**: Hệ thống MUST chỉ đổi lần thanh toán sang thành công khi kết quả có chữ ký VNPay hợp lệ: QueryDR hoặc IPN; hoặc Return URL đã kiểm chữ ký khi QueryDR không trả lời được (cập nhật 12/11, research R-1).
- **FR-005**: Việc xác nhận MUST idempotent: lần thanh toán đóng đơn đúng một lần dù nhận nhiều kết quả.
- **FR-006**: Khi thành công, hệ thống MUST đóng đơn bằng đúng logic chốt đơn hiện có (ưu đãi, tích điểm, đóng phiên bàn, audit).
- **FR-007**: Hệ thống MUST cho thu ngân kiểm tra lại một lần thanh toán đang chờ.
- **FR-008**: Hệ thống MUST tự đối soát các lần thanh toán đang chờ đã quá hạn: hỏi VNPay, rồi chuyển SUCCEEDED, FAILED, EXPIRED, hoặc UNKNOWN nếu VNPay không trả lời được.
- **FR-009**: Hệ thống MUST có endpoint IPN trả `RspCode` theo tài liệu VNPay. Endpoint chỉ bật bằng cấu hình (mặc định tắt trên staging).
- **FR-010**: Khóa VNPay MUST đọc từ biến môi trường. Thiếu khóa thì API tạo link trả lỗi rõ ràng "VNPay chưa được cấu hình", không làm hỏng các hình thức khác.
- **FR-011**: Mọi lần tạo link, xác nhận, lệch số tiền MUST ghi audit.
- **FR-012**: Lần thanh toán hết hạn hoặc thất bại MUST không chặn việc tạo lần thanh toán mới cho cùng đơn.

### Key Entities

- **Payment (đã có, mở rộng)**: một lần thu tiền. Thêm cho VNPay:
  - thời hạn;
  - mã giao dịch phía VNPay;
  - mã kết quả VNPay trả;
  - thời điểm kiểm tra gần nhất;
  - ngày giờ VNPay ghi nhận giao dịch.
- **Cấu hình VNPay**: mã merchant, khóa ký, URL thanh toán, URL tra cứu, URL quay về, thời hạn link, bật/tắt IPN.

## Success Criteria

- **SC-001**: Trên sandbox, 10/10 lần trả bằng thẻ test đóng đơn đúng và đủ, không đơn nào đóng hai lần.
- **SC-002**: Không lần nào đơn được đóng khi Return URL bị sửa tham số hoặc chữ ký sai (kiểm bằng test tự động).
- **SC-003**: Thu ngân thấy kết quả trong vòng 5 giây sau khi khách quay về, hoặc ngay khi bấm kiểm tra lại.
- **SC-004**: Lần thanh toán đang chờ không còn treo quá 30 phút sau khi hết hạn link (job đối soát xử lý).

## Assumptions

- **Tài khoản sandbox:** người phụ trách tự đăng ký merchant sandbox và đặt khóa vào `.env.staging`. Mốc cần có là 13/11; quá mốc này thì chuyển R2 sang Pha 3.
- **Không cần HTTPS:** staging chạy http trên IP. Return URL do trình duyệt khách mở, QueryDR là chiều gọi ra, nên không cần HTTPS. IPN chỉ bật khi có HTTPS.
- **Thẻ test:** dùng thẻ NCB trong tài liệu sandbox. Mã VNPAY-QR trên trang sandbox có thể không quét được bằng app ngân hàng thật.
- **Phạm vi:** chỉ thanh toán, không làm hoàn tiền qua VNPay. Hoàn tiền vẫn ghi tay như R1, tiền trả lại ngoài hệ thống.
- **[NEEDS CLARIFICATION]** VNPay sandbox có bắt buộc khai báo IPN URL lúc đăng ký không. Nếu có thì tạm dùng `160.191.47.17.sslip.io` với chứng chỉ Let's Encrypt.
- **[NEEDS CLARIFICATION]** Ai đứng tên tài khoản VNPay khi lên production.
