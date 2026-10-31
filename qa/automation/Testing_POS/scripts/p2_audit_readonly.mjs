// Phase 2 audit regression. Business GET only; POST is restricted to auth/login.
// Contract reviewed: backend/app/api/v1/audit.py at be90389e58fb009ba949d3984d2a5941ad974948.
// Run via p2_run_audit_readonly.ps1; credentials arrive on stdin and never enter evidence.
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CASES=['P2-AUD-001','P2-AUD-002','P2-AUD-003'];
const need=(ok,message)=>{if(!ok)throw new Error(message);};
class GateError extends Error {}
const gate=(ok,message)=>{if(!ok)throw new GateError(message);};

export function timestampNs(value){
 const m=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(String(value));
 need(m,'Invalid audit timestamp; expected ISO8601 with timezone');
 const ms=Date.parse(m[1]+m[3]);need(Number.isFinite(ms),'Invalid audit timestamp');
 return BigInt(ms)*1000000n+BigInt((m[2]??'').padEnd(9,'0'));
}
const ids=rows=>rows.map(r=>r.id);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const safeRows=rows=>rows.map(({id,action,entity_type,entity_id,staff_id,staff_role,created_at})=>
 ({id,action,entity_type,entity_id,staff_id,staff_role,created_at}));
const compareRows=(a,b)=>{
 const d=timestampNs(a.created_at)-timestampNs(b.created_at);
 return d<0n?-1:d>0n?1:a.id.toLowerCase()<b.id.toLowerCase()?-1:a.id.toLowerCase()>b.id.toLowerCase()?1:0;
};
function auditPath(orderId,params={}){
 const p=new URLSearchParams({order_id:orderId,limit:'500',offset:'0'});
 for(const [key,value] of Object.entries(params)){
  p.delete(key);for(const v of Array.isArray(value)?value:[value])p.append(key,String(v));
 }
 return '/api/v1/audit-logs?'+p;
}
function hasData(response,orderId,knownIds){
 // Evidence stores only this boolean, not response payload or credential-bearing strings.
 const raw=typeof response.text==='string'?response.text:JSON.stringify(response.data??null);
 return Array.isArray(response.data)||raw.includes(orderId)||knownIds.some(id=>raw.includes(id))||
  /"(?:access_token|refresh_token|password|payload|entity_id|staff_id)"\s*:/.test(raw);
}
function assertRows(rows,entityIds){
 need(Array.isArray(rows),'Audit response must be a JSON array');
 need(new Set(ids(rows)).size===rows.length,'Duplicate audit row IDs');
 for(const row of rows){
  need(UUID.test(row.id),'Audit row ID must be a UUID');
  need(entityIds.has(row.entity_id),'Audit response contains an entity outside the QA order/items');
  need(row.action&&row.staff_id&&row.staff_role,'Audit actor/action is missing');
  timestampNs(row.created_at);
 }
 need(rows.every((r,i)=>!i||compareRows(rows[i-1],r)<=0),'Audit order differs from created_at ASC, id ASC');
}

