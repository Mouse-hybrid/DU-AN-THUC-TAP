// PF-P2-RWD-002: concurrent duplicate-phone requests in the QA 3 outlet.
// The one owned customer is deactivated; no seed user or global staging reset.
import {randomInt, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password=process.env.P2_QA_SEED_PASSWORD;
const expected=process.env.POS_EXPECTED_COMMIT;
const output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_002_duplicate_phone_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}

const tokens={};
let phone,customerId,fixtureName,buildBefore,buildAfter,cleanup=false,checksPassed=false,mutationPossible=false,error;
const ownedIds=new Set();
const report={test_ref:'PF-P2-RWD-002',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'QA 3 concurrent creates for the same phone with different idempotency keys; replay, one profile, empty points ledger, customer audit, owned customer deactivation.',
  business_case:'P2-RWD-002 NOT_EXECUTED until generic order/session step and complete testcase scope are reviewed.',
  phone_recorded:false,secrets_recorded:false};

async function call(method,path,role,body,key){
  const headers={Accept:'application/json'};
  if(role)headers.Authorization=`Bearer ${tokens[role]}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET')headers['Idempotency-Key']=key||randomUUID();
  const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(30_000)});
  return {http:response.status,data:await response.json().catch(()=>null)};
}
function must(response,code,label){
  if(response.http!==code)throw new Error(`${label} HTTP ${response.http}; expected ${code}`);
  return response.data;
}
function sanitized(err){
  let message=String(err?.message||err);
  for(const secret of [password,phone,...Object.values(tokens)])
    if(secret)message=message.replaceAll(secret,'<REDACTED>');
  return message;
}
async function version(){return must(await call('GET','/version'),200,'version')?.commit;}
try {
  buildBefore=await version();
  if(!/^[0-9a-f]{40}$/.test(buildBefore||''))throw new Error('Invalid staging SHA');
  if(expected&&(!/^[0-9a-f]{7,40}$/.test(expected)||!buildBefore.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  report.staging_commit=buildBefore;
  const spec=must(await call('GET','/openapi.json'),200,'OpenAPI');
  if(!spec?.paths?.['/api/v1/customers']?.post||
     !spec?.paths?.['/api/v1/customers']?.get||
     !spec?.paths?.['/api/v1/customers/{customer_id}']?.patch||
     !spec?.paths?.['/api/v1/customers/{customer_id}/points']?.get||
     !spec?.paths?.['/api/v1/audit-logs']?.get)
    throw new Error('Customer/points/audit contract missing');
  for(const [role,user,wantRole] of [['admin','qa3_admin','SUPERVISOR'],['cashier','qa3_cashier','CASHIER']]){
    const login=must(await call('POST','/api/v1/auth/login',null,{username:user,password}),200,`${user} login`);
    if(!login?.access_token)throw new Error(`${user} token missing`);
    tokens[role]=login.access_token;
    const me=must(await call('GET','/api/v1/auth/me',role),200,`${user} identity`);
    if(me.username!==user||me.role!==wantRole||!me.outlet_id)throw new Error(`${user} role/outlet mismatch`);
    report[`${role}_outlet_id`]=me.outlet_id;
  }
  if(report.admin_outlet_id!==report.cashier_outlet_id)throw new Error('QA 3 role outlets differ');
  const tables=must(await call('GET','/api/v1/tables','admin'),200,'QA 3 tables');
  if(!Array.isArray(tables)||!tables.some(t=>/^Q3-[123]$/.test(t.code)))
    throw new Error('QA 3 fixture gate: Q3 tables not found');
  phone=`09${String(randomInt(0,100_000_000)).padStart(8,'0')}`;
  fixtureName=`QA P2RWD002 ${randomUUID().slice(0,8)}`;
  report.fixture_name=fixtureName;
  const path=`/api/v1/customers?phone=${encodeURIComponent(phone)}`;
  const before=must(await call('GET',path,'cashier'),200,'pre-create lookup');
  if(!Array.isArray(before)||before.length)throw new Error('Generated QA phone already in use; no mutation');
  const body={phone,full_name:fixtureName,consent:true};
  const keys=[randomUUID(),randomUUID()];
  mutationPossible=true;
  const settled=await Promise.allSettled(keys.map(key=>call('POST','/api/v1/customers','cashier',body,key)));
  const responses=settled.map(x=>x.status==='fulfilled'?x.value:null);
  report.concurrent_http=responses.map(x=>x?.http??null);
  for(const response of responses)if(response?.http===201&&response.data?.id)ownedIds.add(response.data.id);
  const winner=responses.find(x=>x?.http===201);
  customerId=winner?.data?.id;
  report.fixture_customer_id=customerId??null;
  // In a network error, a created record may exist even when the response is unavailable.
  const lookup=must(await call('GET',path,'cashier'),200,'post-create lookup');
  if(Array.isArray(lookup))for(const row of lookup)
    if(row?.full_name===fixtureName&&row?.id)ownedIds.add(row.id);
  if(!customerId&&Array.isArray(lookup)&&lookup.length===1&&lookup[0]?.full_name===fixtureName){
    customerId=lookup[0].id;
    report.fixture_customer_id=customerId;
  }
  if(!customerId)throw new Error('No owned customer id; check the generated fixture after a network error');
  report.customer_count=Array.isArray(lookup)?lookup.length:null;
  const replay=await call('POST','/api/v1/customers','cashier',body,
    winner?keys[responses.indexOf(winner)]:keys[0]);
  report.same_key_replay_http=replay.http;
  const afterReplay=must(await call('GET',path,'cashier'),200,'replay lookup');
  const own=must(await call('GET',`/api/v1/customers/${customerId}`,'cashier'),200,'own customer');
  const ledger=must(await call('GET',`/api/v1/customers/${customerId}/points`,'cashier'),200,'points ledger');
  const audit=must(await call('GET',
    `/api/v1/audit-logs?entity_id=${customerId}&entity_type=customer&limit=100`,'admin'),200,'customer audit');
  report.audit_created_count=Array.isArray(audit)?audit.filter(x=>x.action==='CUSTOMER_CREATED').length:null;
  report.ledger_entries=Array.isArray(ledger)?ledger.length:null;
  checksPassed=responses.filter(x=>x?.http===201).length===1&&
    responses.filter(x=>x?.http===409).length===1&&
    replay.http===201&&replay.data?.id===customerId&&
    Array.isArray(lookup)&&lookup.length===1&&lookup[0]?.id===customerId&&
    Array.isArray(afterReplay)&&afterReplay.length===1&&afterReplay[0]?.id===customerId&&
    own.id===customerId&&own.phone===phone&&own.full_name===fixtureName&&own.points_balance===0&&
    Array.isArray(ledger)&&ledger.length===0&&report.audit_created_count===1;
  report.assertions_passed=checksPassed;
}catch(e){error=sanitized(e);}
finally{
  if(mutationPossible&&phone&&tokens.cashier){
    try {
      const found=await call('GET',`/api/v1/customers?phone=${encodeURIComponent(phone)}`,'cashier');
      if(found.http===200&&Array.isArray(found.data))for(const row of found.data)
        if(row?.full_name===fixtureName&&row?.id)ownedIds.add(row.id);
    } catch { /* use known ids */ }
  }
  if(ownedIds.size&&tokens.admin){
    try{
      const rows=[];
      for(const id of ownedIds){
        const lock=await call('PATCH',`/api/v1/customers/${id}`,'admin',{is_active:false});
        const verify=await call('GET',`/api/v1/customers/${id}`,'admin');
        rows.push({id,lock_http:lock.http,verify_http:verify.http,
          inactive:lock.http===200&&verify.http===200&&verify.data?.id===id&&verify.data?.is_active===false});
      }
      cleanup=rows.every(x=>x.inactive);
      report.cleanup={customers:rows,inactive:cleanup};
    }catch(e){report.cleanup={inactive:false,error:sanitized(e)};}
  }
  try{buildAfter=await version();}catch{ /* preserve primary result */ }
  report.build_stable=!!buildBefore&&buildBefore===buildAfter;
  report.result=checksPassed&&cleanup&&report.build_stable?'PASSED':
    ownedIds.size&&cleanup&&report.build_stable?'FAILED':'INCONCLUSIVE';
  if(error)report.error=error;
  if(mutationPossible&&!cleanup)report.cleanup_required=
    `CLEANUP REQUIRED: locate and deactivate own QA customer(s) named ${fixtureName||'QA P2RWD002'}; known ids: ${[...ownedIds].join(',')||'none'}`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
