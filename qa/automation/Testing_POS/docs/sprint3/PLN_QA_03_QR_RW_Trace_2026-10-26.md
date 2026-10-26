# PLN-QA-03 — trace baseline QR/Rewards Sprint 3

**Ngày:** 26/10/2026. **Trạng thái:** QA design complete; business execution gated.

Nguồn: hai workbook v0.2 (24 QR, 20 Rewards), BRD/HLR và BE API catalog §D.
Các tên contract dưới đây là **ứng viên cần BE chốt**, không chứng nhận endpoint đã triển khai.
Staging `46d6049b7228bfe023a42c84269fb3fb8464be63` có 31 paths/35 operations; kiểm kê DES-QA-07 ngày 26/10 không thấy operation Phase 2 được đặt tên theo các nhóm này.

| TC ID | Testcase | Priority | Req ID | Contract cần chốt | RFI / phụ thuộc | Execution |
| --- | --- | --- | --- | --- | --- | --- |
| QR-001 | Zero-login và thời gian gửi món | Critical | BR-QR-001/002; QR-HL-001 | QR token/menu/order public | QR-RFI-01/03/04 | Not Executed |
| QR-002 | Số điện thoại là tùy chọn | Critical | BR-QR-003; QR-HL-002 | QR public order + member optional | QR-RFI-04; RW-RFI-01 | Not Executed |
| QR-003 | Gắn đúng bàn và phiên | Critical | BR-QR-004; QR-HL-003; TABLE-HL-017 | QR token → table_session → order | QR-RFI-01/04 | Not Executed |
| QR-004 | Token hết hạn/thu hồi/sai | Critical | QR-HL-005 | QR token validation/revoke | QR-RFI-01 | Not Executed |
| QR-005 | Tấm QR đặt nhầm bàn | High | BRD QR edge case | QR token/table binding | QR-RFI-01/04 | Not Executed |
| QR-006 | Không thể chọn món hết hàng | Critical | BR-QR-007; QR-HL-004 | Public QR menu availability | QR-RFI-05 | Not Executed |
| QR-007 | Hết hàng ngay lúc checkout | Critical | BR-QR-007; INV-HL-011 | QR order checkout + availability race | QR-RFI-05 | Not Executed |
| QR-008 | Hai khách chung một bàn | Critical | BR-OM-MRG-001/002/005 | Public QR orders; two request IDs | QR-RFI-04 | Not Executed |
| QR-009 | POS và QR cùng thêm món | Critical | BR-QR-009; BR-OM-MRG-002/004 | QR + POS order/session link | QR-RFI-04 | Not Executed |
| QR-010 | Double tap cùng request_id | Critical | BR-QR-005; BR-OM-VER-006 | QR order request_id replay | QR-RFI-04 | Not Executed |
| QR-011 | Cùng request_id, khác body | Critical | BR-QR-005 | QR order request_id conflict | QR-RFI-04 | Not Executed |
| QR-012 | Mất mạng và retry | Critical | BR-QR-010 | QR order retry after lost response | QR-RFI-04 | Not Executed |
| QR-013 | Khách không sửa đơn sau submit | Critical | BR-QR-008 | Public QR order read/write policy | QR-RFI-04 | Not Executed |
| QR-014 | Billing khóa QR submit | Critical | BR-OM-MRG-009; SRS BR-006 | QR order vs request-billing lock | QR-RFI-04 | Not Executed |
| QR-015 | Chỉ món SENT tới đúng trạm bếp | Critical | BR-QR-006; BR-OM-MRG-003 | QR order → kitchen queue routing | QR-RFI-04/05 | Not Executed |
| QR-016 | Modifier và ghi chú qua QR | High | HLR QR flow; BE-S3-03 | QR modifier schema and pricing | QR-RFI-05 | Not Executed |
| QR-017 | Trạng thái món theo thời gian thực | High | HLR QR live status; KIT-HL-001 | QR order status / realtime UI | QR-RFI-04; FE contract | Not Executed |
| QR-018 | QR idle, hết hạn và giữ giỏ | High | BRD QR edge case: cart X phút | QR cart idle and token expiry | QR-RFI-01/02 | Not Executed |
| QR-019 | Token giả mạo và truy cập chéo | Critical | QR-HL-003; security | QR token tamper/cross-table access | QR-RFI-01 | Not Executed |
| QR-020 | Bill, source và audit khi gộp | Critical | BR-OM-MRG-006/008; SRS audit | Order bill/source/audit across QR+POS | QR-RFI-04 | Not Executed |
| QR-021 | Chuyển bàn giữ đơn QR | High | BR-OM-MRG-002/004; TABLE-HL-018 | Advanced transfer preserving QR association | QR-RFI-05; PO scope | Not Executed |
| QR-022 | MAIN sau khi course đã fired | High | BR-OM-MRG-010; BRD edge case | Course/fire order policy | QR-RFI-05; PO scope | Not Executed |
| QR-023 | POS offline, QR online | High | BRD merge edge case | Offline POS + online QR coexistence | PO offline scope | Not Executed |
| QR-024 | Bếp quá tải có kiểm soát | High | BRD QR overload edge case | QR/KDS overload and performance | QR-RFI-03; capacity fixture | Not Executed |
| RW-001 | Nhận diện qua số điện thoại | Critical | BE-S3-04; HLR CRM | Customer lookup by phone | RW-RFI-01/05 | Not Executed |
| RW-002 | Nhận diện qua mã thành viên | High | BE-S3-04 | Member QR identity | RW-RFI-01/05 | Not Executed |
| RW-003 | Bỏ qua Rewards | Critical | BR-QR-003; QR-HL-002 | Optional Rewards skip | RW-RFI-01 | Not Executed |
| RW-004 | Lấy reward và lý do đủ điều kiện | Critical | BRD 9.5.2–9.5.3 | Reward eligibility read | RW-RFI-01/05 | Not Executed |
| RW-005 | Áp dụng một reward hợp lệ | Critical | BRD 9.5.5; CRM-HL-001 | Apply reward to order | RW-RFI-01/05 | Not Executed |
| RW-006 | Reward hết hạn/đã dùng/thiếu điểm | Critical | BRD 9.5.3 | Expired/used/insufficient points | RW-RFI-01/05 | Not Executed |
| RW-007 | Ngăn cộng dồn sai | Critical | CRM-HL-004 | Apply reward stacking rules | RW-RFI-02/03 | Not Executed |
| RW-008 | Giới hạn khuyến mãi cấu hình | Critical | CRM-HL-003; SRS BR-008 | Promotion cap and rule version | RW-RFI-02 | Not Executed |
| RW-009 | Supervisor override và audit | Critical | CRM-HL-005 | Supervisor override + audit | RW-RFI-03/05 | Not Executed |
| RW-010 | Retry apply không trừ điểm hai lần | Critical | BRD 9.5.5–9.5.6 | Apply replay / idempotency | RW-RFI-05 | Not Executed |
| RW-011 | Redeem đồng thời trên hai bill | Critical | BRD 9.5.6 | Concurrent redeem on two bills | RW-RFI-05 | Not Executed |
| RW-012 | CRM lỗi không khóa payment | Critical | CRM-HL-002; SRS BR-007 | CRM failure/payment fallback | RW-RFI-04/05 | Not Executed |
| RW-013 | SLA Rewards ≤30 giây | Critical | CRM-HL-001; SRS conflict-02 | Rewards response timing | RW-RFI-04 | Not Executed |
| RW-014 | Gỡ reward trước pay | High | BRD 9.5.5–9.5.6 | Remove reward before pay | RW-RFI-05 | Not Executed |
| RW-015 | Không lộ dữ liệu Rewards | Critical | Security; CRM-HL-005 | Customer/reward PII RBAC | RW-RFI-01/05 | Not Executed |
| RW-016 | Hoàn điểm khi refund/hủy | High | BRD 9.5.6 | Refund/cancel and points reversal | RW-RFI-03/05 | Not Executed |
| RW-017 | Bill thay đổi phải tính lại eligibility | Critical | BR-CRM-002; supplement §9.5.3 (Draft) | Bill change → eligibility recalculation | RW-RFI-01/05 | Not Executed |
| RW-018 | Tích điểm đúng một lần sau pay | High | supplement §9.5.6 (Draft) | Pay → earn exactly once | RW-RFI-01/05 | Not Executed |
| RW-019 | Theo dõi earn/redeem/reversal | High | supplement §9.5.6 (Draft) | Earn/redeem/reversal ledger | RW-RFI-05 | Not Executed |
| RW-020 | Client sửa số tiền giảm giá | Critical | BR-CRM-002; supplement §9.5.3 (Draft) | Reject client-edited discount amount | RW-RFI-02/05 | Not Executed |

## Gate để thực thi

1. BE gửi SHA/PR và OpenAPI live có schema, mã HTTP, role, idempotency; QA chạy lại preflight cùng SHA.
2. PO/CRM/Finance chốt QR TTL, request_id, quy tắc member/điểm, promotion, payment failure/reversal và scope modifier/offline/inventory.
3. ENV-QA-04 có fixture sở hữu rõ: bàn/QR token, hai thiết bị, menu/KDS, member ledger, payment sandbox và cleanup.
4. Mỗi case chạy mới được thay Not Executed bằng Passed/Failed/Blocked kèm build, IDs, log và hậu kiểm dữ liệu. Preflight chỉ chứng minh readiness.

## Disposition hiện tại

- 24 QR + 20 Rewards = 44 case thiết kế, tất cả Not Executed trong workbook gốc.
- Công việc QA trace/design có thể review; business automation bị chặn bởi contract/fixture/deploy. Không đánh 44 case Passed.