export async function runAuditSuite(config,client){
 const report={run_id:config.runId??`RUN-${new Date().toISOString().replace(/\D/g,'')}-P2AUD`,
  run_at_utc:new Date().toISOString(),scope:'P2-AUD-001/002/003; existing CLOSED QA order; read-only',
  order_id:config.orderId,build_before:null,build_after:null,preflight:{},requests:[],cases:[],
  secrets_recorded:false,limitations:['RBAC checks cover the selected audit responses; no system-wide PII masking claim.',
   'P2-AUD-002 requires equal-timestamp rows to conclude full testcase PASSED.']};
 const auth=new Map();let baseline,supervisor,entityIds;let setup=false;
 const request=async(method,path,token,body)=>{
  need(method==='GET'||(method==='POST'&&path==='/api/v1/auth/login'),'Mutation outside login prohibited');
  const r=await client(method,path,token,body);
  report.requests.push({method,path,status:r.status});return r;
 };
 const login=async(username,role)=>{
  if(auth.has(username))return auth.get(username);
  gate(typeof username==='string'&&username.length>0,'Required QA role account was not provided');
  const r=await request('POST','/api/v1/auth/login',null,{username,password:config.password});
  gate(r.status===200&&typeof r.data?.access_token==='string',`QA authentication unavailable for ${role}; HTTP ${r.status}`);
  gate(r.data.staff?.role===role&&r.data.staff.outlet_id,`QA account does not match required ${role}/outlet`);
  const v={token:r.data.access_token,staff:r.data.staff};auth.set(username,v);return v;
 };
 const getAudit=async(params={})=>{
  const r=await request('GET',auditPath(config.orderId,params),supervisor.token);
  need(r.status===200,`Audit GET expected 200; received ${r.status}`);assertRows(r.data,entityIds);return r.data;
 };
 const oneCase=async(id,fn)=>{
  const c={tc_id:id,result:'NOT_EXECUTED',checks:[]};report.cases.push(c);
  try{await fn(c);if(c.result==='NOT_EXECUTED')c.result='PASSED';}
  catch(e){c.result=e instanceof GateError?'BLOCKED':'FAILED';c.reason=e.message;}
 };
 try{
  gate(UUID.test(config.orderId),'Provide an existing QA Order UUID');
  gate(typeof config.password==='string'&&config.password.length>0,'QA seed password not provided');
  gate(!config.expectedCommit||/^[a-f0-9]{7,40}$/i.test(config.expectedCommit),'ExpectedCommit must be a real Git SHA prefix');
  let r=await request('GET','/version');
  gate(r.status===200&&/^[a-f0-9]{7,40}$/i.test(r.data?.commit??''),'Cannot identify staging build');
  report.build_before=r.data.commit;
  gate(r.data.environment==='staging','This runner is restricted to staging');
  gate(!config.expectedCommit||r.data.commit.toLowerCase().startsWith(config.expectedCommit.toLowerCase()),'Staging build does not match ExpectedCommit');
  r=await request('GET','/health');report.preflight.health_http=r.status;gate(r.status===200,'Staging health unavailable');
  r=await request('GET','/openapi.json');report.preflight.openapi_http=r.status;
  const op=r.data?.paths?.['/api/v1/audit-logs']?.get;
  gate(r.status===200&&op,'Audit GET is not documented on this staging build');
  const names=(op.parameters??[]).map(p=>p.name);
  gate(['order_id','action','created_from','created_to','limit','offset'].every(x=>names.includes(x)),'Audit filter/pagination contract is incomplete');
  report.preflight.path_count=Object.keys(r.data.paths).length;
  report.preflight.rest_operations=Object.values(r.data.paths).reduce((n,p)=>n+Object.keys(p).filter(m=>/^(get|post|put|patch|delete|head|options)$/i.test(m)).length,0);
  supervisor=await login(config.supervisorUser??'admin','SUPERVISOR');
  r=await request('GET',`/api/v1/orders/${config.orderId}`,supervisor.token);
  gate(r.status!==404,'QA order no longer exists/is not in this outlet; supply a current owned CLOSED order');
  gate(r.status===200&&r.data?.id===config.orderId,'Cannot verify target QA order');
  gate(r.data.status==='CLOSED','Use a CLOSED QA order so the read-only audit dataset stays stable');
  gate(Array.isArray(r.data.items),'Order items are unavailable');
  entityIds=new Set([config.orderId,...r.data.items.map(x=>x.id)]);
  report.fixture={order_status:r.data.status,outlet_id:supervisor.staff.outlet_id,item_ids:r.data.items.map(x=>x.id)};
  r=await request('GET',auditPath(config.orderId),supervisor.token);
  gate(r.status===200&&Array.isArray(r.data),'Cannot read baseline audit array');
  gate(r.data.length>=3&&r.data.length<500,'Need 3..499 audit rows for a non-truncated baseline');
  baseline=r.data;report.baseline_audit=safeRows(baseline);setup=true;

  await oneCase('P2-AUD-001',async c=>{
   assertRows(baseline,entityIds);
   const actions=[...new Set(baseline.map(x=>x.action))];gate(actions.length>=2,'Need at least two audit actions');
   const pivot=baseline[Math.floor(baseline.length/2)].created_at;
   const checks=[
    ['action A',{action:actions[0]},row=>row.action===actions[0]],
    ['action B',{action:actions[1]},row=>row.action===actions[1]],
    ['repeated action parameters',{action:actions.slice(0,2)},row=>actions.slice(0,2).includes(row.action)],
    ['created_from inclusive',{created_from:pivot},row=>timestampNs(row.created_at)>=timestampNs(pivot)],
    ['created_to exclusive',{created_to:pivot},row=>timestampNs(row.created_at)<timestampNs(pivot)],
    ['combined action/time',{action:baseline[Math.floor(baseline.length/2)].action,created_from:pivot},
     row=>row.action===baseline[Math.floor(baseline.length/2)].action&&timestampNs(row.created_at)>=timestampNs(pivot)],
    ['empty time window',{created_from:pivot,created_to:pivot},()=>false],
    ['unmatched action',{action:`QA_NO_MATCH_${randomUUID()}`},()=>false]
   ];
   for(const [label,params,predicate] of checks){
    const actual=await getAudit(params),expected=baseline.filter(predicate);
    need(same(ids(actual),ids(expected)),`${label}: returned row IDs do not match the baseline filter`);
    c.checks.push({name:label,http:200,rows:actual.length,result:'PASSED'});
   }
   const other=await login(config.otherOutletSupervisorUser??'qa2_admin','SUPERVISOR');
   gate(other.staff.outlet_id!==supervisor.staff.outlet_id,'Other-outlet Supervisor fixture must belong to another QA outlet');
   const denied=await request('GET',auditPath(config.orderId),other.token);
   need(denied.status===404&&!hasData(denied,config.orderId,ids(baseline)),'Other QA outlet must receive 404 without target audit data');
   c.checks.push({name:'QA outlet isolation',http:denied.status,result:'PASSED'});
  });

  await oneCase('P2-AUD-002',async c=>{
   assertRows(baseline,entityIds);gate(baseline.length<=60,'Use a smaller CLOSED QA order (up to 60 audit rows) for bounded pagination requests');
   const pageSize=3;
   for(let cycle=1;cycle<=2;cycle++){
    const rows=[];
    for(let offset=0;offset<baseline.length;offset+=pageSize){
     const page=await getAudit({limit:pageSize,offset});
     need(same(ids(page),ids(baseline.slice(offset,offset+pageSize))),`Pagination mismatch at offset ${offset}`);rows.push(...page);
    }
    need(same(ids(rows),ids(baseline))&&new Set(ids(rows)).size===rows.length,'Pagination duplicates or omits audit rows');
    c.checks.push({name:`pagination pass ${cycle}`,rows:rows.length,result:'PASSED'});
   }
   for(const offset of [baseline.length,baseline.length+pageSize])need((await getAudit({limit:pageSize,offset})).length===0,'Beyond-last-page must be empty');
   for(const params of [{limit:0},{limit:501},{offset:-1}]){
    const r=await request('GET',auditPath(config.orderId,params),supervisor.token);
    need(r.status===422,`Pagination validation expected 422; received ${r.status}`);
    c.checks.push({name:'pagination invalid boundary',params,http:r.status,result:'PASSED'});
   }
   const tieIndex=baseline.findIndex((row,i)=>i>0&&timestampNs(row.created_at)===timestampNs(baseline[i-1].created_at));
   c.same_timestamp_fixture=tieIndex>=1;c.component_result='PASSED';
   if(tieIndex<1){c.result='PENDING';c.reason='Normal pagination passed; no equal-timestamp rows to verify the full P2-AUD-002 tie-break requirement';return;}
   for(let repeat=0;repeat<2;repeat++)for(const offset of [tieIndex-1,tieIndex]){
    const row=await getAudit({limit:1,offset});need(same(ids(row),[baseline[offset].id]),'Equal-timestamp pagination order is unstable');
   }
   c.checks.push({name:'equal timestamps across single-row page boundary',result:'PASSED'});
  });

  await oneCase('P2-AUD-003',async c=>{
   assertRows(baseline,entityIds);
   c.roles=[{user:config.supervisorUser??'admin',role:'SUPERVISOR',http:200,audit_rows:baseline.length}];
   const anonymous=await request('GET',auditPath(config.orderId));
   need(anonymous.status===401&&!hasData(anonymous,config.orderId,ids(baseline)),'Anonymous request must return 401 without audit data');
   c.checks.push({name:'anonymous denied',http:anonymous.status,result:'PASSED'});
   for(const [key,name,role] of [['cashierUser','cashier','CASHIER'],['waiterUser','waiter','WAITER'],['kitchenUser','kitchen','KITCHEN']]){
    const user=config[key]??name,a=await login(user,role);
    gate(a.staff.outlet_id===supervisor.staff.outlet_id,`${role} account must be in the target QA outlet`);
    const denied=await request('GET',auditPath(config.orderId),a.token),leaked=hasData(denied,config.orderId,ids(baseline));
    c.roles.push({user,role,http:denied.status,audit_rows:Array.isArray(denied.data)?denied.data.length:0,leaked_order_or_audit_data:leaked});
    need(denied.status===403&&!leaked,`${role} must return 403 without target order/audit data`);
   }
  });
 }catch(e){
  report.setup_issue=e.message;
  for(const tc_id of CASES)if(!report.cases.some(c=>c.tc_id===tc_id))report.cases.push({tc_id,result:'BLOCKED',reason:e.message});
 }finally{
  let stability='VERIFIED';
  if(setup){
   try{
    const r=await request('GET',auditPath(config.orderId),supervisor.token);
    if(r.status!==200||!Array.isArray(r.data)||!same(safeRows(baseline),safeRows(r.data)))stability='AUDIT_DATA_CHANGED_OR_UNAVAILABLE';
   }catch{stability='AUDIT_RECHECK_UNAVAILABLE';}
  }
  if(report.build_before){
   try{const r=await request('GET','/version');report.build_after=r.status===200?r.data?.commit:null;}
   catch{report.build_after=null;}
   if(report.build_after!==report.build_before)stability='BUILD_CHANGED_OR_UNAVAILABLE';
  }
  report.stability=stability;
  if(stability!=='VERIFIED')for(const c of report.cases){c.observed_result=c.result;c.result='PENDING';c.reason=stability;}
  auth.clear();
 }
 report.counts=Object.fromEntries(['PASSED','FAILED','PENDING','BLOCKED'].map(s=>[s.toLowerCase(),report.cases.filter(c=>c.result===s).length]));
 return report;
}

