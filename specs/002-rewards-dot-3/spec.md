# Feature Specification: Rewards đợt 3 — hoàn điểm, hết hạn điểm, số điện thoại trên QR

- **Feature Branch**: `feat/rewards-dot-3`
- **Created**: 2026-11-12
- **Status**: Implemented (PR `feat/rewards-dot-3`, 12/11/2026)
- **Hạng mục SDD**: R5 (Pha 2, P0)
- **Input**: "Hoàn điểm khi hoàn tiền; điểm hết hạn theo luật; khách trên QR nhập số điện thoại để tích điểm (chỉ tích, không đổi)."

## User Scenarios & Testing

### User Story 1 - Hoàn tiền thì điểm được trả lại đúng (Priority: P1)

Đơn đã thanh toán, khách có dùng 200 điểm để giảm giá và được tích 3 điểm. Supervisor hoàn tiền toàn bộ đơn. Hệ thống tự trả lại 200 điểm đã đổi, thu lại 3 điểm đã tích, và ưu đãi của đơn được tính là chưa dùng.

**Why this priority**: Thiếu bước này thì hoàn tiền (R1, đã chạy trên staging) để lại số dư điểm sai. Sai số dư là lỗi tiền, khách và quầy thu ngân đều thấy.

**Independent Test**: Thanh toán một đơn có đổi điểm, hoàn tiền hết; số dư khách quay về đúng như trước khi ăn, sổ điểm có một dòng đảo ngược.

**Acceptance Scenarios**:

1. **Given** đơn đã PAID, khách đổi 200 điểm và được tích 3 điểm, số dư hiện 103, **When** hoàn tiền toàn bộ, **Then** số dư thành 300 và có một dòng `REVERSAL` +197 ghi rõ cả hai phần.
2. **Given** đơn đã PAID và mới hoàn một phần, **When** hoàn phần đó, **Then** điểm không đổi.
3. **Given** khách đã tiêu hết điểm vừa tích, số dư không đủ để thu lại, **When** hoàn tiền toàn bộ, **Then** hệ thống chỉ thu lại phần còn có, số dư không âm, và ghi audit phần còn thiếu để Supervisor xử lý.

---

### User Story 2 - Điểm hết hạn theo luật (Priority: P1)

Luật điểm đặt hạn 365 ngày. Điểm tích từ đơn quá 365 ngày mà chưa dùng thì tự trừ; điểm tích trước thì hết hạn trước.

**Why this priority**: Luật điểm đã có trường hạn từ đợt 1 nhưng chưa có gì trừ điểm. Số dư sẽ phình mãi, sai so với luật đã công bố cho khách.

**Independent Test**: Tạo dòng tích điểm có hạn đã qua, chạy job; số dư giảm đúng phần chưa dùng, có dòng `EXPIRE`.

**Acceptance Scenarios**:

1. **Given** khách tích 50 điểm (hết hạn hôm qua) rồi tích thêm 30 (còn hạn), chưa dùng điểm nào, **When** job chạy, **Then** trừ 50, số dư còn 30.
2. **Given** khách tích 50 điểm (đã hết hạn) nhưng đã đổi 40, **When** job chạy, **Then** chỉ trừ 10.
3. **Given** job đã chạy hôm nay, **When** chạy lại, **Then** không trừ thêm.
4. **Given** luật không đặt hạn, **When** job chạy, **Then** không trừ gì.

---

### User Story 3 - Khách nhập số điện thoại trên QR để tích điểm (Priority: P2)

Khách đang gọi món bằng QR nhập số điện thoại. Hai trường hợp:
- **Số đã là thành viên:** đơn của bàn được gắn với khách đó, thanh toán xong tự tích điểm.
- **Số chưa là thành viên:** số được giữ lại cho thu ngân. Thu ngân xác nhận đồng ý của khách rồi đăng ký lúc thanh toán.

Khách không đổi điểm được trên QR và không xem được số dư.

**Why this priority**: QR đang chạy. Đây là phần "nhận diện khách" cuối cùng của BRD, nhưng thu ngân vẫn gắn khách được như hiện nay, nên không chặn luồng chính.

**Independent Test**: Trên một phiên QR, nhập số thành viên; thanh toán đơn; khách được tích điểm.

**Acceptance Scenarios**:

1. **Given** số là thành viên, **When** khách nhập trên QR, **Then** các đơn chưa thanh toán và chưa gắn khách của bàn được gắn với thành viên đó; trang hiện "Đã ghi nhận 090****567".
2. **Given** số chưa là thành viên, **When** khách nhập, **Then** trang hiện **đúng câu như trường hợp 1**; màn thu ngân thấy số chờ đăng ký.
3. **Given** bàn đã gắn một khách khác, **When** khách nhập số mới, **Then** không đổi khách đã gắn; trang hiện "Đã ghi nhận", thu ngân thấy số mới để xử lý.
4. **Given** một phiên đã nhập sai 5 lần, **When** nhập lần thứ 6, **Then** bị từ chối, trang báo nhờ thu ngân hỗ trợ.

### Edge Cases

