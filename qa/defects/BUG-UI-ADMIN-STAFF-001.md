# BUG-UI-ADMIN-STAFF-001 — Nội dung trang quản trị nhân viên bị cắt ở màn hình di động

- **Trạng thái:** Open — cần frontend xác nhận và sửa
- **Mức độ ảnh hưởng:** Medium (UI/responsive)
- **Ưu tiên đề xuất:** P2
- **Môi trường:** POS staging, WebKit, cấu hình thiết bị Galaxy S9+ trong `playwright.config.ts`
- **Vai trò / đường dẫn:** admin, `/admin/staff`
- **Liên kết test:** `PF-UI-AUTH-003` — Pass (đăng nhập, điều hướng và GET `/api/v1/staff` thành công); không kiểm tra thao tác bấm nút
- **Ngày ghi nhận:** 2026-11-09

## Cách tái hiện

1. Chạy `pos-smoke.spec.ts` trên project `webkit` với PIN staging hợp lệ, hoặc đăng nhập bằng tài khoản admin trên màn hình di động tương đương.
2. Mở trang `/admin/staff`.
3. Quan sát thanh điều hướng trên cùng, mô tả trang, nhóm nút `Làm mới`, `Xuất danh sách`, `Thêm nhân viên` và các thẻ thống kê.

## Kết quả thực tế

Trong ảnh do QA cung cấp, nội dung bị cắt ở mép phải khung nhìn: biểu tượng cuối trên thanh điều hướng chỉ hiện một phần; dòng mô tả dưới tiêu đề kết thúc giữa chừng; thẻ thống kê bên phải không hiển thị trọn. Nhóm nút hành động xếp thành ba hàng, chiếm gần hết chiều ngang và cần rà lại khoảng cách, khả năng hiển thị trên màn hình hẹp. Chưa có bằng chứng rằng thao tác bấm nút thất bại.

## Kết quả mong đợi

Thanh điều hướng, mô tả, các nút hành động và thẻ thống kê hiển thị đầy đủ trong chiều rộng màn hình di động; nội dung không bị cắt ngoài khung nhìn. Các nút có nhãn và vùng bấm rõ ràng.

## Bằng chứng và phạm vi

- Ảnh/video màn hình `/admin/staff` do QA cung cấp trong cuộc trao đổi ngày 2026-11-09. QA lưu bản gốc cùng defect khi đồng bộ evidence.
- Lượt chạy `npx playwright test pos-smoke.spec.ts --project=webkit --grep 'PF-UI-AUTH' --timeout=60000`: **3 passed (8.7s)**, gồm waiter, kitchen, admin.
- Báo cáo/video Playwright trên máy QA: `qa/automation/Testing_POS/playwright-report/` và `qa/automation/Testing_POS/test-results/` (tệp sinh cục bộ, không theo dõi bởi Git).
- Route guard trước đó: **4/4 Pass**. Không chuyển `PF-UI-AUTH-003` thành Fail vì test hiện chỉ xác nhận đăng nhập, điều hướng, API đọc và không có ghi dữ liệu.

## Kiểm tra lại sau khi sửa

Mở `/admin/staff` trên WebKit ở kích thước Galaxy S9+ và kiểm tra không còn nội dung bị cắt theo chiều ngang; xem đủ nhãn của ba nút và thẻ thống kê. Kiểm tra thêm thao tác bấm riêng nếu có testcase chức năng phù hợp.
