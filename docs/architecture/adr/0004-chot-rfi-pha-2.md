# ADR 0004: Chốt 13 RFI Pha 2 và các câu hỏi mở theo BRD + HLR

- Trạng thái: Accepted — BE chốt 17/11/2026 theo BRD và High Level Requirements (HLR). Gửi PO và mentor để nắm; nếu PO đổi ý ở mục nào thì sửa mục đó trong file này và ghi ngày.
- Ngày: 2026-11-17
- Người đề xuất: Backend Developer (Linh), soạn cùng Claude
- Nguồn: sheet "RFI & Gaps" trong bộ testcase Pha 2 của QA (chốt Sprint 4, 16/11, baseline `c7e9b0d`); BRD; `Plan/High Level Requirements.docx`; SDD `docs/architecture/sdd/0001-backend-viec-con-lai.md`

## Bối cảnh

Biên bản chốt Sprint 4 của QA còn 13 RFI ở trạng thái Open. Các testcase liên quan đang để "Design only; không đánh PASS". Pha 2 kết thúc 20/11, SIT/UAT bắt đầu 23/11, nên cần chốt kết quả mong đợi để QA test được.

Nguyên tắc chốt:
1. BRD có quy tắc thì theo BRD.
2. BRD không nói, hoặc nói chung chung, thì theo HLR.
3. Cả hai đều không nói thì chọn phương án gọn nhất mà vẫn an toàn về tiền và dữ liệu.
4. Chỗ nào lệch BRD hoặc HLR đều ghi lý do.

## Quyết định — 13 RFI

### P2-RFI-PAY — Thanh toán
- **Ba hình thức:**
  - Tiền mặt (tính tiền thối).
  - Thẻ: thu ngân xác nhận máy POS đã quẹt (`method: "CARD"`). **Không** nối cổng thẻ trong Pha 2.
  - VNPay sandbox: chữ ký HMAC-SHA512.
- **Kết quả không như mong đợi:**
  - Thanh toán thất bại thì đơn vẫn chưa trả.
  - Không xác minh được kết quả thì `UNKNOWN`.
  - Kết quả gửi về nhiều lần chỉ ghi một lần.
- **Bỏ trống số tiền** thì thu hết phần còn lại.
- **Mã lỗi:**
  - 409: sai trạng thái hoặc vượt số tiền;
  - 422: sai dữ liệu;
  - 503: chưa cấu hình cổng;
  - 502: không hỏi được cổng.
