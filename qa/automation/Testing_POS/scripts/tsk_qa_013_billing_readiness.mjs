// TSK-QA-013: static execution gate for billing/reward/payment design branches.
// Reads prior QA evidence and PO decision flags; sends no HTTP request.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [inventoryFile, fixtureFile, policyFile, outputFile] = process.argv.slice(2);
if (!inventoryFile || !fixtureFile) {
  console.error('Usage: node tsk_qa_013_billing_readiness.mjs DES_QA_07.json ENV_QA_04_GATE.json [POLICY.json|-] [EVIDENCE.json]');
  process.exit(1);
}
const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
const policy = policyFile && policyFile !== '-' ? JSON.parse(readFileSync(policyFile, 'utf8')) : null;
if (!/^[a-f0-9]{40}$/i.test(inventory.commit || '') ||
    fixture.staging_commit !== inventory.commit || !inventory.groups) {
  throw new Error('Inventory/fixture SHA mismatch or malformed inventory');
}
const branches = [
  {name:'QR submit after billing lock', refs:['QR-014'], contract:['qr'], policy:'billing_lock_confirmed'},
  {name:'Split bill and duplicate confirmation', refs:['P2-PAY-008','P2-PAY-009','P2-PAY-010'], contract:['payment_v2'], policy:'split_bill_confirmed'},
  {name:'Payment failure, retry, duplicate callback', refs:['P2-PAY-004','P2-PAY-005','RW-012','P2-RWD-009'], contract:['payment_v2','rewards'], policy:'payment_error_states_confirmed'},
  {name:'Reward eligibility, cap, stacking', refs:['RW-004','RW-005','RW-007','RW-008','RW-020'], contract:['rewards'], policy:'reward_cap_confirmed'},
  {name:'Redeem replay and reversal', refs:['RW-010','RW-016','P2-RWD-006','P2-RWD-011'], contract:['rewards','payment_v2'], policy:'reward_reversal_confirmed'},
];
const rows = branches.map(branch => {
  const blockers = [];
  for (const group of branch.contract) {
    if (!Array.isArray(inventory.groups[group]) || inventory.groups[group].length === 0)
      blockers.push(`${group} operation absent from live OpenAPI`);
  }
  if (fixture.status !== 'READY_FOR_QA_REVIEW') blockers.push('ENV-QA-04 fixture gate not ready');
  if (!policy || policy.staging_commit !== inventory.commit || policy[branch.policy] !== true)
    blockers.push(`${branch.policy} not confirmed by PO/Finance/CRM for this build`);
  return {branch:branch.name, testcase_refs:branch.refs, readiness:blockers.length?'BLOCKED':'REVIEW_REQUIRED',
    blockers, execution:'NOT_EXECUTED'};
});
const result = {task:'TSK-QA-013', checked_at:new Date().toISOString(),
  staging_commit:inventory.commit, scope:'Five billing/payment/reward branches; static gate only',
  counts:{total:rows.length, blocked:rows.filter(r=>r.readiness==='BLOCKED').length,
    review_required:rows.filter(r=>r.readiness==='REVIEW_REQUIRED').length, business_pass:0},
  branches:rows, note:'Candidate paths and flags never prove business behavior. QA reviews exact schema, sandbox and owned cleanup before mutation.'};
if (outputFile) {
  mkdirSync(dirname(outputFile), {recursive:true});
  writeFileSync(outputFile, JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({task:result.task, staging_commit:result.staging_commit,
  counts:result.counts, branches:rows.map(r=>({branch:r.branch,readiness:r.readiness,blockers:r.blockers}))},null,2));
process.exitCode = result.counts.blocked ? 2 : 0;