- **Hoàn tiền trong nhiều lần:** điểm chỉ đảo khi lần hoàn cuối cùng làm tổng hoàn bằng tổng đã thu.
- **Đơn không gắn khách hoặc không dùng điểm:** hoàn tiền không ghi gì vào sổ điểm.
- **Khách bị khóa:** vẫn đảo điểm, vì sổ điểm phải khớp tiền; ghi audit.
- **Điều chỉnh tay (`ADJUST`) cộng điểm:** không có hạn, không bao giờ hết hạn.
- **Số điện thoại sai định dạng:** 422, không tính vào số lần thử.
- **Đoán số thành viên:** mã QR sai hoặc bị thu hồi thì 401, hết hạn thì 410, như các API QR khác. Phản hồi giống nhau cho thành viên và không phải thành viên, nên không dò được số nào là thành viên.

## Requirements

### Functional Requirements

- **FR-001**: Khi tổng hoàn tiền của một đơn bằng tổng đã thu, hệ thống MUST ghi một dòng `REVERSAL` gộp:
  - cộng lại số điểm đã đổi của đơn;
  - trừ số điểm đã tích của đơn.
- **FR-002**: Dòng đảo ngược MUST không làm số dư âm. Phần không thu lại được MUST ghi audit ngoại lệ `POINTS_REVERSAL_SHORTFALL`.
- **FR-003**: Khi đảo điểm, ưu đãi đã chốt của đơn MUST chuyển `REVERSED` và trả lại một lượt dùng của ưu đãi đó.
- **FR-004**: Hoàn một phần MUST không đổi điểm. [NEEDS CLARIFICATION: PO có muốn thu lại điểm theo tỉ lệ khi hoàn một phần không?]
- **FR-005**: Hệ thống MUST trừ điểm hết hạn theo thứ tự tích trước hết trước, chỉ trừ phần chưa dùng. Mỗi lần trừ ghi một dòng `EXPIRE` cho mỗi khách.
- **FR-006**: Job hết hạn MUST chạy lại an toàn: chạy hai lần liên tiếp thì lần sau không trừ gì.
- **FR-007**: API công khai cho phép khách gửi số điện thoại theo mã QR của phiên, phản hồi giống nhau cho thành viên và không phải thành viên, chỉ trả số đã che.
- **FR-008**: Với thành viên đang hoạt động, hệ thống MUST gắn khách vào các đơn chưa thanh toán và chưa gắn khách của phiên. Đơn đã gắn khách khác thì không đổi.
- **FR-009**: Với số chưa là thành viên, hoặc bàn đã gắn khách khác, hệ thống MUST giữ số đó trên phiên bàn để thu ngân xử lý. Hệ thống MUST NOT tự tạo khách, vì cần thu ngân xác nhận đồng ý.
- **FR-010**: Thu ngân (quyền `CUSTOMER_ACCESS`) MUST xem được số đang chờ của đơn để đăng ký hoặc gắn khách bằng API hiện có. Gắn xong thì số chờ được xóa.
- **FR-011**: Mỗi phiên QR MUST giới hạn 5 lần gửi số điện thoại (cấu hình được).
- **FR-012**: Khách trên QR MUST NOT đổi điểm, xem số dư hay xem tên khách.
- **FR-013**: Mọi việc gắn khách, giữ số, đảo điểm, hết hạn MUST ghi audit.

### Key Entities

- **PointsLedger (đã có)**: thêm loại `EXPIRE`. `REVERSAL` dùng cho hoàn điểm theo đơn.
- **TableSession (đã có)**: thêm số điện thoại đang chờ và số lần khách đã gửi.
- **OrderReward (đã có)**: dùng trạng thái `REVERSED` đã có sẵn.

## Success Criteria

- **SC-001**: Sau khi hoàn toàn bộ, số dư điểm của khách bằng số dư trước khi đặt đơn, trừ các giao dịch khác của khách (kiểm bằng test cho 4 tổ hợp: có/không đổi điểm × có/không tích điểm).
- **SC-002**: Không có dòng sổ điểm nào làm số dư âm (kiểm bằng ràng buộc dữ liệu và test).
- **SC-003**: Job hết hạn xử lý 10.000 khách trong dưới 1 phút trên staging.
- **SC-004**: Khách nhập số trên QR và thấy xác nhận trong dưới 2 giây; phản hồi cho thành viên và không thành viên giống hệt nhau.

## Assumptions

- **Phạm vi hoàn điểm:** chỉ khi hoàn toàn bộ đơn (FR-004 chờ PO chốt).
- **Lịch chạy job hết hạn:** mỗi ngày lúc 03:00 giờ Việt Nam, bằng workflow trên runner staging (như backup).
- **Đồng ý của khách:** khách tự nhập số trên QR **không** thay cho bước thu ngân xác nhận đồng ý khi tạo khách mới. Quyết định này giữ đúng điều đã chốt ở đợt 1.
- **Con số luật điểm:** dùng luật đang có (10.000đ = 1 điểm, 1 điểm = 100đ), chờ PO chốt số thật; spec này không phụ thuộc con số.