- **Căn cứ:** BRD Event 6; HLR mục Edge Cases số 9 ("Duplicate payment callback").
- **Hiện trạng:** đã làm (#63, #72–#74). QA chạy theo `docs/qa/vnpay-sandbox-qa-guide.md`.
- **P2-PAY-002:** đổi thành "thẻ do thu ngân xác nhận".

### P2-RFI-SPLIT — Tách bill
- **Tách theo món:** đã làm. Đơn đang có ưu đãi phải gỡ ưu đãi trước khi tách.
- **Tách theo số tiền, theo %, chia đều theo số khách:** đều là trả nhiều lần trên cùng đơn.
  - FE tính số tiền từng lần; BE dùng API trả nhiều lần hiện có.
  - Ưu đãi vẫn tính trên cả hóa đơn.
- **Một lần trả lỗi** không ảnh hưởng các lần đã trả; số còn lại luôn hiện (`summary.remaining`).
- **Thuế và phí phục vụ:** tính riêng từng bill; phí phục vụ chia theo tỉ lệ. Làm cùng R6 (VAT) đầu Pha 3.
- **Căn cứ:**
  - BR-SB-001..012;
  - HLR: TABLE-HL-011, UC-TABLE-005, Table Management Edge Cases số 7.
- **Việc kéo theo:**
  - FE thêm tách theo % và theo số khách.
  - P2-PAY-008 (thuế theo từng bill) chuyển sang Pha 3.

### P2-RFI-TABLE — Chuyển, gộp, tách bàn
- **Chuyển bàn:**
  - Bàn đích phải trống. Bàn nguồn về `AVAILABLE` ngay.
  - Mọi thứ đi theo phiên: đơn, trạng thái bếp, thanh toán, mã QR, audit.
- **Sức chứa:**
  - Mở bàn vượt số chỗ: chỉ **cảnh báo** (FE).
  - Chuyển bàn vượt sức chứa: **409**. Supervisor (quyền `OVERRIDE`) được vượt nếu ghi `capacity_override_reason`; có audit.
- **Quyền:** chỉ Waiter và Supervisor được chuyển, gộp, tách bàn.
- **Gộp bàn:**
  - Không gộp bàn đã yêu cầu thanh toán.
  - Không có bỏ gộp: khách muốn trả riêng thì dùng tách bill.
- **Bàn đã yêu cầu thanh toán:** **không chuyển được trong Pha 2**.
  - Đây là chỗ lệch: HLR TABLE-HL-018 và BR-TT-009 cho phép nếu có quyền.
  - Lý do: tránh chuyển bàn khi đang có link VNPay chờ.
  - Pha 3 mở cho Supervisor, với điều kiện không có thanh toán đang chờ.
- **Thao tác trùng và mạng chập chờn:**
  - Chống bấm trùng bằng `Idempotency-Key`.
  - Hai người thao tác cùng lúc thì khóa dòng, chạy lần lượt.
  - Chạy offline để Pha 3.
- **Căn cứ:**
  - BR-TT-002/009/010/014, BR-MT-002;
  - BRD: "use Split Bill… not unmerge";
  - HLR: TABLE-HL-013/018, Table Management Edge Cases số 5, 8, 9.
- **Hiện trạng:** đã làm (#59–#61, #76).
- **Việc kéo theo:**
  - FE: cảnh báo khi mở bàn; câu báo 409; ô lý do cho Supervisor.
  - QA kiểm thêm: món báo xong sau khi chuyển bàn phải hiện số bàn mới (HLR Table Management Edge Cases số 8).

### P2-RFI-ROLE — Phân quyền
- **Ma trận:** theo BRD, với 2 chỗ lệch đã chốt:
  - Tạo đơn tại quầy: mọi nhân viên sảnh (PO chốt 09/10).
  - Khách **không** được chuyển, gộp, tách bàn, dù ma trận BRD đánh dấu. Đây là thao tác của nhân viên.
- **Khách thanh toán:**
  - Pha 2: khách trả qua link VNPay nhân viên đưa.
  - Nếu kịp trước 20/11 thì thêm API để khách tự tạo link từ trang QR (HLR: Customer "QR order and payment"); không kịp thì làm đầu Pha 3.
- **Hiệu lực:** đổi quyền, khóa tài khoản hay đặt lại mật khẩu thì token cũ **hết hiệu lực ngay**.
- **Ngắt WebSocket** khi khóa tài khoản: làm trong R11.
- **Hiện trạng:** đã làm (#50, #69).

### P2-RFI-PIN — Duyệt bằng PIN, khóa tài khoản
- **PIN:** 6 số.
- **Sai 5 lần:** khóa 15 phút. Áp dụng cho cả đăng nhập mật khẩu.
- **Quên hoặc khóa PIN:** Supervisor khác đặt lại.
- **Token duyệt:** mỗi lần duyệt cấp một token chỉ dùng 1 lần, hiệu lực 60 giây.
- **Bắt buộc dùng khi:** giảm hoặc hủy món đã gửi bếp, hoàn tiền, vượt quy tắc ("Manager Override Popup" của HLR).
- **Căn cứ:** BR-OM-MOD-003, BR-KDS-EXC-003, SEC-02; HLR màn POS số 27.
- **Việc kéo theo:** làm R9 (Pha 3). P2-USR-006 và P2-ORD-003 chuyển sang Pha 3.

### P2-RFI-AUD — Nhật ký
- **Xuất file:** CSV UTF-8 có BOM, tối đa 10.000 dòng. Sắp xếp và phân trang như API hiện tại.
- **Lưu trữ:** ít nhất 2 năm. Không có API sửa hay xóa.
- **Bằng chứng "không sửa được":** trigger trong database chặn UPDATE/DELETE bảng `audit_log`. Đây là bằng chứng cho P2-AUD-005.
- **Dữ liệu cá nhân:** số điện thoại trong audit luôn che.
- **Căn cứ:** BR-OM-VER-003/004; HLR BR-009 và yêu cầu Auditability.
- **Việc kéo theo:** trigger, làm trong Pha 2. *Đã làm:* migration `0014_audit_log_immutable`, chi tiết ở `backend/app/db/audit_guard.py`.

### P2-RFI-QR — Mã QR và bảo mật
- **Cấp và thu hồi mã:**
  - Nhân viên cấp; mỗi phiên một mã ngẫu nhiên, hạn 4 giờ.
  - Thu hồi khi đóng phiên hoặc khi cấp mã mới.
  - Mã đi theo phiên khi chuyển hoặc gộp bàn.
- **Giới hạn:**
  - 10 request/giây mỗi IP;
  - tối đa 30 món chờ;
  - tối đa 5 lần nhập số điện thoại.
- **Gửi món:**
  - *Sửa 17/11 theo yêu cầu BE sau khi test luồng QR, khớp luồng QR của HLR:* món khách gọi **vào bếp ngay** (chế độ `DIRECT`, mặc định). Supervisor đổi sang "chờ phục vụ xác nhận" (`CONFIRM`, phiếu B6 cũ) cho từng cửa hàng ở `PATCH /outlet/settings`, có audit.
  - Khách ghi chú được cho từng món (tối đa 200 ký tự), bếp thấy ghi chú.
  - Khách không sửa đơn sau khi gửi.
  - Đã yêu cầu thanh toán thì không gọi thêm.
  - Khách tự yêu cầu thanh toán được (#77).
- **Mã hết hạn:** báo rõ hướng dẫn (410).
- **Quét nhầm bàn:** trang QR hiện rõ số bàn. Lần đầu gửi món, khách bấm xác nhận "Đúng bàn …" (FE; API đã trả `table_code`).
- **Căn cứ:**
  - BR-QR-001..010, BR-OM-MRG-009;
  - HLR: QR-HL-001..005, Table Management Edge Cases số 2 và 3.
- **Hiện trạng:** đã làm (#53, #77). FE thêm bước xác nhận bàn.

### P2-RFI-MOD — Tùy chọn món
- **Giá:** giá cộng thêm của tùy chọn chốt vào giá món lúc gọi.
- **Trạm bếp:** món đi trạm bếp của món, không tách theo tùy chọn.
- **Hết hàng:** tính theo từng tùy chọn.
- **Nhất quán:** gọi tại quầy và gọi qua QR kiểm tra giống nhau.
- **Căn cứ:** BRD Modifier Setup. HLR KIT-HL-005: bếp phải thấy rõ tùy chọn.
- **Hiện trạng:** đã làm (#54).

### P2-RFI-RWD — Điểm thưởng
- **Tích điểm:** 10.000đ = 1 điểm, tính trên số tiền thực trả.
- **Đổi điểm:**
  - 1 điểm = 100đ.
  - Đổi tối đa 50% hóa đơn.
  - Mỗi đơn 1 ưu đãi.
- **Hạn điểm:** hết hạn sau 12 tháng.
- **Khách qua QR:** chỉ tích điểm; đổi điểm ở quầy.
- **Hoàn điểm:** khi hoàn tiền **hết** đơn. Hoàn một phần không thu điểm.
- **Lỗi điểm thưởng** không chặn thanh toán.
- **Số điện thoại:** che với Cashier, chỉ Supervisor xem đủ.
- **Căn cứ:**
  - Nghị định 81/2018 (giảm giá không quá 50%);
  - BR-QR-003;
  - HLR: CRM-HL-001..005, BR-007, BR-008.
- **Việc kéo theo (Pha 2):**
  - chặn **tổng** giảm giá của đơn ≤ 50% (hiện ưu đãi theo % chưa chặn);
  - che số điện thoại theo vai trò.

### P2-RFI-MON — Giám sát
- **Ngưỡng cảnh báo:**
  - lỗi 5xx > 5% trong 5 phút;
  - thanh toán thành công < 95%;
  - món trễ > 20%;
  - tối thiểu 20 mẫu mới tính.
- **Người nhận cảnh báo:** BE, báo tiếp mentor.
- **Dữ liệu nhạy cảm:** che token, mật khẩu, số điện thoại trước khi gửi Sentry (`scrub_event`).
- **Lưu log:**
  - log Docker giữ 7 ngày (xoay vòng);
  - Sentry giữ theo gói miễn phí.
- **Việc kéo theo:** BE đặt `SENTRY_DSN` trên staging; thêm cấu hình xoay vòng log Docker. *Đã làm:* xoay vòng log (5 × 20 MB mỗi container, `docs/runbooks/monitoring.md`). Còn đặt `SENTRY_DSN`.

### P2-RFI-PERF — Hiệu năng
| Chỉ số | Mức chốt | Cách đo |
|---|---|---|
| QR | ≤ 30 giây | Từ lúc khách mở thực đơn tới lúc gửi món thành công, trên điện thoại 4G |
| API | p95 ≤ 2–3 giây | |
| Đồng bộ màn hình và bếp | ≤ 2–3 giây | Từ lúc lưu tới lúc máy khác nhận event |
| Gọi cổng thanh toán | chờ tối đa 10 giây | |
| Link VNPay | hạn 15 phút | |

- **Căn cứ:** BR-QR-001, BRD Performance; HLR KIT-HL-001, BR-002, CRM-HL-001.
- **Việc kéo theo:** đo trong lần test tải R4 trên staging.

### P2-RFI-VER — Xung đột phiên bản
- **Thao tác sửa đơn:** nhận thêm `expected_version` **không bắt buộc**. Không bắt buộc nên FE hiện tại không hỏng.
- **Lệch phiên bản:** trả 409 kèm `current_version`.
- **Gửi lại cùng `Idempotency-Key`:** nhận kết quả cũ.
- **Căn cứ:** BR-OM-VER-005/006.
- **Việc kéo theo:** làm R8 (Pha 3). P2-ORD-001/002 chuyển sang Pha 3.

### P2-RFI-SCOPE — Phạm vi
- **Pha 2 (tới 20/11):**
  - QR Ordering, Rewards;
  - thanh toán v2 + VNPay sandbox;
  - chuyển, gộp, tách bàn;
  - phân quyền sửa được;
  - báo cáo audit;
  - giám sát.
- **Pha 3 (23/11–04/12, SIT/UAT):**
  - VAT / hóa đơn điện tử (có hàng đợi gửi lại, không chặn bán hàng);
  - KDS đầy đủ;
  - PIN;
  - `expected_version`;
  - stub ERP và offline.
- **Sau go-live (18/12):**
  - kho và BOM (PO chuyển ra khỏi Pha 2 từ 23/10, dù HLR có INV-HL và BOM-HL);
  - khu vực và sơ đồ bàn kéo thả, đặt bàn;
  - đủ 10 trạng thái bàn của TABLE-HL-007;
  - combo, gửi món theo lượt;
  - chạy offline thật.

## Quyết định — câu hỏi mở thêm

| Câu hỏi | Chốt | Lý do |
|---|---|---|
| Supervisor chuyển bàn vượt sức chứa | **Giữ**, bắt buộc ghi lý do, có audit | HLR Table Management Edge Cases số 5: "allow manager override" |
| Hoàn một phần tiền có thu điểm theo tỉ lệ không | **Không** | Hoàn một phần thường để bù món lỗi, khách vẫn dùng bữa |
| Cashier tự hủy lần thanh toán ghi nhầm | **Không**, chỉ Supervisor. Riêng link VNPay chưa trả thì Cashier hủy được | Thao tác chạm tới tiền; HLR BR-009 |
| Mật khẩu tài khoản seed 6 ký tự | Nâng lên 8 cho khớp quy tắc chung, báo QA trước khi đổi | Đồng nhất quy tắc mật khẩu |

## Việc cần làm sau khi chốt

**BE, Pha 2:**
1. Chặn tổng giảm giá của đơn ≤ 50%.
2. Che số điện thoại khách với Cashier.
3. Trigger chặn UPDATE/DELETE bảng `audit_log`.
4. Xoay vòng log Docker, đặt `SENTRY_DSN` staging.
5. *(Nếu kịp)* API để khách tự tạo link VNPay từ trang QR.

**FE, Pha 2:**
- tách bill theo % và chia đều theo số khách;
- cảnh báo khi mở bàn vượt số chỗ;
- bước xác nhận "Đúng bàn" trên trang QR;
- câu báo 409 khi chuyển bàn, kèm ô lý do vượt sức chứa cho Supervisor.

**QA:**
- cập nhật cột "Quyết định tạm thời", "Status", "Ngày chốt" trong sheet RFI theo file này;
- chuyển các testcase đã ghi "chuyển sang Pha 3" ra khỏi bộ Pha 2.

## Hệ quả

- QA có kết quả mong đợi cho các testcase đang "Design only", nên chạy được trước SIT 23/11.
- Có 2 chỗ lệch đã ghi rõ:
  - chặn chuyển bàn đã yêu cầu thanh toán (lệch HLR TABLE-HL-018);
  - khách không thao tác bàn (lệch ma trận BRD).
- Nếu PO muốn khớp đúng tài liệu thì mở lại ở Pha 3.
- Số liệu điểm thưởng (tỉ lệ tích/đổi, hạn 12 tháng) là đề xuất của BE theo mức phổ biến của F&B. Đổi số liệu chỉ cần sửa cấu hình, không cần sửa code.
