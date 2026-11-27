# Feature Specification: VAT, phí phục vụ, hóa đơn và hóa đơn điện tử (stub)

- **Feature Branch**: `feat/vat-hoa-don`
- **Created**: 2026-11-27
- **Status**: Draft — chờ PO chốt các mục `[NEEDS CLARIFICATION]`
- **Hạng mục backlog**: R6 (Pha 3, P0) và phần hóa đơn điện tử của R12
- **Input**: "Tính VAT và phí phục vụ cho từng hóa đơn (kể cả bill tách), có dữ liệu in hóa đơn, khách yêu cầu hóa đơn VAT, gửi hóa đơn điện tử không chặn bán hàng."
- **Nguồn**:
  - BRD: "Maintain accurate tax, discount, and service charge calculation"; BR-SB-004 (thuế tính lại theo từng bill tách), BR-SB-005 (phí phục vụ chia theo tỉ lệ); mục VAT / E-Invoice (chỉ có tiêu đề).
  - HLR: TAX-HL-001..004; TABLE-HL-016 (thuế/phí theo khu vực "nếu nghiệp vụ cần"); Edge case 10 (nhà cung cấp hóa đơn điện tử lỗi thì xếp hàng gửi lại); màn POS 23 (VAT Invoice), 24 (Receipt Preview); màn QR 13 (Invoice Request).
  - ADR 0004: thuế và phí phục vụ tính riêng từng bill, phí phục vụ chia theo tỉ lệ; P2-PAY-008 chuyển sang Pha 3; hóa đơn điện tử có hàng đợi gửi lại, không chặn bán hàng.

## User Scenarios & Testing

### User Story 1 - Hóa đơn có VAT và phí phục vụ đúng (Priority: P1)

Supervisor cấu hình: phí phục vụ 5%, VAT 8%, giá thực đơn chưa gồm VAT. Bàn gọi 300.000đ, áp ưu đãi giảm 30.000đ. Màn tóm tắt đơn và khung Thanh toán hiện:

| Dòng | Số tiền |
|---|---|
| Tạm tính | 300.000đ |
| Giảm giá | −30.000đ |
| Phí phục vụ 5% | 13.500đ |
| VAT 8% | 22.680đ |
| **Phải trả** | **306.180đ** |

Thu ngân thu đúng số này; trả nhiều lần, VNPay, hoàn tiền đều dựa trên số phải trả mới.

**Why this priority**: Đây là số tiền khách trả. Sai là lỗi tiền, và mọi luồng thanh toán đã có (trả nhiều lần, VNPay, hoàn tiền, điểm thưởng) đều phụ thuộc số này.

**Independent Test**: Bật cấu hình, tạo đơn có ưu đãi, gọi `GET /orders/{id}`; các dòng tiền khớp bảng trên. Thu đủ số phải trả thì đơn chuyển PAID.

**Acceptance Scenarios**:

1. **Given** cấu hình như trên, **When** xem đơn, **Then** trả `subtotal`, `discount_total`, `service_charge`, `tax_total`, `total` đúng bảng trên.
2. **Given** cấu hình "giá đã gồm VAT", VAT 8%, không phí phục vụ, đơn 108.000đ, **When** xem đơn, **Then** `total` vẫn 108.000đ, `tax_total` là 8.000đ (phần VAT nằm trong giá).
3. **Given** cấu hình đang tắt (VAT 0%, phí phục vụ 0%), **When** xem đơn, **Then** `total` bằng `subtotal − discount_total` như hiện nay, hai trường mới bằng 0.
4. **Given** đơn đã PAID, **When** Supervisor đổi thuế suất, **Then** số của đơn đã PAID không đổi.
5. **Given** đơn đang chờ thanh toán, đã thu một phần, **When** Supervisor đổi thuế suất làm số phải trả thay đổi, **Then** hệ thống chặn đổi cấu hình (409) cho tới khi không còn đơn đang thu dở. [NEEDS CLARIFICATION: chặn đổi cấu hình, hay cho đổi và chỉ áp cho đơn mở sau?]

---

### User Story 2 - Tách bill thì mỗi bill có thuế và phí riêng (Priority: P1)

