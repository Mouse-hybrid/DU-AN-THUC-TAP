// Read-only audit observation from existing QA3 payment, table transfer and reward runs.
// Does not establish DB-level immutability or execute the complete P2-AUD-005 testcase.
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';

const [,,paymentPath,tablePath,rewardPath,output]=process.argv;
const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const expected=process.env.POS_EXPECTED_COMMIT;
const password=process.env.P2_QA_SEED_PASSWORD;
if(!paymentPath||!tablePath||!rewardPath||!output){
  console.error('Usage: node scripts/pf_p2_aud_005_readonly.mjs PAYMENT.json TABLE.json REWARD.json OUTPUT.json');
  process.exit(2);
}
if(base!=='http://160.191.47.17'||!/^[a-f0-9]{40}$/.test(expected||'')||!password){
  console.error('PENDING_GATE: approved staging, full POS_EXPECTED_COMMIT and P2_QA_SEED_PASSWORD required; no request sent');
  process.exit(2);
}
const report={run_id:'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-PFAUD005',
  test_ref:'PF-P2-AUD-005',checked_at:new Date().toISOString(),result:'PENDING',
  scope:'QA3 read-only audit observation for prior payment, table transfer and reward runs; API contract and stable GET; no audit write attempts',
  business_case:'P2-AUD-005 NOT_EXECUTED: no DB-level immutability, system-error trace, or freshly generated three-action fixture asserted',
  secrets_recorded:false,mutations:0,checks:{},observations:[],probes:[]};
