import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const real=JSON.parse(readFileSync(join(here,'../evidence/sit-pos-001/history/SIT_POS_001_RUN-20261127133953699-SITPOS001.json'),'utf8'));
function runCase(change,expectedStatus,expectedText){
 const dir=mkdtempSync(join(tmpdir(),'sit-gate-check-'));
 try{
  const report=structuredClone(real);
  if(typeof change==='function')change(report);
  if(change!=='missing')writeFileSync(join(dir,'SIT_POS_001_CURRENT.json'),JSON.stringify(report));
  const result=spawnSync(process.execPath,[join(here,'check_sit_gate.mjs'),dir,real.staging_commit],{
   env:{...process.env,QA_SOURCE_SHA:'1ea432157ae324afb73967a0015591b147bae4d9',
    GITHUB_RUN_ID:'offline-proof',GITHUB_RUN_ATTEMPT:'1'},encoding:'utf8'});
  assert.equal(result.status,expectedStatus,result.stderr||result.stdout);
  assert.ok(existsSync(join(dir,'SIT_GATE.json')),'Gate provenance must exist even on failure');
  assert.ok(existsSync(join(dir,'SIT_GATE_SUMMARY.md')),'Summary must exist even on failure');
  const gate=JSON.parse(readFileSync(join(dir,'SIT_GATE.json'),'utf8'));
  assert.equal(gate.result,expectedStatus===0?'PASSED':'FAILED');
  assert.equal(gate.expected_staging_sha,real.staging_commit);
  assert.equal(gate.qa_source_sha,'1ea432157ae324afb73967a0015591b147bae4d9');
  if(expectedText)assert.match(JSON.stringify(gate),expectedText);
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('accept the complete real 16-step report',()=>runCase(null,0));
test('reject a failed step even when overall result says PASSED',()=>runCase(r=>r.steps[13].status='FAILED',1,/SIT-POS-001-14/));
test('reject cleanup failure even when overall result says PASSED',()=>runCase(r=>r.cleanup_pass=false,1,/cleanup/));
test('reject deployed build mismatch',()=>runCase(r=>r.build_after='f'.repeat(40),1,/SHA/));
test('reject an incomplete step set',()=>runCase(r=>r.steps.pop(),1,/16/));
test('reject a duplicated step ID',()=>runCase(r=>r.steps[15].id=r.steps[14].id,1,/unique|duplicate/));
test('reject missing report and still save failure provenance',()=>runCase('missing',1,/report/));
test('reject a malformed steps object and still save provenance',()=>runCase(r=>r.steps={},1,/16/));
test('reject missing SIT run attribution',()=>runCase(r=>delete r.run_id,1,/run ID/));

