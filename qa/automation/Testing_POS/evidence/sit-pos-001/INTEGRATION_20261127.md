# Tích hợp SIT vào QA CD ngày 27/11/2026

## Trạng thái xác minh
- Người dùng đã kiểm tra evidence SIT 16 bước và cho phép tích hợp.
- PR #113 đã merge vào ONLY_TESTING tại `613728752a8a497db9ea07a4c77ebb484ed32d50`.
- Workflow SIT được caller ghim ở revision đã review `e6114907f92d2f4b45cb81a6aeffc56c6abd57ce`. QA checkout thực thi được ghim riêng theo output của job ba gate.
- PR #120 đã đạt test, frontend, Docker và CodeQL rồi merge vào main tại `18105a871ee5ce7ec03741621a4cc6c53d13938b`. Backend CI/deploy và QA CD tự động của SHA mới đều Success.

## Thay đổi
1. Workflow SIT nhận full application SHA và full QA source SHA, không ghim cứng build cũ.
2. Ba gate xuất qa_sha. SIT phụ thuộc job ba gate. Job kết luận yêu cầu cả ba gate và SIT đều Success.
3. Checker yêu cầu một report mới ở thư mục root, đủ 16 Step ID duy nhất đều Passed, cleanup Pass và SHA trước/sau đúng application target.
4. Thiếu report, report lỗi, thiếu run ID hoặc cờ privacy không hợp lệ đều trả exit 1.
5. Luôn chạy validation, summary và upload artifact sau lỗi. PIN chỉ cấp cho bước browser test, không đổi secret.
6. Dùng checkout tách biệt theo run/attempt, Playwright Docker 1.63.0 và concurrency group staging. Container được dừng bằng trap khi bước kết thúc.

## Bằng chứng kiểm tra cấu hình và script
- 26/26 Node test liên quan Passed, gồm 9 test evidence checker.
- YAML/shell và Playwright discovery hợp lệ.
- Shell kết luận chạy thật với các tổ hợp success/success trả 0, success/failure, success/skipped và failure/skipped đều trả 1.
- Các kiểm tra trên chỉ xác minh policy CI, không tăng số testcase nghiệp vụ Passed.

## Phép thử lỗi CI có kiểm soát
[Run 46018397853](https://github.com/Mouse-hybrid/DU-AN-THUC-TAP/actions/runs/46018397853) cố ý Failed, không sử dụng PIN, không gọi staging và không tạo giao dịch.

| Đầu vào | Kết quả thực tế | Artifact |
| --- | --- | --- |
| Overall PASSED nhưng bước 14 FAILED | Checker exit 1, job Failed, passed_steps 15/16 | controlled-sit-rejection-failed_step-46018397853 |
| Overall PASSED, đủ 16 bước, cleanup=false | Checker exit 1, job Failed | controlled-sit-rejection-cleanup_failed-46018397853 |

Cả hai job upload thành công SIT_GATE.json, summary và đầu vào kiểm soát. SHA ứng dụng trong mẫu lịch sử là d6ee04a, QA source là 6137287. Đây là chứng minh xử lý lỗi, không phải lỗi sản phẩm hoặc run SIT mới trên staging.

## Phân biệt nguồn kết quả
- Phase 1 dùng baseline lịch sử 114/116 cùng hai smoke khớp SHA triển khai, tránh cộng trùng testcase.
- Phase 2 57/71 đạt ngưỡng ≥80%.
- UX/UI 39/42 đạt ngưỡng >90%.
- Evidence historical giữ ngày và SHA gốc.
- SIT 16 bước là một Playwright test UI + API trên fixture QA3, không phải 16 testcase UI riêng hoặc toàn bộ ba suite được chạy lại.
- Workbook SIT đã chốt evidence cũ RUN-20261127133953699-SITPOS001 trên d6ee04a. Kết quả đó giữ nguyên khi pipeline tích hợp chạy trên build mới.

## Chạy thử tích hợp trước deploy
[Run 46019316496](https://github.com/Mouse-hybrid/DU-AN-THUC-TAP/actions/runs/46019316496) đã chạy đúng graph ba gate → reusable SIT → kết luận. Cả ba job Success.
- Report RUN-20261127144951858-SITPOS001, 16/16 Passed, cleanup Pass, SHA d6ee04a trước/sau khớp.
- QA source 613728752a8a497db9ea07a4c77ebb484ed32d50.
- Artifact có SIT_GATE.json, report, summary và hai ảnh nghiệp vụ.
- Gate Phase 1 OPEN, historical 114/116 và 2/2 smoke. Phase 2 57/71, UX/UI 39/42.
- Đây là preflight cấu hình gọi workflow, chưa phải run sau deploy SHA 18105a8.

## Kết quả sau deploy đã xác minh
- [Backend CI/deploy 46019871992](https://github.com/Mouse-hybrid/DU-AN-THUC-TAP/actions/runs/46019871992) Success. Các job frontend, test, docker-build và deploy-staging đều Success.
- Log deploy xác nhận health/ready/OpenAPI, anonymous guard và đúng SHA ứng dụng `18105a871ee5ce7ec03741621a4cc6c53d13938b`.
- [QA CD 46021668995](https://github.com/Mouse-hybrid/DU-AN-THUC-TAP/actions/runs/46021668995) được kích hoạt bằng workflow_run sau Backend CI của main, kết luận Success.
- Ba job verify-staging, SIT 16 steps after three gates / sit và Require gates and SIT success đều Success, không có job bắt buộc Skipped.
- Report `RUN-20261127150553845-SITPOS001`, đủ 16 Step ID đều Passed. SIT_GATE.json có result PASSED, passed_steps=16, cleanup_pass=true, build_stable=true và errors=[].
- Application SHA trước/sau khớp 18105a8. QA source thực thi `58845f0f0820ee08fcea0097ac2fc361c1a75c3f`. Workflow gọi được ghim ở e611490.
- PaymentPanel đổi ngay 200.000 → 180.000đ sau ưu đãi 10%, ui_stale=false. CASH 90.000đ và VNPay sandbox 90.000đ qua signed Return. Đối soát hai payment SUCCEEDED, một EARN và audit/export đạt.
- Cleanup xác nhận đơn CLOSED, Q3-1/Q3-2/Q3-3 AVAILABLE. Cờ PIN/token/phone/signed URL/card recorded đều false.
- Gate Phase 1 OPEN với 114/116 lịch sử và 2/2 smoke mới trên 18105a8. Phase 2 57/71, UX/UI 39/42 là historical baselines.
- Artifacts `sit-pos-001-46021668995-attempt-1` và `three-gates-postdeploy-46021668995` được tải về và đối chiếu. JSON được lưu bất biến trong history/policy-proofs để tránh phụ thuộc thời hạn artifact.

### Phạm vi vận hành
QA CD này kiểm chứng sau khi staging đã deploy. Job Failed hoặc Skipped bắt buộc sẽ làm kết luận QA Failed. Workflow không tự rollback staging hoặc nghiệm thu UAT. Các phần UI ngoài assertion vẫn theo ghi chú phạm vi trong workbook SIT.

## Bàn giao cho ngày 30/11
Sử dụng tài liệu này cùng các JSON bất biến để viết phần automation và CI/CD của báo cáo QAQC. Báo cáo ghi rõ phạm vi API/UI, ngưỡng gate, fixture và cleanup, bảo vệ secret, các nhánh lỗi, hạn lưu artifact 14 ngày và các phần chưa nghiệm thu UAT. Chỉ ghi trạng thái sau deploy theo bằng chứng thực tế ở phần trên.
