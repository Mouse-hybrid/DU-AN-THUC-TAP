# Sprint 4 — QA freeze draft, Test Summary và carryover

**Ngày chốt:** 16/11/2026 (giờ Việt Nam)  
**Staging baseline:** `c7e9b0d60c569f6870cfd5da073747cc6d9a8e77`  
**Quyết định:** Báo cáo QA đã lập; nghiệm thu UAT và quyết định go/no-go của PO chưa diễn ra.

## Kết quả đối chiếu

| Chỉ số | Kết quả |
| --- | ---: |
| Testcase Phase 2 | 71 |
| Passed trong Test Cases (bao gồm lịch sử SHA cũ) | 36 |
| Pending | 11 |
| Failed | 2 |
| Not Executed | 22 |
| Testcase có record trên SHA này trong checkpoint | 27 |
| Record được index gắn BUSINESS_PASS_EVIDENCE | 24 |
| Record cần review | 3 |
| Execution Log lịch sử được giữ nguyên | 114 dòng |
| Bug bàn còn mở | 2 |
| RFI còn Open | 13 |
| Evidence báo cleanup cần xử lý | 0 |

Checkpoint là **chỉ mục evidence**, không tự đổi Status của Test Cases. Passed ở SHA khác vẫn là kết quả lịch sử. P2-AUD-002 từng Passed với fixture trùng timestamp trên SHA cũ; lượt đọc trên SHA này Pending vì thiếu fixture để khẳng định lại nhánh tie-break. PF-P2-PAY-009 và P2-TBL-011 chỉ Pass ở nhánh hẹp, nên toàn testcase vẫn Pending.

## Task ID Sprint 4

| Task ID | Công việc | Trạng thái đúng danh sách chọn | Căn cứ / việc còn lại |
| --- | --- | --- | --- |
| S4-QA-01 | Chốt baseline & carryover | Hoàn tất | Đã hoàn tất phần QA: 71 ID duy nhất; 36 Passed, 11 Pending, 2 Failed, 22 Not Executed sau đối chiếu. 27 ID có record c7, 44 không; blocker có owner/điều kiện mở. |
| S4-QA-02 | Chốt staging & fixture theo module | Hoàn tất | Đã hoàn tất gate QA3: Version/health/OpenAPI ổn định c7; Q3-1/2 fixture riêng, cleanup 0 treo. Gateway/Sentry là gate riêng chưa sẵn. |
| S4-QA-03 | Hoàn thiện runner & evidence | Hoàn tất | Đã hoàn tất runner trong phạm vi đã chạy: API và Playwright có SHA, scope, cleanup, evidence; giữ nguyên run lỗi và không in secret. Các nhánh chưa có fixture giữ Pending. |
| S4-QA-04 | Staff, RBAC & audit | Đang thực hiện | USR-001/003/009 và MON-005 có evidence; USR-002/004/005/008 và AUD-005 thiếu policy/DB trace/full role scope. |
| S4-QA-05 | Hoàn thiện QR/Rewards Sprint 3 | Đang thực hiện | QR-003/004/005 và RWD-005/006/011 có evidence c7; reward UI Pass; RWD-001/004, QR-014 và RWD-009 chưa đủ rule/fixture. |
| S4-QA-06 | UI đã có và luồng POS | Đang thực hiện | Rehearsal UI đã hoàn tất: role guard 4/4, audit và KDS chỉ đọc 2/2; POS lifecycle/cleanup và reward apply/remove UI Pass. QR customer UI/UAT chưa chạy. |
| S4-QA-07 | Transfer/merge/split bàn | Đang thực hiện | Merge/split và outlet guard có run Pass; transfer BR-TT-010 và sức chứa có 2 bug mở. TBL-011 Pending policy split order/bàn. |
| S4-QA-08 | Payment v2 & Rewards recovery | Đang thực hiện | CASH Payment v2, role guard và split replay Pass; PAY-002..006, PAY-008/009 và RWD-009 chưa đủ sandbox/tax-policy/failure reversal. |
| S4-QA-09 | Monitoring & bảo mật log | Bị chặn | MON-005 Pass, audit export Pass; MON-001..004 chưa có quyền đọc log/Sentry và ngưỡng alert/redaction được chốt. |
| S4-QA-10 | SIT & hồi quy P0/P1 | Đang thực hiện | SIT API PF Pass; hồi quy Phase 1 an toàn 2/2; UI chỉ đọc 6/6 trên c7. Audit filter và transfer còn lỗi; không suy full P0/P1 Pass. |
| S4-QA-11 | Chuẩn bị UAT & hỗ trợ thử | Đang thực hiện | Checklist bốn vai trò đã sẵn trong docs/S4_UAT_HANDOFF_20261116.md; UAT người dùng thực chưa chạy. |
| S4-QA-12 | QA freeze & báo cáo cuối Sprint 4 | Đang thực hiện | Test Summary/carryover và bản nháp QA freeze đã lập: đối chiếu 71 ID, 0 cleanup treo, 2 bug bàn mở, 13 RFI Open. UAT thực và PO go/no-go còn chờ. |

