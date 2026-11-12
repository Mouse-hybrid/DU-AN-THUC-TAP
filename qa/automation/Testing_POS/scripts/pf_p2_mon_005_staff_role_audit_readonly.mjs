// Read-only audit follow-up for one previously created and locked QA3 staff fixture.
// No staff mutation, token or credential is recorded in the evidence.
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base='http://160.191.47.17';
const [sourcePath, outputPath]=process.argv.slice(2);
let password=process.env.P2_QA_SEED_PASSWORD;
const expected=process.env.POS_EXPECTED_COMMIT;
if(!sourcePath||!outputPath||!password||!/^[a-f0-9]{40}$/.test(expected??'')){
  console.error('Usage: set P2_QA_SEED_PASSWORD and full POS_EXPECTED_COMMIT; node scripts/pf_p2_mon_005_staff_role_audit_readonly.mjs SOURCE.json OUTPUT.json');
  process.exit(2);
}
const source=JSON.parse(readFileSync(sourcePath,'utf8'));
const staffId=source.fixture_staff_id;
if(source.test_ref!=='P2-USR-003'||source.result!=='PASSED'||
   source.cleanup?.locked!==true||source.build_stable!==true||
   source.staging_commit!==expected||!/^[a-f0-9-]{36}$/.test(staffId??'')||
   !/^qa_p2usr003_\d+_[a-f0-9]+$/.test(source.fixture_username??'')){
  console.error('PENDING_FIXTURE: source is not a successful, locked QA3 role-change fixture for expected build; no request sent');
  process.exit(2);
}
const req=async(path,token,body)=>{
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method:body?'POST':'GET',headers,
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
  return {http:response.status,data:await response.json().catch(()=>null)};
};
const report={run_id:`RUN-${new Date().toISOString().replace(/[-:.TZ]/g,'')}-PFMON005AUDIT`,
  test_ref:'PF-P2-MON-005-AUDIT',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'Read-only QA3 role-change audit and locked staff state from P2-USR-003 retest.',
  business_case:'P2-MON-005 NOT_EXECUTED: action-level API matrix, order/session/ledger state and monitoring trace not tested.',
  source:sourcePath,fixture_staff_id:staffId,mutations:0,secrets_recorded:false};
let token, error, assertions=false;
try{
  const before=await req('/version');
  if(before.http!==200||before.data?.environment!=='staging'||before.data?.commit!==expected)
    throw Error('PENDING_BUILD: staging SHA changed');
  report.build_before=before.data.commit;
  const login=await req('/api/v1/auth/login',null,{username:'qa3_admin',password});
  token=login.data?.access_token;
  if(login.http!==200||!token)throw Error(`PENDING_AUTH: QA3 supervisor login HTTP ${login.http}`);
  const me=await req('/api/v1/auth/me',token);
  if(me.http!==200||me.data?.username!=='qa3_admin'||me.data?.role!=='SUPERVISOR'||
     me.data?.outlet_id!==source.outlet_id)throw Error('PENDING_FIXTURE: supervisor/outlet mismatch');
  const staff=await req(`/api/v1/staff/${staffId}`,token);
  if(staff.http!==200||staff.data?.id!==staffId||
     staff.data?.username!==source.fixture_username||staff.data?.outlet_id!==source.outlet_id)
    throw Error(`PENDING_FIXTURE: owned staff GET HTTP ${staff.http} or identity mismatch`);
  const auditPath=`/api/v1/audit-logs?entity_id=${encodeURIComponent(staffId)}&entity_type=staff&limit=100`;
  const readAudit=async()=>{
    const response=await req(auditPath,token);
    if(response.http!==200||!Array.isArray(response.data))
      throw Error(`PENDING_CONTRACT: staff audit HTTP ${response.http}`);
    return response.data.filter(x=>x.entity_id===staffId);
  };
  const first=await readAudit(), second=await readAudit();
  const relevant=first.filter(x=>x.action==='STAFF_UPDATED'||
    x.action==='STAFF_ROLE_CHANGED'||x.action==='STAFF_ROLE_UPDATED');
  const actorTimeEntityValid=relevant.length===1&&relevant.every(x=>
    x.staff_id===me.data.id&&x.staff_role==='SUPERVISOR'&&
    x.entity_id===staffId&&Number.isFinite(Date.parse(x.created_at)));
  const ids=rows=>rows.map(x=>x.id).sort().join('|');
  const stableReads=ids(first)===ids(second)&&first.length===second.length;
  const auditRaw=JSON.stringify(first);
  const secretsAbsent=![password,token].some(secret=>secret&&auditRaw.includes(secret));
  report.checks={staff_remains_locked:staff.data.is_active===false&&staff.data.role==='CASHIER',
    role_change_audit_once:relevant.length===1,actor_time_entity_valid:actorTimeEntityValid,
    stable_reads:stableReads,secrets_absent:secretsAbsent};
  report.audit={row_count:first.length,available_actions:[...new Set(first.map(x=>x.action))],
    role_change_actions:relevant.map(x=>x.action)};
  assertions=Object.values(report.checks).every(Boolean);
}catch(e){error=e.message;}
finally{
  try{
    const after=await req('/version');
    report.build_after=after.data?.commit??null;
    report.build_stable=after.http===200&&report.build_after===report.build_before;
  }catch{report.build_stable=false;}
  report.result=error?'PENDING':!report.checks?.role_change_audit_once?'PENDING':
    assertions&&report.build_stable?'PASSED':'FAILED';
  if(!error&&report.result==='PENDING')error='PENDING_MAPPING: inspect available audit actions';
  if(error)report.error=error;
  mkdirSync(dirname(outputPath),{recursive:true});
  writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  password=undefined;token=undefined;
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