function makeClient(base){
 const origin=new URL(base);need(['http:','https:'].includes(origin.protocol)&&!origin.username&&!origin.password,'Invalid staging URL');
 return (method,path,token,body)=>new Promise((resolve,reject)=>{
  const url=new URL(path,origin),data=body===undefined?null:JSON.stringify(body);
  const req=(url.protocol==='https:'?https:http).request(url,{method,headers:{Accept:'application/json',
   ...(token?{Authorization:`Bearer ${token}`} : {}),...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})}},res=>{
    let raw='';res.setEncoding('utf8');
    res.on('data',chunk=>{raw+=chunk;if(raw.length>6_000_000)req.destroy(new Error('Response exceeds audit evidence limit'));});
    res.on('end',()=>{let parsed;try{parsed=JSON.parse(raw);}catch{parsed=null;}resolve({status:res.statusCode,data:parsed,text:raw});});
    res.on('error',()=>reject(new Error('Response interrupted')));
   });
  req.setTimeout(15000,()=>req.destroy(new Error('Request timeout')));
  req.on('error',()=>reject(new Error('Network request failed or timed out')));
  req.end(data);
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let raw='';for await(const chunk of process.stdin)raw+=chunk;
 try{
  const config=JSON.parse(raw.replace(/^\uFEFF/,''));raw='';
  const output=config.output;need(typeof output==='string'&&output.length>0,'Evidence output path required');
  const report=await runAuditSuite(config,makeClient(config.baseUrl??'http://160.191.47.17'));
  config.password=null;
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(`P2 audit build: ${report.build_before??'unavailable'}`);
  for(const c of report.cases)console.log(`${c.tc_id}: ${c.result}${c.reason?' - '+c.reason:''}`);
  console.log(`Evidence: ${output}`);
  console.log('Read-only audit; no order/table/payment mutation. Results apply only to the listed testcase scope.');
  process.exitCode=report.counts.failed?1:report.counts.pending||report.counts.blocked?2:0;
 }catch{console.error('Audit runner could not start/save evidence; check configuration and output permissions. Credentials are not printed.');process.exitCode=1;}
}
