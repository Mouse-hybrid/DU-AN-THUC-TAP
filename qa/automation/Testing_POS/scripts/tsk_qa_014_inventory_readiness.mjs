// TSK-QA-014: static BOM/stock readiness gate. No inventory or menu mutations.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [inventoryFile, fixtureFile, outputFile] = process.argv.slice(2);
if (!inventoryFile) {
  console.error('Usage: node tsk_qa_014_inventory_readiness.mjs DES_QA_07.json [STOCK_FIXTURE.json|-] [EVIDENCE.json]');
  process.exit(1);
}
const source = JSON.parse(readFileSync(inventoryFile, 'utf8'));
const fixture = fixtureFile && fixtureFile !== '-' ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : null;
if (!/^[a-f0-9]{40}$/i.test(source.commit || '') || !source.groups)
  throw new Error('Invalid DES-QA-07 inventory; full SHA and groups required');
const has = group => Array.isArray(source.groups[group]) && source.groups[group].length > 0;
const stockFixtureReady = fixture && fixture.staging_commit === source.commit &&
  typeof fixture.owner === 'string' && fixture.owner.length > 0 &&
  fixture.stock_fixture_confirmed === true && fixture.cleanup_approved === true;
const branches = [
  {name:'BOM and stock deduction', refs:['TSK-QA-014'], needs:['inventory'], policy:'bom_policy_confirmed'},
  {name:'Sold-out synchronized on QR and POS', refs:['QR-006','QR-007','TSK-QA-014'], needs:['inventory','qr'], policy:'soldout_policy_confirmed'},
  {name:'Stock update latency', refs:['TSK-QA-014'], needs:['inventory','qr'], policy:'latency_threshold_approved'},
];
const rows = branches.map(b => {
  const blockers = b.needs.filter(group=>!has(group)).map(group=>`${group} operation absent from live OpenAPI`);
  if (!stockFixtureReady) blockers.push('Owned stock/BOM fixture and cleanup not confirmed on this SHA');
  if (!fixture || fixture[b.policy] !== true) blockers.push(`${b.policy} not approved`);
  if (b.policy === 'latency_threshold_approved' && !(Number.isFinite(fixture?.latency_ms) && fixture.latency_ms > 0))
    blockers.push('Approved latency_ms missing');
  return {branch:b.name, testcase_refs:b.refs, readiness:blockers.length?'BLOCKED':'REVIEW_REQUIRED',
    blockers, execution:'NOT_EXECUTED'};
});
const result={task:'TSK-QA-014', checked_at:new Date().toISOString(), staging_commit:source.commit,
  scope:'BOM/stock, Sold-out and approved sync latency; static gate only',
  counts:{total:rows.length, blocked:rows.filter(r=>r.readiness==='BLOCKED').length,
    review_required:rows.filter(r=>r.readiness==='REVIEW_REQUIRED').length, business_pass:0},
  branches:rows, note:'Menu is_available does not prove stock deduction or sold-out sync. Review deployed schema, FE routes, fixture and timing method before business tests.'};
if(outputFile){mkdirSync(dirname(outputFile),{recursive:true});writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({task:result.task,staging_commit:result.staging_commit,counts:result.counts,branches:rows},null,2));
process.exitCode=result.counts.blocked?2:0;
