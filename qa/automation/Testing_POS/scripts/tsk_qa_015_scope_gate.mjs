// TSK-QA-015: read-only scope gate for negative stock PIN and POS offline chaos.
// A decision file is an approved QA transcription of PO/BE decisions, not an API fixture.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [inventoryFile, decisionFile, outputFile] = process.argv.slice(2);
if (!inventoryFile) {
  console.error('Usage: node tsk_qa_015_scope_gate.mjs DES_QA_07.json [DECISION.json|-] [EVIDENCE.json]');
  process.exit(1);
}
const inventory=JSON.parse(readFileSync(inventoryFile,'utf8'));
const decision=decisionFile && decisionFile !== '-' ? JSON.parse(readFileSync(decisionFile,'utf8')) : null;
if (!/^[a-f0-9]{40}$/i.test(inventory.commit||'') || !inventory.groups)
  throw new Error('Invalid DES-QA-07 inventory: full SHA and groups required');
const decisionCurrent=decision?.staging_commit===inventory.commit &&
  typeof decision?.decision_source==='string' && decision.decision_source.trim().length>0;
const inventoryContract=Array.isArray(inventory.groups.inventory)&&inventory.groups.inventory.length>0;
const negative=[];
if(!inventoryContract)negative.push('Inventory/BOM operation absent from live OpenAPI');
if(!decisionCurrent)negative.push('PO/BE decision source missing or belongs to another SHA');
if(decision?.negative_stock_policy_confirmed!==true)negative.push('Negative-stock policy not approved');
if(decision?.supervisor_pin_schema_confirmed!==true)negative.push('Supervisor PIN request/validation contract not confirmed');
if(decision?.owned_stock_fixture_and_cleanup!==true)negative.push('Owned stock fixture and cleanup not confirmed');
const offline=[];
if(!decisionCurrent)offline.push('PO offline scope decision missing or belongs to another SHA');
if(decision?.offline_scope!=='in_scope'&&decision?.offline_scope!=='deferred')
  offline.push('offline_scope must be explicitly in_scope or deferred');
if(decision?.offline_scope==='in_scope' && decision?.offline_test_environment_confirmed!==true)
  offline.push('Offline test environment / replay policy not confirmed');
const rows=[
  {branch:'Negative stock with Supervisor PIN',readiness:negative.length?'BLOCKED':'REVIEW_REQUIRED',
    blockers:negative,execution:'NOT_EXECUTED'},
  {branch:'POS offline / IndexedDB chaos',
    readiness:offline.length?'BLOCKED':decision.offline_scope==='deferred'?'DEFERRED':'REVIEW_REQUIRED',
    blockers:offline,execution:'NOT_EXECUTED'},
];
const result={task:'TSK-QA-015',checked_at:new Date().toISOString(),staging_commit:inventory.commit,
  scope:'Decision and contract readiness only; no PIN or offline business test',
  counts:{total:2,blocked:rows.filter(r=>r.readiness==='BLOCKED').length,
    deferred:rows.filter(r=>r.readiness==='DEFERRED').length,
    review_required:rows.filter(r=>r.readiness==='REVIEW_REQUIRED').length,business_pass:0},
  branches:rows,
  note:'Do not infer PIN presence from an inventory path. Deferred requires an explicit PO decision; neither branch is a business Pass.'};
if(outputFile){mkdirSync(dirname(outputFile),{recursive:true});writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({task:result.task,staging_commit:result.staging_commit,counts:result.counts,branches:rows},null,2));
process.exitCode=result.counts.blocked?2:0;