## Lỗi và điều kiện mở

| Vấn đề | Tình trạng và bằng chứng | Owner / điều kiện mở lại |
| --- | --- | --- |
| BUG-P2-TBL-001 / P2-TBL-001 | Failed theo BR-TT-010: transfer trả 200, nguồn CLEANING thay vì AVAILABLE; UI cũng tái hiện. Cleanup Pass. | BE bàn; PO/BA xác nhận expected hoặc sửa BE rồi QA retest trên SHA mới. |
| BUG-P2-TBL-006 / P2-TBL-006 | Failed: chuyển 3 khách vào bàn 2 chỗ được chấp nhận; cleanup Pass. | BE bàn và PO/BA chốt policy sức chứa/override; QA retest. |
| Audit range UI | Lọc 7 ngày đã gửi cùng `created_from` với 30 ngày ở run thất bại; còn cần bản sửa và retest. | FE/BE xác nhận query và tổng hiển thị. |
| Payment v2 online/reversal | CARD/VNPay/callback thất bại/hoàn điểm thiếu sandbox hoặc chính sách Finance/PO. | BE/Finance cấp fixture chữ ký, failure và tax/discount/fee; QA chạy từng testcase đúng scope. |
| Monitoring | MON-001..004 chưa có quyền đọc log/Sentry hoặc policy alert/redaction. | BE/DevOps/PO cấp quyền và ngưỡng, rồi QA kiểm trace. |
| UAT | Checklist 4 vai trò đã chuẩn bị; người dùng thực chưa nghiệm thu. | Tổ chức UAT, ghi feedback và PO xác nhận riêng. |

## Đề xuất QA đến mốc 18/11

Đề xuất **chưa Go cho nghiệm thu toàn bộ Sprint 4** ở snapshot này: hai lỗi bàn mở, 11 Pending, 22 Not Executed, UAT chưa chạy và các nhánh gateway/monitoring còn gate. Có thể khóa bản evidence và danh sách carryover hiện tại như một mốc QA nội bộ. Khi có bản sửa hoặc fixture/policy, chạy retest theo SHA mới, bổ sung Execution Log theo từng run, cập nhật Test Cases/Bug Report, sau đó PO mới quyết định go/no-go. Không ghi đè lịch sử.

## Danh sách 71 testcase chuyển tiếp