const stamp=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
let before,after,error,token3,token2;
function requireTrue(value,label){if(!value)throw Error(label);}
function readEvidence(path,label){
  const x=JSON.parse(readFileSync(path,'utf8'));
  requireTrue(x.result==='PASSED'||label==='table'&&x.result==='FAILED',label+': result is not a documented run');
  requireTrue(x.staging_commit===expected&&x.build_stable===true,label+': evidence is on a different/unstable build');
  requireTrue(x.cleanup_pass===true,label+': cleanup not proven');
  const id=label==='payment'?x.scenarios?.find(s=>s.permitted_payment===true)?.order_id:x.order_id;
  requireTrue(typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id),label+': order ID missing');
  return {label,id,source:path,source_case_result:x.result};
}
async function request(method,path,token,body){
  const headers={Accept:'application/json'};
  if(token)headers.Authorization='Bearer '+token;
  if(body!==undefined)headers['Content-Type']='application/json';
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const raw=await res.text();
  if(raw.length>2_000_000)throw Error('Response too large');
  let data=null;try{data=JSON.parse(raw)}catch{}
  return {http:res.status,data,raw};
}
async function get(path,token){const r=await request('GET',path,token);requireTrue(r.http===200,'GET '+path.split('?')[0]+' HTTP '+r.http);return r.data;}
async function login(username,role){
  const r=await request('POST','/api/v1/auth/login',null,{username,password});
  requireTrue(r.http===200&&r.data?.access_token&&r.data?.staff?.role===role,username+' login/role unavailable');
  return {token:r.data.access_token,outlet:r.data.staff.outlet_id};
}
const auditPath=id=>'/api/v1/audit-logs?order_id='+encodeURIComponent(id)+'&limit=500&offset=0';
function digest(rows){return createHash('sha256').update(JSON.stringify(rows)).digest('hex');}
try{
  const sources=[readEvidence(paymentPath,'payment'),readEvidence(tablePath,'table'),readEvidence(rewardPath,'reward')];
  before=(await get('/version'))?.commit;report.build_before=before;
  requireTrue(before===expected,'PENDING_BUILD: staging SHA changed');
  const spec=await get('/openapi.json');
  const paths=Object.entries(spec?.paths||{}).filter(([p])=>p==='/api/v1/audit-logs'||p.startsWith('/api/v1/audit-logs/'));
  requireTrue(paths.length>0&&paths.some(([p,ops])=>p==='/api/v1/audit-logs'&&ops.get),'Audit GET contract missing');
  report.audit_contract=paths.map(([path,operations])=>({path,methods:Object.keys(operations).filter(k=>/^(get|post|put|patch|delete)$/i.test(k)).sort()}));
  report.checks.no_documented_write_route=report.audit_contract.every(x=>x.methods.length===1&&x.methods[0]==='get');
  const a=await login('qa3_admin','SUPERVISOR'),b=await login('qa2_admin','SUPERVISOR');
  token3=a.token;token2=b.token;
  requireTrue(a.outlet&&b.outlet&&a.outlet!==b.outlet,'QA3/QA2 outlet isolation unavailable');
  const sampled=new Map();
  for(const source of sources){
    const path=auditPath(source.id);
    const byOrder=await request('GET',path,token3);
    const entityPath='/api/v1/audit-logs?entity_id='+encodeURIComponent(source.id)+'&limit=500&offset=0';
    const byEntity=await request('GET',entityPath,token3);
    sampled.set(source.label,byOrder);
    report.probes.push({area:source.label,order_filter_http:byOrder.http,
      order_filter_rows:Array.isArray(byOrder.data)?byOrder.data.length:null,
      entity_filter_http:byEntity.http,
      entity_filter_rows:Array.isArray(byEntity.data)?byEntity.data.length:null});
  }
  for(const source of sources){
    const path=auditPath(source.id),byOrder=sampled.get(source.label);
    requireTrue(byOrder.http===200,source.label+': order_id audit filter HTTP '+byOrder.http);
    const rows=byOrder.data;
    requireTrue(Array.isArray(rows)&&rows.length<500,source.label+': audit rows missing/truncated');
    requireTrue(new Set(rows.map(x=>x.id)).size===rows.length,source.label+': duplicate audit ID');
    const valid=rows.every(x=>x.id&&x.action&&x.entity_id&&x.staff_id&&stamp.test(x.created_at||''));
    requireTrue(valid,source.label+': actor/time/entity missing');
    const keys=source.label==='payment'?['PAYMENT_RECORDED']:
      source.label==='reward'?['ORDER_REWARD_APPLIED','ORDER_REWARD_REMOVED']:['TRANSFER'];
    const matched=rows.filter(x=>keys.some(k=>String(x.action).includes(k)));
    const noSecret=!/"(?:access_token|refresh_token|password|pin)"\s*:/i.test(JSON.stringify(rows));
    requireTrue(noSecret,source.label+': credential key exposed in audit');
    const second=await get(path,token3);
    requireTrue(digest(second)===digest(rows),source.label+': audit changed on repeated GET');
    const foreign=await request('GET',path,token2);
    requireTrue(foreign.http===404&&!foreign.raw.includes(source.id),source.label+': cross-outlet audit not isolated');
    report.observations.push({area:source.label,order_id:source.id,source:source.source,
      source_case_result:source.source_case_result,
      audit_rows:rows.length,matched_actions:[...new Set(matched.map(x=>x.action))],
      available_actions:[...new Set(rows.map(x=>x.action))],metadata_valid:valid,
      stable_read:true,qa2_http:foreign.http,secrets_absent:noSecret});
  }
  report.checks.three_action_audit_observed=report.observations.every(x=>x.matched_actions.length>0);
  report.checks.stable_reads_and_outlet_isolation=report.observations.every(x=>x.stable_read&&x.qa2_http===404);
}catch(e){error=String(e?.message||e).replaceAll(password,'<REDACTED>');}
finally{
  if(before)try{after=(await get('/version'))?.commit}catch{}
  report.build_after=after||null;report.build_stable=before===expected&&after===expected;
  report.result=report.build_stable&&Object.values(report.checks).every(Boolean)&&
    report.checks.three_action_audit_observed===true?'PASSED':'PENDING';
  if(error)report.error=error;
  token3=token2=null;
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));process.exitCode=report.result==='PASSED'?0:2;
}
