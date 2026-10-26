# ENV-QA-04 — yêu cầu fixture QA Sprint 3

**Ngày:** 26/10/2026. **Trạng thái:** chuẩn bị, chưa seed/chạy mutation.  
**Áp dụng cho:** QR-001..024, RW-001..020 và các case billing/payment liên quan.

| Fixture QA cô lập | BE/CRM cần cung cấp | Kiểm tra trước khi dùng | Cleanup/hậu kiểm cần chốt |
| --- | --- | --- | --- |
| Bàn + QR | Outlet, table_id, table_session_id, token hợp lệ/hết hạn/thu hồi/sai bàn; TTL và cách cấp token | Bàn thuộc QA, đúng phiên, token không lộ thông tin riêng | Đóng order QA, thanh toán sandbox nếu cần, mark-clean đúng phiên; token hết hiệu lực |
| Hai thiết bị | Hai context/thiết bị độc lập cùng quét một QR; request_id và cách retry | Cùng table_session, không dùng order của người khác | Đối chiếu số order/item/ticket không trùng; đóng từng order QA |
| Menu + KDS | Item mapped station, item unavailable và stock race nếu Inventory nằm trong scope | Tên/ID món QA, trạm, trạng thái ban đầu | Khôi phục chỉ item QA; kiểm tra ticket bị dọn/đã DONE/CANCELLED |
| POS/QR đồng phiên | Tài khoản Waiter/Supervisor QA và order POS trong phiên QR | Role/outlet trùng fixture, bill chưa khóa | Đối chiếu source và audit, không sửa order không thuộc QA |
| Rewards/CRM | Tenant QA, member có điểm/không điểm/nonmember, balance, reward đủ/hết hạn, ledger baseline | Không dùng số điện thoại thật; policy/rule version đã duyệt | Reconcile earn/redeem/reversal; reset member QA theo owner CRM |
| Payment | Sandbox CASH/CARD/QR success/failure/timeout/UNKNOWN, callback ký thử | Không phát sinh tiền thật; callback chỉ gửi vào sandbox | Đối chiếu attempt/order/bill/ledger; dọn bàn sau PAID/CLOSED |

## Gate trước business automation

1. BE/CRM ghi người sở hữu fixture, ngày seed, SHA staging, ID và policy nguồn. Không ghi credential vào Git/evidence.
2. QA xác nhận quyền reset/cleanup cụ thể; không dùng reset chung staging khi còn người khác test.
3. Chạy một dry-run read-only: GET table/session/menu/member balance, ghi snapshot IDs và trạng thái trước.
4. Chỉ sau khi contract + fixture được xác nhận mới bật Postman API mutation; Playwright cho màn QR/Rewards sau khi FE route có trên cùng build.

**Blocker 26/10:** DES-QA-07 trên staging `46d6049b7228bfe023a42c84269fb3fb8464be63` chưa thấy operation QR/Rewards/payment Phase 2 trong OpenAPI. Chưa có fixture chính thức hoặc cleanup contract, nên chưa thể đánh ENV-QA-04 Hoàn tất.
