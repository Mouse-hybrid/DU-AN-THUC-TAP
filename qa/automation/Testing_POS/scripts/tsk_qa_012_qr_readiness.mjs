// TSK-QA-012: read-only case-level execution gate. Never sends QR orders.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [inventoryFile, fixtureGateFile, outputFile] = process.argv.slice(2);
if (!inventoryFile || !fixtureGateFile) {
  console.error('Usage: node tsk_qa_012_qr_readiness.mjs DES_QA_07.json ENV_QA_04_GATE.json [EVIDENCE.json]');
  process.exit(1);
}
const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
const fixture = JSON.parse(readFileSync(fixtureGateFile, 'utf8'));
if (!/^[a-f0-9]{40}$/i.test(inventory.commit || '') || !inventory.groups ||
    fixture.staging_commit !== inventory.commit) {
  throw new Error('DES-QA-07 / ENV-QA-04 SHA mismatch or malformed inventory; no case can be prepared');
}
const cases = [
  ['QR-003', 'Token gắn đúng bàn/phiên', 'token'],
  ['QR-004', 'Token hết hạn, thu hồi, sai', 'token'],
  ['QR-005', 'QR đặt nhầm bàn', 'token'],
  ['QR-019', 'Token giả mạo, truy cập chéo', 'token'],
  ['QR-001', 'Zero-login và mốc 30 giây', 'public_ui'],
  ['QR-010', 'Double tap cùng request_id', 'retry'],
  ['QR-011', 'Cùng request_id khác body', 'retry'],
  ['QR-012', 'Mất mạng rồi retry', 'retry'],
  ['QR-002', 'Số điện thoại tùy chọn', 'member'],
  ['QR-006', 'Không chọn món hết hàng', 'menu'],
  ['QR-007', 'Hết hàng lúc checkout', 'menu'],
  ['QR-008', 'Hai khách cùng bàn', 'multi_device'],
  ['QR-009', 'POS và QR cùng thêm món', 'pos'],
  ['QR-013', 'Không sửa đơn sau submit', 'order'],
  ['QR-014', 'Billing khóa submit QR', 'billing'],
  ['QR-015', 'SENT tới đúng trạm bếp', 'kds'],
  ['QR-016', 'Modifier và ghi chú', 'modifier'],
  ['QR-017', 'Trạng thái món thời gian thực', 'realtime'],
  ['QR-018', 'QR idle, hết hạn, giữ giỏ', 'token'],
  ['QR-020', 'Bill, source, audit khi gộp', 'billing'],
  ['QR-021', 'Chuyển bàn giữ đơn QR', 'table_advanced'],
  ['QR-022', 'MAIN sau course fired', 'course'],
  ['QR-023', 'POS offline, QR online', 'offline'],
  ['QR-024', 'Bếp quá tải có kiểm soát', 'load'],
];
const qrAvailable = Array.isArray(inventory.groups.qr) && inventory.groups.qr.length > 0;
const rows = cases.map(([id, purpose, branch], index) => {
  const blockers = [];
  if (!qrAvailable) blockers.push('QR operation absent from live OpenAPI');
  if (fixture.status !== 'READY_FOR_QA_REVIEW') blockers.push('ENV-QA-04 fixture gate not ready');
  if (branch === 'table_advanced' && !(inventory.groups.table_advanced || []).length)
    blockers.push('advanced table contract absent');
  if (branch === 'modifier' && !(inventory.groups.modifier || []).length)
    blockers.push('modifier contract absent');
  // A candidate path alone cannot establish schema, authorization, FE route or policy.
  return {id, order: index + 1, purpose, branch,
    readiness: blockers.length ? 'BLOCKED' : 'REVIEW_REQUIRED', blockers,
    execution: 'NOT_EXECUTED'};
});
const output = {task:'TSK-QA-012', checked_at:new Date().toISOString(),
  staging_commit:inventory.commit, scope:'24 QR design cases; read-only gate only',
  first_wave:['QR-003','QR-004','QR-005','QR-019','QR-001','QR-010','QR-011','QR-012'],
  counts:{total:rows.length, blocked:rows.filter(row=>row.readiness==='BLOCKED').length,
    review_required:rows.filter(row=>row.readiness==='REVIEW_REQUIRED').length,
    business_pass:0}, cases:rows,
  next_gate:'BE QR schema/policy, FE public route, approved fixture/cleanup; then review assertion and execute isolated business tests.'};
if (outputFile) {
  mkdirSync(dirname(outputFile), {recursive:true});
  writeFileSync(outputFile, JSON.stringify(output,null,2)+'\n');
}
console.log(JSON.stringify({task:output.task, staging_commit:output.staging_commit,
  first_wave:output.first_wave, counts:output.counts, next_gate:output.next_gate},null,2));
process.exitCode = output.counts.blocked ? 2 : 0;