Đơn 300.000đ có phí phục vụ 5% và VAT 8% được tách thành bill A 100.000đ và bill B 200.000đ. Mỗi bill tự tính phí phục vụ và VAT trên phần của mình. Tổng hai bill bằng đơn gốc, lệch tối đa 1đ do làm tròn.

**Why this priority**: BR-SB-004, BR-SB-005, testcase P2-PAY-008 đã chuyển sang Pha 3 chờ việc này.

**Independent Test**: Tách đơn theo món, kiểm từng bill và tổng.

**Acceptance Scenarios**:

1. **Given** đơn như trên, **When** tách theo món, **Then** bill A có phí 5.000đ, VAT 8.400đ, phải trả 113.400đ; bill B có phí 10.000đ, VAT 16.800đ, phải trả 226.800đ.
2. **Given** chia theo số người hoặc theo % (trả nhiều lần trên cùng đơn), **When** thu từng phần, **Then** thuế và phí tính một lần trên cả đơn, không tính lại theo từng lần trả (ADR 0004).

---

### User Story 3 - Xem trước và in hóa đơn (Priority: P2)

Thu ngân bấm "Xem hóa đơn" ở màn tóm tắt đơn (màn 24 Receipt Preview). Hóa đơn có tên và địa chỉ nhà hàng, mã đơn, bàn, giờ, từng món kèm tùy chọn, các dòng tiền như Story 1, các lần thanh toán và hình thức, thông tin hóa đơn VAT nếu khách yêu cầu.

**Why this priority**: Cần cho vận hành thật và UAT, nhưng không chặn việc thu tiền.

**Independent Test**: `GET /orders/{id}/invoice` của đơn đã PAID trả đủ trường; đơn chưa PAID trả bản xem trước có ghi rõ "Tạm tính".

**Acceptance Scenarios**:

1. **Given** đơn đã PAID bằng tiền mặt và VNPay, **When** lấy hóa đơn, **Then** có đủ hai lần thanh toán, mã giao dịch VNPay, tổng khớp `total`.
2. **Given** đơn chưa thanh toán, **When** lấy hóa đơn, **Then** trả dữ liệu với cờ `is_preview: true`.

---

### User Story 4 - Khách yêu cầu hóa đơn VAT, hệ thống gửi hóa đơn điện tử không chặn bán hàng (Priority: P2)

Khách đưa mã số thuế, tên công ty, địa chỉ, email nhận hóa đơn. Thu ngân nhập trên màn 23 (VAT Invoice) trước hoặc sau khi thanh toán. Đơn PAID có yêu cầu thì hệ thống tạo phiếu hóa đơn điện tử và gửi tới nhà cung cấp. Nhà cung cấp lỗi thì phiếu nằm trong hàng đợi, tự gửi lại; thu tiền và đóng bàn vẫn chạy bình thường.

**Why this priority**: TAX-HL-001..004 yêu cầu, nhưng ở Pha 3 chỉ làm **stub**: chưa nối nhà cung cấp thật (cần hợp đồng và tài khoản). Stub phải đủ để thay bằng nhà cung cấp thật mà không đổi luồng.

**Independent Test**: Gửi yêu cầu VAT cho đơn PAID; với nhà cung cấp giả lập lỗi, phiếu ở `RETRYING`, job gửi lại thành công thì chuyển `ISSUED`; đơn và bàn không bị chặn ở bước nào.

**Acceptance Scenarios**:

1. **Given** đơn đã PAID, **When** thu ngân gửi thông tin VAT hợp lệ, **Then** tạo phiếu hóa đơn điện tử `PENDING`, trả 202.
2. **Given** nhà cung cấp (stub) trả lỗi, **When** gửi, **Then** phiếu chuyển `RETRYING`, ghi số lần thử; job chạy lại theo lịch.
3. **Given** quá số lần thử tối đa, **When** job chạy, **Then** phiếu chuyển `FAILED`, ghi audit ngoại lệ để Supervisor xử lý tay.
4. **Given** đơn chưa PAID, **When** gửi thông tin VAT, **Then** lưu thông tin trên đơn, chỉ tạo phiếu khi đơn PAID.
5. **Given** mã số thuế sai định dạng, **When** gửi, **Then** 422.
6. **Given** đơn đã có phiếu `ISSUED`, **When** gửi lại thông tin khác, **Then** 409 (muốn sửa phải làm hóa đơn điều chỉnh, ngoài phạm vi).

