// Read-only QA3 audit pagination on the Q3-3 fixture created by Reset with_fixtures.
// Only POST /auth/login is permitted; no staging reset or business mutation.
import {randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const expected=process.env.POS_EXPECTED_COMMIT;
const password=process.env.P2_QA_SEED_PASSWORD;
const orderId=process.env.P2_AUD_FIXTURE_ORDER_ID;
const output=process.argv[2];
const uuid=/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const report={run_id:`RUN-${new Date().toISOString().replace(/\D/g,'')}-P2AUD002`,
  test_ref:'P2-AUD-002',checked_at:new Date().toISOString(),result:'PENDING',
  scope:'Read-only equal-timestamp audit fixture in QA3 Q3-3',
  order_id:orderId||null,secrets_recorded:false,mutations:0};
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output)throw new Error('Usage: node scripts/p2_aud_002_equal_timestamp_fixture.mjs OUTPUT.json');
if(expected&&!/^[a-f\d]{7,40}$/i.test(expected))throw new Error('Invalid expected SHA');
let token=null,before=null,after=null;
function stamp(s){
  const m=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(String(s));
  if(!m)throw new Error('Invalid audit timestamp');
  const ms=Date.parse(m[1]+m[3]);
  if(!Number.isFinite(ms))throw new Error('Invalid audit timestamp');
  return BigInt(ms)*1000000n+BigInt((m[2]||'').padEnd(9,'0'));
}
async function call(method,path,body){
  if(method!=='GET'&&!(method==='POST'&&path==='/api/v1/auth/login'))
    throw new Error('Business mutation prohibited');
  const headers={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20_000)});
  return {status:response.status,data:await response.json().catch(()=>null)};
}
function requireStatus(response,status,label){
  if(response.status!==status)throw new Error(`${label}: HTTP ${response.status}, expected ${status}`);
  return response.data;
}
function auditPath(params={}){
  const p=new URLSearchParams({order_id:orderId,limit:2,offset:0});
  for(const [k,v] of Object.entries(params))p.set(k,String(v));
  return `/api/v1/audit-logs?${p}`;
}
function assertRows(rows){
  if(!Array.isArray(rows)||rows.length!==5||new Set(rows.map(x=>x.id)).size!==5)
    throw new Error('Expected exactly 5 distinct fixture audit rows');
  if(rows.some(x=>x.action!=='QA_FIXTURE_EQUAL_TIMESTAMP'||x.entity_id!==orderId||!uuid.test(x.id)))
    throw new Error('Audit fixture action/order identity mismatch');
  const time=stamp(rows[0].created_at);
  if(rows.some(x=>stamp(x.created_at)!==time))throw new Error('Fixture timestamp is not equal');
  const ids=rows.map(x=>x.id.toLowerCase());
  if(JSON.stringify(ids)!==JSON.stringify([...ids].sort()))
    throw new Error('Equal-timestamp audit rows not ordered by id');
  return ids;
}
try{
  if(!password||!uuid.test(orderId||''))throw new Error('PENDING_FIXTURE: supply QA3 seed password and Q3-3 fixture order UUID');
  before=requireStatus(await call('GET','/version'),200,'version').commit;
  if(!/^[a-f\d]{40}$/i.test(before)||expected&&!before.startsWith(expected))
    throw new Error('PENDING_BUILD: staging build changed or does not match expected SHA');
  report.build_before=before;
  const auth=requireStatus(await call('POST','/api/v1/auth/login',
    {username:'qa3_admin',password}),200,'QA3 admin login');
  token=auth.access_token;
  if(!token||auth.staff?.role!=='SUPERVISOR')throw new Error('PENDING_FIXTURE: QA3 supervisor identity unavailable');
  const order=await call('GET',`/api/v1/orders/${orderId}`);
  if(order.status===404)throw new Error('PENDING_FIXTURE: order removed by later staging reset');
  requireStatus(order,200,'own fixture order');
  if(order.data.status!=='NEW'||(order.data.items||[]).length!==0||
    order.data.table_session_id==null)
    throw new Error('PENDING_FIXTURE: expected untouched NEW empty QA3 audit order');
  const baseline=requireStatus(await call('GET',auditPath({limit:500})),200,'baseline audit');
  const ids=assertRows(baseline);
  const pages=[];
  for(const offset of [0,2,4,5]){
    const items=requireStatus(await call('GET',auditPath({offset})),200,`page ${offset}`);
    if(!Array.isArray(items))throw new Error('Audit page is not an array');
    if(offset<5)pages.push(...items);
    else if(items.length)throw new Error('Beyond-last page is not empty');
  }
  if(JSON.stringify(pages.map(x=>x.id.toLowerCase()))!==JSON.stringify(ids))
    throw new Error('Pagination duplicated or omitted an equal-timestamp row');
  for(const offset of [0,1,2,3,4]){
    const page=requireStatus(await call('GET',auditPath({limit:1,offset})),200,`single row ${offset}`);
    if(page.length!==1||page[0].id.toLowerCase()!==ids[offset])
      throw new Error('Limit=1 page order mismatch');
  }
  const reread=requireStatus(await call('GET',auditPath({limit:500})),200,'stable fixture reread');
  if(JSON.stringify(assertRows(reread))!==JSON.stringify(ids))
    throw new Error('PENDING_FIXTURE: audit changed while reading pages');
  after=requireStatus(await call('GET','/version'),200,'version after').commit;
  report.build_after=after;
  if(before!==after)throw new Error('PENDING_BUILD: staging changed during read-only run');
  report.audit_rows=5;
  report.pages=[2,2,1,0];
  report.single_row_pages=5;
  report.same_timestamp=true;
  report.id_order_ascending=true;
  report.result='PASSED';
}catch(e){
  let message=String(e?.message||e);
  if(password)message=message.replaceAll(password,'<REDACTED>');
  if(token)message=message.replaceAll(token,'<REDACTED>');
  report.reason=message;
  report.result=/^PENDING_(?:FIXTURE|BUILD):/.test(message)?'PENDING':'FAILED';
}finally{
  token=null;
  report.build_stable=!!before&&before===after;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='PENDING'?2:1;
}
