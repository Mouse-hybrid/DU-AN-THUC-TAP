// EXE-QA-07: read-only, case-level gate for Rewards; no member lookup or mutation.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [inventoryFile, fixtureGateFile, outputFile] = process.argv.slice(2);
if (!inventoryFile || !fixtureGateFile) {
  console.error('Usage: node exe_qa_07_rewards_readiness.mjs DES_QA_07.json ENV_QA_04_GATE.json [EVIDENCE.json]');
  process.exit(1);
}
const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
const fixture = JSON.parse(readFileSync(fixtureGateFile, 'utf8'));
if (!/^[a-f0-9]{40}$/i.test(inventory.commit || '') || !inventory.groups ||
    fixture.staging_commit !== inventory.commit) {
  throw new Error('Inventory / fixture gate SHA mismatch or malformed inventory');
}
const cases = [
  ['RW-001','Phone identity'], ['RW-002','Member QR identity'],
  ['RW-003','Optional Rewards skip'], ['RW-004','Eligibility and reason'],
  ['RW-005','Apply valid reward'], ['RW-006','Expired/used/insufficient points'],
  ['RW-007','Stacking rules'], ['RW-008','Promotion cap/rule version'],
  ['RW-009','Supervisor override and audit'], ['RW-010','Same-key apply replay'],
  ['RW-011','Concurrent redeem on two bills'], ['RW-012','CRM failure/payment fallback'],
  ['RW-013','Rewards response timing'], ['RW-014','Remove reward before pay'],
  ['RW-015','Rewards PII/RBAC'], ['RW-016','Refund/cancel points reversal'],
  ['RW-017','Bill change recalculates eligibility'], ['RW-018','Earn exactly once after pay'],
  ['RW-019','Earn/redeem/reversal ledger'], ['RW-020','Reject edited discount amount'],
];
const paymentRelated = new Set(['RW-012','RW-016','RW-018','RW-019']);
const rewardContract = Array.isArray(inventory.groups.rewards) && inventory.groups.rewards.length > 0;
const paymentContract = Array.isArray(inventory.groups.payment_v2) && inventory.groups.payment_v2.length > 0;
const rows = cases.map(([id, purpose], index) => {
  const blockers = [];
  if (!rewardContract) blockers.push('Rewards operation absent from live OpenAPI');
  if (fixture.status !== 'READY_FOR_QA_REVIEW') blockers.push('ENV-QA-04 fixture gate not ready');
  if (paymentRelated.has(id) && !paymentContract) blockers.push('Payment v2 operation absent from live OpenAPI');
  return {id, order:index+1, purpose, readiness:blockers.length?'BLOCKED':'REVIEW_REQUIRED',
    blockers, execution:'NOT_EXECUTED'};
});
const output = {task:'EXE-QA-07', checked_at:new Date().toISOString(),
  staging_commit:inventory.commit, scope:'20 Rewards design cases; read-only gate only',
  first_wave:['RW-001','RW-003','RW-004','RW-015','RW-010','RW-011'],
  counts:{total:rows.length, blocked:rows.filter(row=>row.readiness==='BLOCKED').length,
    review_required:rows.filter(row=>row.readiness==='REVIEW_REQUIRED').length,
    business_pass:0}, cases:rows,
  next_gate:'BE Rewards schema; PO/CRM rule version and QA member/ledger fixture; payment sandbox for payment-related cases. Review assertions before business execution.'};
if (outputFile) {
  mkdirSync(dirname(outputFile), {recursive:true});
  writeFileSync(outputFile, JSON.stringify(output,null,2)+'\n');
}
console.log(JSON.stringify({task:output.task, staging_commit:output.staging_commit,
  first_wave:output.first_wave, counts:output.counts, next_gate:output.next_gate},null,2));
process.exitCode = output.counts.blocked ? 2 : 0;