---

### User Story 5 - Khách tự yêu cầu hóa đơn VAT trên QR (Priority: P3)

Khách trên trang QR nhập thông tin xuất hóa đơn (màn QR 13). Thông tin được giữ cho thu ngân xác nhận, như cách đang làm với số điện thoại tích điểm.

**Why this priority**: HLR có màn này, nhưng thu ngân nhập thay được. Làm nếu còn thời gian.

### Edge Cases

- **Làm tròn:** tiền Việt không có số lẻ. Mỗi dòng (phí phục vụ, VAT) làm tròn tới 1đ, nửa lên (`ROUND_HALF_UP`), trên từng hóa đơn. Tổng các bill tách có thể lệch tổng đơn gốc tối đa 1đ mỗi dòng.
- **Giảm giá trước hay sau thuế:** giảm giá trừ trước, rồi mới tính phí phục vụ và VAT (khách được giảm cả phần thuế tương ứng). [NEEDS CLARIFICATION: PO xác nhận thứ tự này.]
- **Giới hạn giảm giá 50%:** vẫn tính trên tạm tính như hiện nay, không đổi.
- **Điểm thưởng tích theo số nào:** theo `total` sau thuế và phí như hiện nay tích theo số khách trả. [NEEDS CLARIFICATION: tích theo số trước hay sau VAT?]
- **Hoàn tiền:** hoàn một phần không tính lại thuế; hóa đơn điện tử đã phát hành thì cần hóa đơn điều chỉnh, ngoài phạm vi Pha 3, ghi audit để xử lý tay.
- **Món không chịu VAT hoặc thuế suất khác nhau theo món:** ngoài phạm vi; một thuế suất cho cả nhà hàng.
- **Thuế/phí theo khu vực (TABLE-HL-016):** ngoài phạm vi Pha 3, HLR ghi "nếu nghiệp vụ cần".
- **Đơn 0đ** (giảm hết, hoặc toàn món 0đ): phí và VAT bằng 0, không tạo phiếu hóa đơn điện tử.

## Requirements

### Functional Requirements

