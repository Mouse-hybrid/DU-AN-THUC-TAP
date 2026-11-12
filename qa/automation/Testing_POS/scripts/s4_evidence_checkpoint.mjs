// Read local Phase 2 JSON evidence against the 71-ID manifest and one staging SHA.
// Produces a review checkpoint only; never edits testcase workbooks or evidence.
import {readFileSync, readdirSync, statSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, relative, dirname, join} from 'node:path';

const [,,manifestArg,evidenceArg,outputArg,...extraEvidenceArgs]=process.argv;
const sha=process.env.POS_EXPECTED_COMMIT;
if(!manifestArg||!evidenceArg||!outputArg||!/^[0-9a-f]{40}$/.test(sha||'')){
  console.error('Usage: POS_EXPECTED_COMMIT=<full SHA> node scripts/s4_evidence_checkpoint.mjs MANIFEST.json EVIDENCE_DIR OUTPUT.json');
  process.exit(2);
}
const manifest=JSON.parse(readFileSync(manifestArg,'utf8'));
const ids=new Set(manifest.cases?.map(x=>x.id));
if(ids.size!==71)throw Error('Expected exactly 71 unique baseline IDs');
const root=resolve(evidenceArg),output=resolve(outputArg);
const roots=[evidenceArg,...extraEvidenceArgs].map(dir=>resolve(dir));
const files=[];
function walk(dir,sourceRoot){
  for(const ent of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,ent.name);
    if(ent.isDirectory())walk(path,sourceRoot);
    else if(ent.isFile()&&ent.name.toLowerCase().endsWith('.json')&&
      resolve(path)!==output&&statSync(path).size<=2_000_000)files.push({path,sourceRoot});
  }
}
for(const sourceRoot of roots)walk(sourceRoot,sourceRoot);
const evidence=[],preflight=[],unreadable=[],cleanupRequired=[];
for(const {path:file,sourceRoot} of files){
  let data;
  try{data=JSON.parse(readFileSync(file,'utf8'));}catch{unreadable.push(relative(root,file));continue;}
  if(!data||typeof data!=='object'||Array.isArray(data))continue;
  const build=data.staging_commit||data.build_before||data.commit;
  if(build!==sha)continue;
  const needsCleanup=Array.isArray(data.cleanup_required)
    ?data.cleanup_required.length>0
    :typeof data.cleanup_required==='string' ?data.cleanup_required.length>0 :data.cleanup_required===true;
  const source=sourceRoot===root?relative(root,file).replaceAll('\\','/'):
    relative(process.cwd(),file).replaceAll('\\','/');
  if(needsCleanup)cleanupRequired.push(source);
  const raw=[];
  if(typeof data.test_ref==='string')raw.push([data.test_ref,data.result]);
  for(const [id,result] of Object.entries(data.case_results||{}))raw.push([id,result]);
  if(Array.isArray(data.cases))for(const row of data.cases)
    if(row?.tc_id)raw.push([row.tc_id,row.result]);
  for(const [id,result] of raw){
    if(id.startsWith('PF-')){preflight.push({ref:id,result,source});continue;}
    if(!ids.has(id))continue;
    const staffRolePartial=id==='P2-USR-001'&&/\bWAITER\b/.test(String(data.scope||''))&&
      !Array.isArray(data.roles)||
      id==='P2-USR-003'&&data.create_http===201&&data.patch_http===200&&
      data.assertions_passed===true&&!data.audit;
    const historicalRewards=['P2-RWD-003','P2-RWD-010'].includes(id)&&data.mutations===0&&
      typeof data.source_run_id==='string'&&data.checks?.rwd_003_balance_and_history===true&&
      data.checks?.rwd_010_isolation===true;
    const staffOutletGuard=id==='P2-USR-009'&&data.assertions_passed===true&&
      typeof data.fixture_staff_id==='string'&&data.own_get_http===200&&
      data.foreign_get_http===404&&data.foreign_patch_http===404&&
      data.unchanged===true&&data.no_foreign_data===true;
    const limited=staffRolePartial||String(data.business_case||data.business_cases||'').includes('NOT_EXECUTED')||
      /(?:ONLY|UI_NOT_TESTED)/.test(String(data.case_coverage||'')+' '+String(data.full_case_status||''));
    const executed=data.business_execution==='EXECUTED';
    const auditRequestOnly=Array.isArray(data.requests)&&data.requests.length>0&&
      data.requests.every(req=>req?.method==='GET'||
        req?.method==='POST'&&req?.path==='/api/v1/auth/login');
    const readOnlyAudit=id.startsWith('P2-AUD-')&&
      (data.mutations===0||auditRequestOnly);
    const cleanupOk=readOnlyAudit||historicalRewards||data.cleanup_pass===true||
      data.cleanup?.inactive===true||
      id.startsWith('P2-USR-')&&data.cleanup?.locked===true;
    const stable=data.build_stable===true||data.build_before===sha&&data.build_after===sha;
    const pass=result==='PASSED'&&!limited&&(executed||readOnlyAudit||historicalRewards||staffOutletGuard)&&cleanupOk&&stable&&
      data.secrets_recorded!==true;
    const time=data.checked_at||data.run_at_utc||null;
    evidence.push({ref:id,result,review:pass?'BUSINESS_PASS_EVIDENCE':'REVIEW_REQUIRED',
      source,run_id:data.run_id||null,checked_at:time,
      reason:pass?null:result!=='PASSED'?'Outcome '+String(result):
        staffRolePartial?id==='P2-USR-001'?'One WAITER role verified; full role coverage requires review':
          'Role change API checks only; audit/sensitive action not asserted':
        limited?'Partial/not executed scope':
        !stable?'Build not proven stable':!cleanupOk?'Cleanup not proven':
        !(executed||readOnlyAudit||historicalRewards||staffOutletGuard)?'Business execution not proven':'Outcome requires review'});
  }
}
const latest=new Map();
for(const row of evidence){
  const prev=latest.get(row.ref);
  if(!prev||String(row.checked_at||'')>String(prev.checked_at||''))latest.set(row.ref,row);
}
const latestRows=[...latest.values()].sort((a,b)=>a.ref.localeCompare(b.ref));
const report={task:'Sprint 4 evidence checkpoint',staging_commit:sha,
  baseline_cases:ids.size,scanned_json_files:files.length,unreadable_json:unreadable,
  preflight_records:preflight.length,cleanup_required_files:cleanupRequired,
  observed_case_refs:latestRows.length,
  latest_business_pass_evidence:latestRows.filter(x=>x.review==='BUSINESS_PASS_EVIDENCE').length,
  latest_review_required:latestRows.filter(x=>x.review!=='BUSINESS_PASS_EVIDENCE').length,
  latest_current_build:latestRows,
  note:'Evidence index only. Historical Pass on another SHA and PF results do not become business Pass; preserve Excel status and all run history.'};
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output:outputArg,summary:{
  baseline_cases:report.baseline_cases,scanned_json_files:report.scanned_json_files,
  preflight_records:report.preflight_records,observed_case_refs:report.observed_case_refs,
  latest_business_pass_evidence:report.latest_business_pass_evidence,
  latest_review_required:report.latest_review_required,
  cleanup_required_files:report.cleanup_required_files,
},note:report.note},null,2));
