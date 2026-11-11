// PF-P2-RWD-004: evaluate two owned QA 3 FIXED rewards against an owned order.
// Disable both reward fixtures and close/clean the owned table on every exit.
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT;
const output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_004_eligibility_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}

const tokens={},own={tableId:null,tableCode:null,sessionId:null,orderId:null,itemId:null,rewards:[]};
let before,after,assertions=false,orderClean=false,rewardsClean=false,error;
const report={test_ref:'PF-P2-RWD-004',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'QA 3 own order with two own active FIXED rewards: eligible and MIN_ORDER denial; no apply/payment discount asserted.',
  business_case:'P2-RWD-004 NOT_EXECUTED: PO/CRM reward policy and customer-specific eligibility still require review.',
  secrets_recorded:false};
async function call(method,path,role,body){
  const headers={Accept:'application/json'};
  if(role)headers.Authorization=`Bearer ${tokens[role]}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET')headers['Idempotency-Key']=randomUUID();
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(30_000)});
  return {http:r.status,data:await r.json().catch(()=>null)};
}
function must(r,http,label){if(r.http!==http)throw new Error(`${label}: HTTP ${r.http}, expected ${http}`);return r.data;}
async function post(path,role,body){return call('POST',path,role,body);}
async function version(){return must(await call('GET','/version'),200,'version')?.commit;}
function safe(e){let s=String(e?.message||e);for(const secret of [password,...Object.values(tokens)])
  if(secret)s=s.replaceAll(secret,'<REDACTED>');return s;}
async function order(){return must(await call('GET',`/api/v1/orders/${own.orderId}`,'cashier'),200,'own order');}
async function table(){return must(await call('GET',`/api/v1/tables/${own.tableId}`,'waiter'),200,'own table');}
async function finishOrder(){
  if(!own.sessionId)return true;
  if(!own.orderId){
    const rows=(await table()).orders?.filter(x=>x.table_session_id===own.sessionId)||[];
    if(rows.length===1)own.orderId=rows[0].id;
    else if(!rows.length)own.orderId=must(await post('/api/v1/orders','waiter',
      {table_session_id:own.sessionId}),201,'cleanup create order')?.id;
    if(!own.orderId)throw new Error(`CLEANUP REQUIRED: ${own.tableCode} session ${own.sessionId}; no order id`);
  }
  let o=await order(),t=await table();
  if(o.table_session_id!==own.sessionId||t.id!==own.tableId||
     (t.current_session?.id&&t.current_session.id!==own.sessionId))
    throw new Error('CLEANUP REQUIRED: owned table/session identity changed');
  if(o.status==='NEW')must(await post(`/api/v1/orders/${own.orderId}/send-to-kitchen`,'waiter'),200,'cleanup send');
  for(const item of (await order()).items){
    for(const [state,action,role] of [['SENT','start-cooking','kitchen'],
      ['PREPARING','mark-ready','kitchen'],['READY','pickup','waiter'],
      ['PICKED_UP','served','waiter']]){
      if((await order()).items.find(x=>x.id===item.id)?.status===state)
        must(await post(`/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,role),200,`cleanup ${action}`);
    }
    if((await order()).items.find(x=>x.id===item.id)?.status!=='SERVED')
      throw new Error(`CLEANUP REQUIRED: item ${item.id} not SERVED`);
  }
  o=await order();
  if(!['BILLING','PAID','CLOSED'].includes(o.status))
    must(await post(`/api/v1/orders/${own.orderId}/request-billing`,'waiter'),200,'cleanup billing');
  o=await order();
  if(!['PAID','CLOSED'].includes(o.status))
    must(await post(`/api/v1/orders/${own.orderId}/pay`,'cashier'),200,'cleanup simulated pay');
  if((await order()).status!=='CLOSED')
    must(await post(`/api/v1/orders/${own.orderId}/close`,'cashier'),200,'cleanup close');
  t=await table();
  if(t.status==='CLEANING')must(await post(`/api/v1/tables/${own.tableId}/mark-clean`,'waiter'),200,'cleanup mark clean');
  return (await order()).status==='CLOSED'&&(await table()).status==='AVAILABLE';
}
try{
  before=await version();
  if(!/^[0-9a-f]{40}$/.test(before||''))throw new Error('Invalid staging SHA');
  if(expected&&(!/^[0-9a-f]{7,40}$/.test(expected)||!before.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  report.staging_commit=before;
  const spec=must(await call('GET','/openapi.json'),200,'OpenAPI');
  for(const [path,method] of [
    ['/api/v1/rewards','post'],['/api/v1/rewards/{reward_id}','patch'],
    ['/api/v1/orders/{order_id}/eligible-rewards','get']])
    if(!spec?.paths?.[path]?.[method])throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  for(const [user,role,key] of [
    ['qa3_admin','SUPERVISOR','admin'],['qa3_waiter','WAITER','waiter'],
    ['qa3_cashier','CASHIER','cashier'],['qa3_kitchen','KITCHEN','kitchen']]){
    const login=must(await post('/api/v1/auth/login',null,{username:user,password}),200,`${user} login`);
    if(!login?.access_token)throw new Error(`${user} token missing`);
    tokens[key]=login.access_token;
    const me=must(await call('GET','/api/v1/auth/me',key),200,`${user} identity`);
    if(me.username!==user||me.role!==role||!me.outlet_id)throw new Error(`${user} identity mismatch`);
    report[`${key}_outlet_id`]=me.outlet_id;
  }
  if(report.admin_outlet_id!==report.waiter_outlet_id||
     report.admin_outlet_id!==report.cashier_outlet_id)throw new Error('QA 3 role outlet mismatch');
  const ts=must(await call('GET','/api/v1/tables','waiter'),200,'QA 3 tables');
  const available=ts.filter(x=>/^Q3-[123]$/.test(x.code)&&x.status==='AVAILABLE');
  const menu=must(await call('GET','/api/v1/menu?available_only=true','cashier'),200,'QA 3 menu');
  const item=menu.find(x=>x.is_available&&x.station_id&&Number(x.price)>=1);
  if(!available.length||!item)throw new Error('PENDING_FIXTURE: no free Q3 table or positive-price mapped item');
  for(const candidate of available){
    const opened=await post(`/api/v1/tables/${candidate.id}/open-session`,'waiter',{guest_count:1});
    if(opened.http===409)continue;
    own.tableId=candidate.id;own.tableCode=candidate.code;
    own.sessionId=must(opened,201,`open ${candidate.code}`)?.id;
    break;
  }
  if(!own.sessionId)throw new Error('PENDING_FIXTURE: Q3 tables became occupied');
  own.orderId=must(await post('/api/v1/orders','cashier',{table_session_id:own.sessionId}),201,'create order')?.id;
  if(!own.orderId)throw new Error('CLEANUP REQUIRED: order id missing after create');
  const added=must(await post(`/api/v1/orders/${own.orderId}/items`,'cashier',
    {items:[{menu_item_id:item.id,quantity:1,note:'QA P2 RWD004 owned fixture'}]}),201,'add item');
  own.itemId=added.items?.find(x=>x.menu_item_id===item.id)?.id;
  if(!own.itemId)throw new Error('CLEANUP REQUIRED: own item id missing');
  const subtotal=Number(item.price);
  const high=(subtotal+1).toFixed(2);
  const prefix=`QA P2RWD004 ${randomUUID().slice(0,8)}`;
  for(const [suffix,minAmount] of [['eligible','0'],['min-order',high]]){
    const created=await post('/api/v1/rewards','admin',
      {name:`${prefix} ${suffix}`,reward_type:'FIXED',value:'1.00',min_order_amount:minAmount});
    const id=created.data?.id;
    if(id)own.rewards.push({id,label:suffix});
    must(created,201,`create ${suffix} reward`);
    if(!id)throw new Error('CLEANUP REQUIRED: reward id missing');
  }
  const eligible=must(await call('GET',
    `/api/v1/orders/${own.orderId}/eligible-rewards`,'cashier'),200,'eligible rewards');
  const good=eligible.find(x=>x.reward_id===own.rewards[0].id);
  const bad=eligible.find(x=>x.reward_id===own.rewards[1].id);
  const o=await order();
  const audit=must(await call('GET',
    `/api/v1/audit-logs?order_id=${own.orderId}&limit=100`,'admin'),200,'own audit');
  assertions=good?.eligible===true&&Number(good.discount_amount)===1&&
    bad?.eligible===false&&bad?.reason_code==='MIN_ORDER'&&
    o.id===own.orderId&&o.table_session_id===own.sessionId&&o.items?.some(x=>x.id===own.itemId)&&
    o.status==='NEW'&&Array.isArray(audit)&&audit.some(x=>x.action==='ORDER_CREATED');
  report.checks={eligible:{value:good?.eligible??null,discount:good?.discount_amount??null},
    min_order:{value:bad?.eligible??null,reason_code:bad?.reason_code??null},
    order_unchanged:o.status==='NEW'};
  report.assertions_passed=assertions;
}catch(e){error=safe(e);}
finally{
  try{orderClean=await finishOrder();}catch(e){report.order_cleanup_error=safe(e);}
  const rewardCleanup=[];
  for(const r of own.rewards){
    try{
      const updated=await call('PATCH',`/api/v1/rewards/${r.id}`,'admin',{is_active:false});
      rewardCleanup.push({id:r.id,http:updated.http,inactive:updated.http===200&&updated.data?.is_active===false});
    }catch(e){rewardCleanup.push({id:r.id,inactive:false,error:safe(e)});}
  }
  rewardsClean=rewardCleanup.length===2&&rewardCleanup.every(x=>x.inactive);
  report.cleanup={table_code:own.tableCode,order_id:own.orderId,order_closed:orderClean,
    table_available:orderClean,rewards:rewardCleanup,rewards_disabled:rewardsClean};
  try{after=await version();}catch{/* preserve original error */}
  report.build_stable=!!before&&before===after;
  report.result=assertions&&orderClean&&rewardsClean&&report.build_stable?'PASSED':
    own.orderId&&orderClean&&rewardsClean&&report.build_stable?'FAILED':'INCONCLUSIVE';
  if(error)report.error=error;
  if(own.sessionId&&!orderClean||own.rewards.length&&!rewardsClean)
    report.cleanup_required=`CLEANUP REQUIRED: own ${own.tableCode||'Q3'} session ${own.sessionId||'unknown'} order ${own.orderId||'unknown'} reward ids ${own.rewards.map(x=>x.id).join(',')}`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
