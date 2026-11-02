// Phase 2 case-level execution gate for the 71-case workbook.
// This script reads QA evidence only. It never executes a business testcase.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const [manifestFile, inventoryFile, fixtureFile, outputFile] = process.argv.slice(2);
if (!manifestFile || !inventoryFile || !fixtureFile || !outputFile) {
  console.error('Usage: node p2_71_sprint3_readiness.mjs MANIFEST.json DES_QA_07.json ENV_QA_04.json EVIDENCE.json');
  process.exit(1);
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const manifest = read(manifestFile);
const inventory = read(inventoryFile);
const fixture = read(fixtureFile);
if (manifest.schema_version !== 1 || !Array.isArray(manifest.cases) || manifest.cases.length !== 71)
  throw new Error('Expected exactly 71 Phase 2 design cases');
const ids = manifest.cases.map(c => c.id);
if (new Set(ids).size !== 71 || ids.some(id => !/^P2-[A-Z]+-\d{3}$/.test(id)))
  throw new Error('Duplicate or malformed Phase 2 Test ID');
for (const [prefix, count] of [['P2-QR-',15], ['P2-RWD-',11]]) {
  const actual = ids.filter(id => id.startsWith(prefix));
  const expected = Array.from({length:count}, (_,i) => `${prefix}${String(i+1).padStart(3,'0')}`);
  if (actual.length !== count || expected.some(id => !actual.includes(id)))
    throw new Error(`Missing ${prefix} design case in 71-case baseline`);
}
if (!/^[a-f0-9]{40}$/i.test(inventory.commit || '') || inventory.commit !== fixture.staging_commit ||
    !inventory.groups || typeof inventory.groups !== 'object')
  throw new Error('DES-QA-07 / ENV-QA-04 build mismatch or malformed evidence');

const has = group => Array.isArray(inventory.groups[group]) && inventory.groups[group].length > 0;
const rows = manifest.cases.map(c => {
  const sprint3 = c.module === 'QR Ordering' || c.module === 'Rewards System';
  if (!sprint3) return {id:c.id, module:c.module, priority:c.priority,
    readiness:'NOT_ASSESSED_IN_THIS_RUN', business_execution:'NOT_EXECUTED_IN_THIS_RUN'};
  const required = [c.module === 'QR Ordering' ? 'qr' : 'rewards'];
  if (['P2-QR-011','P2-QR-012'].includes(c.id)) required.push('modifier');
  if (['P2-RWD-009','P2-RWD-011'].includes(c.id)) required.push('payment_v2');
  const blockers = required.filter(group => !has(group))
    .map(group => `${group}: no candidate operation in live OpenAPI`);
  if (fixture.status !== 'READY_FOR_QA_REVIEW')
    blockers.push('ENV-QA-04 fixture and cleanup gate not ready');
  return {id:c.id, module:c.module, priority:c.priority,
    planned_operation:c.planned_operation, required_groups:required,
    readiness:blockers.length ? 'BLOCKED' : 'REVIEW_REQUIRED', blockers,
    business_execution:'NOT_EXECUTED_IN_THIS_RUN'};
});
const sprint3 = rows.filter(r => r.module === 'QR Ordering' || r.module === 'Rewards System');
const checkedAt = new Date().toISOString();
const stamp = checkedAt.replace(/\D/g, '').slice(0,14);
const runId = `RUN-${stamp.slice(0,8)}-P2S3-${stamp.slice(8,14)}`;
const result = {task:'Phase 2 Sprint 3 / 71-case readiness', run_id:runId, checked_at:checkedAt,
  staging_commit:inventory.commit, source_filename:manifest.source_filename,
  source_sha256:manifest.source_sha256, type:'READ_ONLY_GATE',
  counts:{baseline_cases:rows.length, sprint3_cases:sprint3.length,
    qr_cases:sprint3.filter(r=>r.module==='QR Ordering').length,
    rewards_cases:sprint3.filter(r=>r.module==='Rewards System').length,
    p0:sprint3.filter(r=>r.priority==='Critical').length,
    p1:sprint3.filter(r=>r.priority==='High').length,
    blocked:sprint3.filter(r=>r.readiness==='BLOCKED').length,
    review_required:sprint3.filter(r=>r.readiness==='REVIEW_REQUIRED').length,
    out_of_scope_this_run:rows.length-sprint3.length, business_pass_this_run:0},
  cases:rows,
  conclusion:'Readiness only. Missing contract/fixture leaves business testcase status Not Executed; do not log a business failure or Pass from this gate.'};
mkdirSync(dirname(outputFile), {recursive:true});
writeFileSync(outputFile, `${JSON.stringify(result,null,2)}\n`);
console.log(JSON.stringify({task:result.task, run_id:result.run_id, staging_commit:result.staging_commit,
  counts:result.counts, output:outputFile, conclusion:result.conclusion},null,2));
process.exitCode = result.counts.blocked ? 2 : 0;
