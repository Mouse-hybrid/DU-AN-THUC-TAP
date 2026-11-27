import {readdirSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

const [directory,expected]=process.argv.slice(2);
if(!directory){console.error('Usage: node check_sit_gate.mjs EVIDENCE_DIRECTORY EXPECTED_SHA');process.exit(1);}
mkdirSync(directory,{recursive:true});
const errors=[];
const isSha=value=>typeof value==='string' && /^[a-f0-9]{40}$/.test(value);
if(!isSha(expected))errors.push('Expected staging SHA must be a full commit');
const qa=process.env.QA_SOURCE_SHA;
if(!isSha(qa))errors.push('QA source SHA must be a full commit');
const files=readdirSync(directory).filter(name=>/^SIT_POS_001_[A-Za-z0-9_-]+\.json$/.test(name));
let report=null;
if(files.length!==1)errors.push('Exactly one current SIT report is required');
else{
 try{
  report=JSON.parse(readFileSync(join(directory,files[0]),'utf8'));
  if(!report || typeof report!=='object' || Array.isArray(report)){
   errors.push('Current SIT report must be an object');report=null;
  }
 }
 catch{errors.push('Current SIT report is invalid JSON');}
}
const expectedIds=Array.from({length:16},(_,i)=>'SIT-POS-001-'+String(i+1).padStart(2,'0'));
if(report){
 if(report.test_ref!=='SIT-POS-001')errors.push('Unexpected SIT testcase reference');
 if(report.result!=='PASSED')errors.push('SIT overall result is not PASSED');
 if(report.cleanup_pass!==true)errors.push('SIT cleanup must pass');
 if(report.build_stable!==true)errors.push('SIT build stability must pass');
 if(report.staging_commit!==expected || report.build_after!==expected)errors.push('SIT application SHA mismatch');
 const steps=Array.isArray(report.steps)?report.steps:[];
 if(steps.length!==16)errors.push('All 16 SIT steps are required');
 if(new Set(steps.map(s=>s?.id)).size!==steps.length)errors.push('SIT step IDs must be unique; duplicate found');
 for(const id of expectedIds){
  const matching=steps.filter(s=>s?.id===id);
  if(matching.length!==1 || matching[0].status!=='PASSED')errors.push(id+' must pass exactly once');
 }
 for(const key of ['secrets_recorded','token_recorded','phone_recorded','signed_url_recorded','card_recorded'])
  if(report[key]!==false)errors.push('Evidence privacy flag must be false: '+key);
}
const runId=typeof report?.run_id==='string' && /^RUN-[A-Za-z0-9-]+$/.test(report.run_id)?report.run_id:null;
if(report && !runId)errors.push('SIT run ID is missing or invalid');
const validatedSteps=Array.isArray(report?.steps)?report.steps:[];
const gate={
 test_ref:'SIT-POSTDEPLOY-GATE',checked_at:new Date().toISOString(),
 result:errors.length?'FAILED':'PASSED',
 expected_staging_sha:isSha(expected)?expected:null,qa_source_sha:isSha(qa)?qa:null,
 observed_staging_sha:isSha(report?.staging_commit)?report.staging_commit:null,
 observed_build_after:isSha(report?.build_after)?report.build_after:null,
 sit_run_id:runId,report_file:files.length===1?files[0]:null,
 passed_steps:expectedIds.filter(id=>validatedSteps.some(s=>s?.id===id&&s.status==='PASSED')).length,
 cleanup_pass:report?.cleanup_pass===true,build_stable:report?.build_stable===true,
 actions_run_id:process.env.GITHUB_RUN_ID||null,actions_run_attempt:process.env.GITHUB_RUN_ATTEMPT||null,
 caller_workflow_ref:process.env.GITHUB_WORKFLOW_REF||null,errors
};
writeFileSync(join(directory,'SIT_GATE.json'),JSON.stringify(gate,null,2)+'\n');
const summary=['### SIT post-deploy evidence gate','',
 '| Field | Value |','| --- | --- |',
 '| Result | '+gate.result+' |',
 '| Application SHA | '+(gate.expected_staging_sha||'invalid')+' |',
 '| QA source SHA | '+(gate.qa_source_sha||'invalid')+' |',
 '| SIT run | '+(runId||'missing')+' |',
 '| Passed steps | '+gate.passed_steps+'/16 |',
 '| Cleanup | '+(gate.cleanup_pass?'Passed':'Failed / missing')+' |',
 '| Stable build | '+(gate.build_stable?'Passed':'Failed / missing')+' |',
 '',...errors.map(e=>'- '+e),'',
 'Historical Phase 1, Phase 2 and UX/UI baselines remain separate from this fresh SIT result.',''].join('\n');
writeFileSync(join(directory,'SIT_GATE_SUMMARY.md'),summary);
console.log('SIT evidence gate '+gate.result+'; steps='+gate.passed_steps+'/16; cleanup='+gate.cleanup_pass);
for(const error of errors)console.error(error);
process.exitCode=errors.length?1:0;

