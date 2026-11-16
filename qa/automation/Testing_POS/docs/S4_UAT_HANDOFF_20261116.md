# Bàn giao checklist UAT Sprint 4 — staging QA3

QA chuẩn bị ngày 16/11/2026 cho bốn vai trò người dùng thực. Tài liệu này chưa phải kết quả UAT hoặc xác nhận của PO.

## Baseline và dữ liệu thử

- Build staging: `c7e9b0d60c569f6870cfd5da073747cc6d9a8e77`. Kiểm `/version` trước/sau mỗi lượt; nếu SHA đổi thì lập run mới.
- Dùng tài khoản QA3 và fixture Q3-1/Q3-2 cô lập. Ghi ID bàn, session, order, item và payment thuộc lượt thử; không reset dữ liệu dùng chung.
- Nhập PIN/mật khẩu riêng; không đưa token, số điện thoại đầy đủ hoặc bí mật thanh toán vào ảnh và ghi chú.
- Mỗi kịch bản ghi UAT ID, người thử và vai trò, thời gian, build, thao tác, expected, actual, evidence, issue ID và cleanup.

## Kịch bản người dùng thực

| UAT ID | Vai trò | Thao tác | Kết quả mong đợi | Evidence QA hiện có |
| --- | --- | --- | --- | --- |
| S4-UAT-01 | Phục vụ | Mở bàn QA3, thêm món POS, gửi bếp | Một session/order; món vào KDS | API/UI đã diễn tập; UAT chưa chạy |
| S4-UAT-02 | Bếp | Đọc queue, bắt đầu nấu, đánh dấu sẵn sàng | Đúng trạm/món/trạng thái; không nhân ticket | API/UI đã diễn tập; UAT chưa chạy |
| S4-UAT-03 | Phục vụ | Nhận món, phục vụ, yêu cầu thanh toán | Món SERVED, bill đúng session/bàn | Luồng QA3 đã diễn tập; UAT chưa chạy |
| S4-UAT-04 | Thu ngân | Gắn khách QA, áp rồi gỡ ưu đãi hợp lệ | Bill giảm rồi trở về số tiền gốc | UI đã diễn tập; UAT chưa chạy |
| S4-UAT-05 | Thu ngân | Thanh toán CASH đủ bill, đóng và dọn bàn | Một payment đúng tiền; bàn CLEANING rồi AVAILABLE | Payment v2 API Pass; luồng UI trước đó dùng thanh toán mô phỏng; UAT chưa chạy |
| S4-UAT-06 | Quản lý | Mở Nhân viên, Vai trò, Audit, Hồ sơ, Lịch sử | Màn được phép hiển thị; đọc được audit | UI chỉ đọc đã diễn tập; UAT chưa chạy |
| S4-UAT-07 | Thu ngân | Thử vào màn Vai trò chỉ dành cho quản lý | Bị từ chối, không đổi dữ liệu | UI guard đã diễn tập; UAT chưa chạy |

## Điều kiện mở các nhánh bổ sung

- Chuyển bàn: BR-TT-010 yêu cầu bàn nguồn AVAILABLE; run UI trên build này quan sát CLEANING. Chờ BE/PO chốt và retest trước khi nghiệm thu nhánh này.
- Thanh toán online/callback và hoàn điểm: cần sandbox gateway, fixture chữ ký/lỗi và policy Finance/PO. `/pay` mô phỏng là phạm vi khác.
- Monitoring: cần quyền đọc Sentry/log và ngưỡng/owner cảnh báo SLA trước khi chạy P2-MON-001..004.
- QR khách trên trình duyệt: chờ route UI khách và thiết bị/trình duyệt thử; evidence QR hiện có ở phạm vi API.

## Ghi nhận và dọn fixture

Mỗi lượt lưu ảnh/video không chứa secret, tóm tắt HTTP/lỗi khi cần và phản hồi của chính người thử. Chỉ đóng order thuộc fixture: xác minh CLOSED, món SERVED, ticket DONE, không còn ticket/session hoạt động, bàn AVAILABLE; staff/reward/customer tạm thời đã khóa hoặc vô hiệu hóa. Ca bị chặn ghi owner và điều kiện mở lại. Diễn tập QA không thay chữ ký nghiệm thu UAT của người dùng thực.

## Evidence đã có trên build này

- SIT API `RUN-20261116030017689-S4SIT`: POS + QR chung session, hai món KDS đã phục vụ, ưu đãi FIXED 1đ, Payment v2 CASH 89.999đ, audit đúng, QR thu hồi, cleanup Pass.
- QR `RUN-20261116025406986-P2QR003004005`; Rewards `RUN-20261116024824433-P2RWD005`; đổi role/thanh toán/audit `RUN-20261116024254977-P2MON005`.
- Báo cáo Playwright cùng SHA có role guard, KDS chỉ đọc, audit, dialog split/merge và UI áp/gỡ reward. Dùng đúng run report/ảnh/video tương ứng; danh sách này không phải một lượt chạy mới.
