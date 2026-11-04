// QA 3 customer ledger component and QA 2 cross-outlet isolation.
// Owned adjustments +7/-7 restore balance to zero; own customer is deactivated.
import {randomInt, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD, expected=process.env.POS_EXPECTED_COMMIT;
const output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_003_010_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}

const tokens={},owned={id:null,phone:null,name:null},result={
  test_refs:['PF-P2-RWD-003','PF-P2-RWD-010'],checked_at:new Date().toISOString(),
  business_cases:'P2-RWD-003/010 NOT_EXECUTED: earn/redeem, order/session, customer reward application and UI not exercised.',
  secrets_recorded:false,phone_recorded:false,status:'INCONCLUSIVE'};
let before,after,created=false,clean=false,error,component003=false,component010=false;
async function request(method,path,role,body,key){
  const headers={Accept:'application/json'};
  if(role)headers.Authorization=`Bearer ${tokens[role]}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET')headers['Idempotency-Key']=key||randomUUID();
  const response=await fetch(base+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  return {http:response.status,data:await response.json().catch(()=>null)};
}
function need(r,code,label){if(r.http!==code)throw new Error(`${label} HTTP ${r.http}, expected ${code}`);return r.data;}
function safe(e){let s=String(e?.message||e);for(const secret of [password,owned.phone,...Object.values(tokens)])
  if(secret)s=s.replaceAll(secret,'<REDACTED>');return s;}
async function sha(){return need(await request('GET','/version'),200,'version')?.commit;}
try{
  before=await sha();
  if(!/^[0-9a-f]{40}$/.test(before||''))throw new Error('Invalid staging SHA');
  if(expected&&(!/^[0-9a-f]{7,40}$/.test(expected)||!before.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  result.staging_commit=before;
  const spec=need(await request('GET','/openapi.json'),200,'OpenAPI');
  for(const [path,method] of [
    ['/api/v1/customers','post'],['/api/v1/customers/{customer_id}','patch'],
    ['/api/v1/customers/{customer_id}/points','get'],
    ['/api/v1/customers/{customer_id}/points/adjust','post'],['/api/v1/audit-logs','get']])
    if(!spec?.paths?.[path]?.[method])throw new Error(`Missing contract ${method.toUpperCase()} ${path}`);
  const identities=[
    ['qa3_admin','SUPERVISOR','admin3'],['qa3_cashier','CASHIER','cashier3'],
    ['qa3_waiter','WAITER','waiter3'],['qa2_admin','SUPERVISOR','admin2']];
  for(const [username,role,key] of identities){
    const login=need(await request('POST','/api/v1/auth/login',null,{username,password}),200,`${username} login`);
    if(!login?.access_token)throw new Error(`${username} token missing`);
    tokens[key]=login.access_token;
    const me=need(await request('GET','/api/v1/auth/me',key),200,`${username} identity`);
    if(me.username!==username||me.role!==role||!me.outlet_id)throw new Error(`${username} role mismatch`);
    result[`${key}_outlet_id`]=me.outlet_id;
  }
  if(result.admin3_outlet_id!==result.cashier3_outlet_id||
     result.admin3_outlet_id!==result.waiter3_outlet_id||
     result.admin3_outlet_id===result.admin2_outlet_id)
    throw new Error('QA outlet isolation fixture mismatch');
  const tables=need(await request('GET','/api/v1/tables','admin3'),200,'QA 3 tables');
  if(!Array.isArray(tables)||!tables.some(t=>/^Q3-[123]$/.test(t.code)))
    throw new Error('QA 3 table fixture missing');
  owned.phone=`09${String(randomInt(0,100_000_000)).padStart(8,'0')}`;
  owned.name=`QA P2RWD003010 ${randomUUID().slice(0,8)}`;
  result.fixture_name=owned.name;
  const phonePath=`/api/v1/customers?phone=${encodeURIComponent(owned.phone)}`;
  const empty=need(await request('GET',phonePath,'cashier3'),200,'pre-create search');
  if(!Array.isArray(empty)||empty.length)throw new Error('Generated phone already exists; no mutation');
  const create=await request('POST','/api/v1/customers','cashier3',
    {phone:owned.phone,full_name:owned.name,consent:true});
  result.create_http=create.http;owned.id=create.data?.id||null;
  if(create.http!==201||!owned.id)throw new Error(`Customer create HTTP ${create.http} or missing id`);
  created=true;result.fixture_customer_id=owned.id;
  const initial=need(await request('GET',`/api/v1/customers/${owned.id}`,'cashier3'),200,'initial customer');
  const keyPlus=randomUUID();
  const plus=await request('POST',`/api/v1/customers/${owned.id}/points/adjust`,'admin3',
    {points:7,reason:'QA P2RWD003010 isolated balance check'},keyPlus);
  result.adjust_plus_http=plus.http;
  const replay=await request('POST',`/api/v1/customers/${owned.id}/points/adjust`,'admin3',
    {points:7,reason:'QA P2RWD003010 isolated balance check'},keyPlus);
  result.adjust_replay_http=replay.http;
  // Restore the owned balance even if assertions on +7/replay fail.
  const current=need(await request('GET',`/api/v1/customers/${owned.id}`,'admin3'),200,'balance after +7');
  if(current.points_balance>0){
    const minus=await request('POST',`/api/v1/customers/${owned.id}/points/adjust`,'admin3',
      {points:-current.points_balance,reason:'QA P2RWD003010 restore owned balance'});
    result.adjust_restore_http=minus.http;
  }
  const own=need(await request('GET',`/api/v1/customers/${owned.id}`,'cashier3'),200,'final balance');
  const ledger=need(await request('GET',`/api/v1/customers/${owned.id}/points`,'cashier3'),200,'ledger');
  const audit=need(await request('GET',
    `/api/v1/audit-logs?entity_id=${owned.id}&entity_type=customer&limit=100`,'admin3'),200,'audit');
  const forbidden=await request('GET',`/api/v1/customers/${owned.id}`,'waiter3');
  result.waiter_get_http=forbidden.http;
  result.ledger_entries=Array.isArray(ledger)?ledger.length:null;
  result.audit_created=Array.isArray(audit)?audit.filter(x=>x.action==='CUSTOMER_CREATED').length:null;
  result.audit_adjusted=Array.isArray(audit)?audit.filter(x=>x.action==='POINTS_ADJUSTED').length:null;
  const expectedLedger=Array.isArray(ledger)&&ledger.length===2&&
    ledger.every(x=>x.entry_type==='ADJUST'&&!!x.created_at)&&
    new Date(ledger[0].created_at)>=new Date(ledger[1].created_at)&&
    ledger.some(x=>x.points===7&&x.balance_after===7)&&
    ledger.some(x=>x.points===-7&&x.balance_after===0);
  const piiHidden=Array.isArray(audit)&&!JSON.stringify(audit).includes(owned.phone);
  component003=initial.points_balance===0&&own.points_balance===0&&
    plus.http===201&&replay.http===201&&replay.data?.id===plus.data?.id&&
    expectedLedger&&result.audit_created===1&&result.audit_adjusted===2&&
    forbidden.http===403&&piiHidden;
  const foreign=await request('GET',`/api/v1/customers/${owned.id}`,'admin2');
  const foreignLedger=await request('GET',`/api/v1/customers/${owned.id}/points`,'admin2');
  const foreignList=await request('GET',phonePath,'admin2');
  result.cross_outlet={customer_get_http:foreign.http,points_get_http:foreignLedger.http,
    phone_lookup_http:foreignList.http,phone_lookup_count:Array.isArray(foreignList.data)?foreignList.data.length:null};
  component010=foreign.http===404&&foreignLedger.http===404&&
    foreignList.http===200&&Array.isArray(foreignList.data)&&foreignList.data.length===0;
  result.components={'PF-P2-RWD-003':component003?'PASSED':'FAILED',
    'PF-P2-RWD-010':component010?'PASSED':'FAILED'};
}catch(e){error=safe(e);}
finally{
  // If creation succeeded but the response failed, recover only the uniquely named own fixture.
  if(!owned.id&&owned.phone&&tokens.cashier3){
    try{
      const lookup=await request('GET',`/api/v1/customers?phone=${encodeURIComponent(owned.phone)}`,'cashier3');
      const found=lookup.http===200&&Array.isArray(lookup.data)?
        lookup.data.find(x=>x.full_name===owned.name):null;
      if(found?.id){owned.id=found.id;result.fixture_customer_id=found.id;created=true;}
    }catch{/* preserve original failure */}
  }
  if(owned.id&&tokens.admin3){
    try{
      const balance=await request('GET',`/api/v1/customers/${owned.id}`,'admin3');
      if(balance.http===200&&balance.data?.points_balance>0){
        const restore=await request('POST',`/api/v1/customers/${owned.id}/points/adjust`,'admin3',
          {points:-balance.data.points_balance,reason:'QA P2RWD003010 final balance restore'});
        result.final_restore_http=restore.http;
      }
      const lock=await request('PATCH',`/api/v1/customers/${owned.id}`,'admin3',{is_active:false});
      const verify=await request('GET',`/api/v1/customers/${owned.id}`,'admin3');
      clean=lock.http===200&&verify.http===200&&verify.data?.is_active===false&&
        verify.data?.points_balance===0;
      result.cleanup={lock_http:lock.http,verify_http:verify.http,
        inactive:verify.data?.is_active===false,balance_zero:verify.data?.points_balance===0,passed:clean};
    }catch(e){result.cleanup={passed:false,error:safe(e)};}
  }
  try{after=await sha();}catch{/* preserve original failure */}
  result.build_stable=!!before&&before===after;
  if(!result.components)result.components={'PF-P2-RWD-003':'INCONCLUSIVE','PF-P2-RWD-010':'INCONCLUSIVE'};
  result.status=component003&&component010&&clean&&result.build_stable?'PASSED':
    created&&clean&&result.build_stable?'FAILED':'INCONCLUSIVE';
  if(error)result.error=error;
  if(created&&!clean)result.cleanup_required=`CLEANUP REQUIRED: own customer ${owned.id}; restore balance to 0 and deactivate`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.status==='PASSED'?0:result.status==='FAILED'?1:2;
}