- **FR-001**: Nhà hàng (outlet) MUST có cấu hình: thuế suất VAT (%), giá thực đơn đã gồm VAT hay chưa, phí phục vụ (%). Mặc định **tắt** (0%, 0%), để staging và QA không đổi số khi deploy. Supervisor (quyền `OUTLET_SETTINGS`) đổi qua `PATCH /outlet/settings`, có audit.
- **FR-002**: Mỗi đơn MUST tính theo thứ tự: tạm tính → trừ giảm giá → phí phục vụ trên phần sau giảm → VAT trên (phần sau giảm + phí phục vụ). Giá đã gồm VAT thì không cộng VAT vào phải trả, chỉ tách phần VAT nằm trong giá để in.
- **FR-003**: `GET /orders/{id}`, `GET /tables/{id}`, `GET /orders/{id}/payments` MUST trả thêm `service_charge`, `tax_total`, các tỉ lệ đã dùng; `total` là số phải trả cuối cùng.
- **FR-004**: Mọi luồng thu tiền (trả nhiều lần, VNPay, hoàn tiền, kiểm "đã thu đủ", đóng đơn) MUST dùng `total` mới. Không có chỗ nào tự cộng lại `subtotal − discount`.
- **FR-005**: Khi đơn chuyển PAID, hệ thống MUST lưu cố định các số và tỉ lệ đã dùng trên đơn. Đổi cấu hình sau đó không làm đổi đơn đã PAID.
- **FR-006**: Tách bill theo món MUST tính phí và VAT riêng cho từng bill (BR-SB-004, BR-SB-005).
- **FR-007**: `GET /orders/{id}/invoice` MUST trả dữ liệu in hóa đơn (Story 3), không lộ số điện thoại đầy đủ của khách.
- **FR-008**: `PUT /orders/{id}/vat-request` (Idempotency-Key, quyền `PROCESS_PAYMENT`) MUST lưu thông tin xuất hóa đơn: mã số thuế (10 hoặc 13 số, dạng `0123456789-001`), tên đơn vị, địa chỉ, email nhận. MUST kiểm định dạng (422).
- **FR-009**: Đơn PAID có yêu cầu VAT MUST tạo một phiếu hóa đơn điện tử. Việc gửi MUST chạy ngoài transaction thanh toán; lỗi gửi MUST NOT làm hỏng thanh toán hay chặn đóng bàn (TAX-HL-004).
- **FR-010**: Phiếu hóa đơn điện tử MUST có trạng thái `PENDING → ISSUED | RETRYING → FAILED`, số lần thử, lỗi cuối, mã hóa đơn từ nhà cung cấp. Job gửi lại theo lịch; số lần thử tối đa cấu hình được (mặc định 5).
- **FR-011**: Nhà cung cấp hóa đơn điện tử MUST đứng sau một interface; Pha 3 dùng bản stub (thành công, hoặc lỗi theo cấu hình để test). Chưa có cấu hình nhà cung cấp thật thì không gửi ra ngoài.
- **FR-012**: `GET /orders/{id}/e-invoice` trả trạng thái phiếu; `POST /orders/{id}/e-invoice/retry` (Supervisor) gửi lại tay phiếu `FAILED`.
- **FR-013**: Đổi cấu hình thuế/phí, lưu yêu cầu VAT, mỗi lần gửi hóa đơn điện tử MUST ghi audit.
- **FR-014**: Thông tin xuất hóa đơn là dữ liệu của doanh nghiệp, không phải cá nhân, nhưng email nhận MUST chỉ hiện cho người có quyền `PROCESS_PAYMENT`.

### Key Entities

- **Outlet (đã có)**: thêm `vat_rate`, `prices_include_vat`, `service_charge_rate`.
- **Order (đã có)**: thêm các số đã chốt khi PAID: `service_charge`, `tax_total`, `vat_rate_applied`, `service_charge_rate_applied`; thông tin yêu cầu VAT.
- **EInvoice (mới)**: một phiếu cho một đơn: trạng thái, số lần thử, lỗi cuối, mã hóa đơn nhà cung cấp, thời điểm phát hành.

## Success Criteria

- **SC-001**: Với cấu hình mặc định (tắt), toàn bộ test hiện có vẫn đạt mà không sửa số kỳ vọng.
- **SC-002**: Với 20 tổ hợp (giá gồm/chưa gồm VAT × có/không phí phục vụ × có/không giảm giá × tách/không tách bill), số tính ra khớp bảng tính tay, lệch tối đa 1đ mỗi dòng.
- **SC-003**: Khi nhà cung cấp hóa đơn điện tử lỗi 100%, thời gian thanh toán và đóng bàn không tăng quá 100ms so với khi không có yêu cầu VAT.
- **SC-004**: Phiếu `RETRYING` được gửi lại thành công trong lần chạy job đầu tiên sau khi nhà cung cấp hoạt động trở lại.

## Assumptions và việc cần PO chốt

- [NEEDS CLARIFICATION: Thuế suất VAT là 8% (Figma đang ghi) hay 10%? Spec không phụ thuộc con số, cấu hình được.]
- [NEEDS CLARIFICATION: Giá trên thực đơn đã gồm VAT hay chưa?]
- [NEEDS CLARIFICATION: Có phí phục vụ không, bao nhiêu %?]
- [NEEDS CLARIFICATION: Nhà cung cấp hóa đơn điện tử thật là ai (để Pha 4 thay stub)? Cần hợp đồng và tài khoản test.]
- **Mặc định khi PO chưa chốt:** tắt cả VAT và phí phục vụ trên staging; bật bằng cấu hình khi có quyết định, không cần sửa code.
- **Một thuế suất cho cả nhà hàng**; không có thuế theo món hay theo khu vực.
- **Hóa đơn điều chỉnh/thay thế** sau khi đã phát hành: ngoài phạm vi Pha 3.
