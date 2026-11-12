// Read local Phase 2 JSON evidence against the 71-ID manifest and one staging SHA.
// Produces a review checkpoint only; never edits testcase workbooks or evidence.
import {readFileSync, readdirSync, statSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, relative, dirname, join} from 'node:path';

const [,,manifestArg,evidenceArg,outputArg]=process.argv;
const sha=process.env.POS_EXPECTED_COMMIT;
if(!manifestArg||!evidenceArg||!outputArg||!/^[0-9a-f]{40}$/.test(sha||'')){
  console.error('Usage: POS_EXPECTED_COMMIT=<full SHA> node scripts/s4_evidence_checkpoint.mjs MANIFEST.json EVIDENCE_DIR OUTPUT.json');
  process.exit(2);
}
const manifest=JSON.parse(readFileSync(manifestArg,'utf8'));
const ids=new Set(manifest.cases?.map(x=>x.id));
if(ids.size!==71)throw Error('Expected exactly 71 unique baseline IDs');
const root=resolve(evidenceArg),output=resolve(outputArg);
const files=[];
function walk(dir){
  for(const ent of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,ent.name);
    if(ent.isDirectory())walk(path);
    else if(ent.isFile()&&ent.name.toLowerCase().endsWith('.json')&&
      resolve(path)!==output&&statSync(path).size<=2_000_000)files.push(path);
  }
}
walk(root);
const evidence=[],preflight=[],unreadable=[],cleanupRequired=[];
for(const file of files){
  let data;
  try{data=JSON.parse(readFileSync(file,'utf8'));}catch{unreadable.push(relative(root,file));continue;}
  if(!data||typeof data!=='object'||Array.isArray(data))continue;
  const build=data.staging_commit||data.build_before||data.commit;
  if(build!==sha)continue;
  const needsCleanup=Array.isArray(data.cleanup_required)
    ?data.cleanup_required.length>0
    :data.cleanup_required===true;
  if(needsCleanup)cleanupRequired.push(relative(root,file));
  const source=relative(root,file).replaceAll('\\','/');
  const raw=[];
  if(typeof data.test_ref==='string')raw.push([data.test_ref,data.result]);
  for(const [id,result] of Object.entries(data.case_results||{}))raw.push([id,result]);
  if(Array.isArray(data.cases))for(const row of data.cases)
    if(row?.tc_id)raw.push([row.tc_id,row.result]);
  for(const [id,result] of raw){
    if(id.startsWith('PF-')){preflight.push({ref:id,result,source});continue;}
    if(!ids.has(id))continue;
    const staffRolePartial=id==='P2-USR-003'&&data.create_http===201&&data.patch_http===200&&
      data.assertions_passed===true&&!data.audit;
    const limited=staffRolePartial||String(data.business_case||data.business_cases||'').includes('NOT_EXECUTED')||
      /(?:ONLY|UI_NOT_TESTED)/.test(String(data.case_coverage||'')+' '+String(data.full_case_status||''));
    const executed=data.business_execution==='EXECUTED';
    const readOnlyAudit=id.startsWith('P2-AUD-')&&data.mutations===0;
    const cleanupOk=readOnlyAudit||data.cleanup_pass===true||
      data.cleanup?.inactive===true||
      id.startsWith('P2-USR-')&&data.cleanup?.locked===true;
    const stable=data.build_stable===true||data.build_before===sha&&data.build_after===sha;
    const pass=result==='PASSED'&&!limited&&(executed||readOnlyAudit)&&cleanupOk&&stable&&
      data.secrets_recorded!==true;
    const time=data.checked_at||data.run_at_utc||null;
    evidence.push({ref:id,result,review:pass?'BUSINESS_PASS_EVIDENCE':'REVIEW_REQUIRED',
      source,run_id:data.run_id||null,checked_at:time,
      reason:pass?null:result!=='PASSED'?'Outcome '+String(result):
        staffRolePartial?'Role change API checks only; audit/sensitive action not asserted':
        limited?'Partial/not executed scope':
        !stable?'Build not proven stable':!cleanupOk?'Cleanup not proven':
        !(executed||readOnlyAudit)?'Business execution not proven':'Outcome requires review'});
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