| Test ref | Status trong Test Cases | Task ID | Evidence trên SHA c7 | Việc tiếp theo / giới hạn |
| --- | --- | --- | --- | --- |
| P2-PAY-001 | Passed | S4-QA-08 | BUSINESS_PASS_EVIDENCE: P2_PAY_001_2026-11-13_c7e9b0d.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-PAY-002 | Not Executed | S4-QA-08 | Chưa có record current-build | Finance/BE cung cấp CARD sandbox và callback success; đối chiếu ledger, no PAN/CVV. |
| P2-PAY-003 | Not Executed | S4-QA-08 | Chưa có record current-build | Finance/BE cung cấp VNPay sandbox và callback; kiểm pending rồi success. |
| P2-PAY-004 | Not Executed | S4-QA-08 | Chưa có record current-build | BE/Finance cung cấp gateway failure/retry fixture; bill phải unpaid. |
| P2-PAY-005 | Not Executed | S4-QA-08 | Chưa có record current-build | BE/Finance cung cấp duplicate callback fixture/signature; chỉ một payment. |
| P2-PAY-006 | Not Executed | S4-QA-08 | Chưa có record current-build | BE/Security cung cấp invalid signature fixture; không đổi bill/ledger. |
| P2-PAY-007 | Pending | S4-QA-08 | Chưa có record current-build | PO/BE chốt missing amount: contract hiện mặc định trả hết; nhánh 0 và UNKNOWN đã 422. |
| P2-PAY-008 | Not Executed | S4-QA-08 | Chưa có record current-build | PO/BE chốt tax/discount/fee allocation và sandbox; hai CASH bill chỉ là PF. |
| P2-PAY-009 | Pending | S4-QA-08 | REVIEW_REQUIRED: PF_P2_PAY_009_20261116_c7e9b0d6.json | Bổ sung chuyển món đã trả sang bill khác; nhánh split paid child 409 đã Pass PF. |
| P2-PAY-010 | Passed | S4-QA-08 | BUSINESS_PASS_EVIDENCE: P2_PAY_010_SERVED_20261116_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-PAY-011 | Passed | S4-QA-08 | BUSINESS_PASS_EVIDENCE: P2_PAY_011_RETEST_2026-11-13_c7e9b0d.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-TBL-001 | Failed | S4-QA-07 | BUSINESS_PASS_EVIDENCE: P2_TBL_001_AUDIT_2026-11-13.json | BUG-P2-TBL-001: BE sửa nguồn AVAILABLE theo BR-TT-010 hoặc PO đổi rule; retest API/UI. |
| P2-TBL-002 | Passed | S4-QA-07 | BUSINESS_PASS_EVIDENCE: P2_TBL_002_20261116_082911_c7e9b0d6.json | Sửa actual/evidence đúng run 16/11; occupied-target 409 đã Pass trên c7. |
| P2-TBL-003 | Passed | S4-QA-07 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-TBL-004 | Passed | S4-QA-07 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-TBL-005 | Passed | S4-QA-07 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-TBL-006 | Failed | S4-QA-07 | Chưa có record current-build | BUG-P2-TBL-006: BE sửa/chốt override sức chứa, rồi retest sau deploy. |
| P2-TBL-007 | Passed | S4-QA-07 | BUSINESS_PASS_EVIDENCE: P2_TBL_007_20261115_200526.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-TBL-008 | Passed | S4-QA-07 | BUSINESS_PASS_EVIDENCE: P2_TBL_008_20261116_085615_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-TBL-009 | Passed | S4-QA-07 | BUSINESS_PASS_EVIDENCE: P2_TBL_009_20261116_090729_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-TBL-010 | Passed | S4-QA-07 | BUSINESS_PASS_EVIDENCE: P2_TBL_010_20261116_085858_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-TBL-011 | Pending | S4-QA-07 | REVIEW_REQUIRED: P2_TBL_011_20261115_200022.json | PO chốt split order/bàn; API/UI same-session đã Pass, full case Pending. |
| P2-TBL-012 | Passed | S4-QA-07 | BUSINESS_PASS_EVIDENCE: P2_TBL_012_2026-11-15.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-USR-001 | Passed | S4-QA-04 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-USR-002 | Pending | S4-QA-04 | Chưa có record current-build | PO/BE chốt denied-write audit policy; API deny 403/no mutation đã Pass PF. |
| P2-USR-003 | Passed | S4-QA-04 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-USR-004 | Pending | S4-QA-04 | Chưa có record current-build | BE chốt unlock/token lifecycle và audit; mới chứng minh lock một phần. |
| P2-USR-005 | Pending | S4-QA-04 | Chưa có record current-build | BE/Security chốt reset secret/token policy và negative branches. |
| P2-USR-006 | Not Executed | S4-QA-04 | Chưa có record current-build | PO/Security chốt PIN N-lần/cooldown/lockout; fixture an toàn. |
| P2-USR-007 | Not Executed | S4-QA-04 | Chưa có record current-build | BE/Security cung cấp refresh/revoke token contract và fixture. |
| P2-USR-008 | Pending | S4-QA-04 | Chưa có record current-build | PO chốt ma trận quyền BRD/BE; chạy từng API action theo role. |
| P2-USR-009 | Passed | S4-QA-04 | BUSINESS_PASS_EVIDENCE: P2_USR_009_RETEST_2026-11-13_c7e9b0d.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-AUD-001 | Passed | S4-QA-04 | BUSINESS_PASS_EVIDENCE: P2_AUD_001_002_003_READONLY_2026-11-13_124223.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-AUD-002 | Passed | S4-QA-04 | REVIEW_REQUIRED: P2_AUD_001_002_003_READONLY_2026-11-13_124223.json | Giữ Passed lịch sử; current c7 PENDING vì thiếu equal-timestamp fixture. |
| P2-AUD-003 | Passed | S4-QA-04 | BUSINESS_PASS_EVIDENCE: P2_AUD_001_002_003_READONLY_2026-11-13_124223.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-AUD-004 | Passed | S4-QA-04 | BUSINESS_PASS_EVIDENCE: P2_AUD_004_QA3_UI_2026-11-13.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-AUD-005 | Not Executed | S4-QA-04 | Chưa có record current-build | BE cung cấp chứng cứ DB immutability và system-error trace; PF audit GET không đủ. |
| P2-QR-001 | Passed | S4-QA-05 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-QR-002 | Not Executed | S4-QA-05 | Chưa có record current-build | FE/BE cung cấp customer UI và out-of-stock fixture; API menu PF chưa đủ. |
| P2-QR-003 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_QR_003_004_005_SIT_20261116_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-QR-004 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_QR_003_004_005_SIT_20261116_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-QR-005 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_QR_003_004_005_SIT_20261116_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-QR-006 | Passed | S4-QA-05 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-QR-007 | Not Executed | S4-QA-05 | Chưa có record current-build | BE cung cấp expired/wrong/revoked token fixture và denial proof. |
| P2-QR-008 | Not Executed | S4-QA-05 | Chưa có record current-build | BE/FE kiểm cross-table/cross-outlet và customer UI; PF same-outlet chưa đủ. |
| P2-QR-009 | Not Executed | S4-QA-05 | Chưa có record current-build | PO/BE chốt sửa order sau submit và staff exception; chạy UI/API. |
| P2-QR-010 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_QR_010_PRICE_DISCOUNT_2026-11-13.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-QR-011 | Passed | S4-QA-05 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-QR-012 | Passed | S4-QA-05 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-QR-013 | Not Executed | S4-QA-05 | Chưa có record current-build | FE/BE cung cấp public QR request-bill flow đúng bàn. |
| P2-QR-014 | Pending | S4-QA-05 | Chưa có record current-build | BE/QA tạo mất phản hồi sau commit, replay đúng một order/ticket. |
| P2-QR-015 | Not Executed | S4-QA-05 | Chưa có record current-build | PO/QA chốt mốc đo và môi trường SLA ≤30s, rồi đo full QR flow. |
| P2-RWD-001 | Pending | S4-QA-05 | Chưa có record current-build | PO/CRM chốt mask PII theo role; create/lookup PF đã Pass. |
| P2-RWD-002 | Passed | S4-QA-05 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-RWD-003 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_RWD_003_010_RETEST_2026-11-13_c7e9b0d.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-RWD-004 | Pending | S4-QA-05 | Chưa có record current-build | PO/CRM chốt eligibility theo khách/rule; min-order và UI reward PF Pass. |
| P2-RWD-005 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_RWD_005_SIT_20261116_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-RWD-006 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_RWD_006_RETEST_2026-11-13_c7e9b0d.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-RWD-007 | Passed | S4-QA-05 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-RWD-008 | Passed | S4-QA-05 | Chưa có record current-build | Giữ Pass lịch sử; chỉ retest chọn lọc khi build/risk thay đổi. |
| P2-RWD-009 | Not Executed | S4-QA-08 | Chưa có record current-build | Finance/PO chốt reversal; cần payment failure gateway và ledger/points proof. |
| P2-RWD-010 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_RWD_003_010_RETEST_2026-11-13_c7e9b0d.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-RWD-011 | Passed | S4-QA-05 | BUSINESS_PASS_EVIDENCE: P2_RWD_011_2026-11-13_c7e9b0d.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-MON-001 | Not Executed | S4-QA-09 | Chưa có record current-build | DevOps cấp Sentry/log test access, correlation/build context, redaction. |
| P2-MON-002 | Not Executed | S4-QA-09 | Chưa có record current-build | DevOps/Security cấp log read và policy mask credential/PII/payment. |
| P2-MON-003 | Not Executed | S4-QA-09 | Chưa có record current-build | BE/DevOps cung cấp gateway error fixture và correlation ID. |
| P2-MON-004 | Not Executed | S4-QA-09 | Chưa có record current-build | PO/DevOps chốt threshold/owner escalation, kiểm alert không lặp. |
| P2-MON-005 | Passed | S4-QA-09 | BUSINESS_PASS_EVIDENCE: P2_MON_005_20261116_c7e9b0d6.json | Giữ evidence c7; retest khi thay đổi build hoặc yêu cầu liên quan. |
| P2-ORD-001 | Not Executed | S4-QA-07 | Chưa có record current-build | PO/BE chốt expected_version contract và 409 current_version trên write. |
| P2-ORD-002 | Pending | S4-QA-07 | Chưa có record current-build | PO/BE chốt version policy cho các order write; split replay riêng đã Pass. |
| P2-ORD-003 | Not Executed | S4-QA-07 | Chưa có record current-build | PO/Security chốt Supervisor PIN/lockout; fixture void isolated. |

## Nguồn và giới hạn

- Workbook 71 testcase cập nhật: Test Cases, Dashboard, RFI & Gaps, Bug Report; Execution Log giữ nguyên 114 dòng.
- Workbook Sprint 4 cập nhật: trạng thái 12 task và mapping đủ 71 ID; các ghi chú nói rõ nhánh đã Pass và nhánh còn thiếu.
- Evidence index: `S4_EVIDENCE_CHECKPOINT_20261116_c7e9b0d6_v2.json` (148 JSON, 27 ref current-build, 24 business pass evidence, 3 review).
- Checklist UAT: `S4_UAT_HANDOFF_20261116.md`. API SIT và các Playwright preflight không thay thế UAT người dùng thực.
- Không có quyền và mật khẩu staging trong workspace hiện tại; báo cáo này đối chiếu dữ liệu đã nhận, không tạo thêm lượt test.
