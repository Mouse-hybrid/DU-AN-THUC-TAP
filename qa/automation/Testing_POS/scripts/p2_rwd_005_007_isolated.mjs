// QA 3 FIXED reward: apply to one owned order, replay, remove before payment,
// then close the order, clean the table and deactivate the owned reward.
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT,output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_005_007_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}
const tokens={},own={tableId:null,tableCode:null,sessionId:null,orderId:null,itemId:null,
  rewardId:null,rewardName:null,orderRewardId:null};
const report={test_refs:['PF-P2-RWD-005','PF-P2-RWD-007'],checked_at:new Date().toISOString(),
  result:'INCONCLUSIVE',business_cases:'P2-RWD-005/007 NOT_EXECUTED pending PO/CRM rule and full testcase scope; API component only.',
  secrets_recorded:false};
let before,after,component005=false,component007=false,orderClean=false,rewardClean=false,error;
async function call(method,path,role,body,key){
  const headers={Accept:'application/json'};
  if(role)headers.Authorization=`Bearer ${tokens[role]}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET')headers['Idempotency-Key']=key||randomUUID();
  const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(30_000)});
  return {http:r.status,data:await r.json().catch(()=>null)};
}
function must(r,http,label){if(r.http!==http)throw new Error(`${label}: HTTP ${r.http}, expected ${http}`);return r.data;}
async function post(path,role,body,key){return call('POST',path,role,body,key);}
async function sha(){return must(await call('GET','/version'),200,'version')?.commit;}
function safe(e){let s=String(e?.message||e);for(const secret of [password,...Object.values(tokens)])
  if(secret)s=s.replaceAll(secret,'<REDACTED>');return s;}
async function order(){return must(await call('GET',`/api/v1/orders/${own.orderId}`,'cashier'),200,'own order');}
async function table(){return must(await call('GET',`/api/v1/tables/${own.tableId}`,'waiter'),200,'own table');}
async function removeOwnedReward(){
  if(!own.orderId)return false;
  const current=await order();
  const appliedId=current.applied_reward?.id||own.orderRewardId;
  if(!current.applied_reward)return true;
  if(!appliedId)throw new Error('CLEANUP REQUIRED: applied reward id missing');
  const r=await call('DELETE',`/api/v1/orders/${own.orderId}/rewards/${appliedId}`,'cashier');
  must(r,200,'remove owned reward');
  return (await order()).applied_reward==null;
}
async function finishOrder(){
  if(!own.sessionId)return true;
  if(!own.orderId){
    const observed=await table();
    const candidates=(observed.orders||[]).filter(x=>x.table_session_id===own.sessionId);
    if(observed.current_session?.id===own.sessionId&&candidates.length===1)
      own.orderId=candidates[0].id;
  }
  if(!own.orderId)throw new Error(`CLEANUP REQUIRED: own ${own.tableCode} session ${own.sessionId} has no order id`);
  let o=await order(),t=await table();
  if(o.table_session_id!==own.sessionId||t.id!==own.tableId||
     (t.current_session?.id&&t.current_session.id!==own.sessionId))
    throw new Error('CLEANUP REQUIRED: table/session identity changed');
  if(o.applied_reward)await removeOwnedReward();
  if(o.status==='NEW')must(await post(`/api/v1/orders/${own.orderId}/send-to-kitchen`,'waiter'),200,'cleanup send');
  o=await order();
  if(!['BILLING','PAID','CLOSED'].includes(o.status))
    must(await post(`/api/v1/orders/${own.orderId}/request-billing`,'waiter'),200,'cleanup billing');
  o=await order();
  if(!['PAID','CLOSED'].includes(o.status))
    must(await post(`/api/v1/orders/${own.orderId}/pay`,'cashier'),200,'cleanup simulated pay');
  if((await order()).status!=='CLOSED')
    must(await post(`/api/v1/orders/${own.orderId}/close`,'cashier'),200,'cleanup close');
  t=await table();
  if(t.status==='CLEANING')must(await post(`/api/v1/tables/${own.tableId}/mark-clean`,'waiter'),200,'cleanup clean');
  return (await order()).status==='CLOSED'&&(await table()).status==='AVAILABLE';
}
try{
  before=await sha();
  if(!/^[0-9a-f]{40}$/.test(before||''))throw new Error('Invalid staging SHA');
  if(expected&&(!/^[0-9a-f]{7,40}$/.test(expected)||!before.startsWith(expected)))
    throw new Error('Staging SHA mismatch');
  report.staging_commit=before;
  const spec=must(await call('GET','/openapi.json'),200,'OpenAPI');
  for(const [path,method] of [
    ['/api/v1/rewards','post'],['/api/v1/rewards/{reward_id}','patch'],
    ['/api/v1/orders/{order_id}/rewards','post'],
    ['/api/v1/orders/{order_id}/rewards/{order_reward_id}','delete']])
    if(!spec?.paths?.[path]?.[method])throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  for(const [user,role,key] of [
    ['qa3_admin','SUPERVISOR','admin'],['qa3_waiter','WAITER','waiter'],['qa3_cashier','CASHIER','cashier']]){
    const login=must(await post('/api/v1/auth/login',null,{username:user,password}),200,`${user} login`);
    if(!login?.access_token)throw new Error(`${user} token missing`);
    tokens[key]=login.access_token;
    const me=must(await call('GET','/api/v1/auth/me',key),200,`${user} identity`);
    if(me.username!==user||me.role!==role||!me.outlet_id)throw new Error(`${user} role mismatch`);
    report[`${key}_outlet_id`]=me.outlet_id;
  }
  if(report.admin_outlet_id!==report.waiter_outlet_id||
     report.admin_outlet_id!==report.cashier_outlet_id)throw new Error('QA 3 role outlet mismatch');
  const tables=must(await call('GET','/api/v1/tables','waiter'),200,'tables');
  const candidates=tables.filter(x=>/^Q3-[123]$/.test(x.code)&&x.status==='AVAILABLE');
  const menu=must(await call('GET','/api/v1/menu?available_only=true','cashier'),200,'menu');
  const item=menu.find(x=>x.is_available&&x.station_id&&Number(x.price)>=1);
  if(!candidates.length||!item)throw new Error('PENDING_FIXTURE: free QA 3 table or positive-price mapped item missing');
  for(const candidate of candidates){
    const r=await post(`/api/v1/tables/${candidate.id}/open-session`,'waiter',{guest_count:1});
    if(r.http===409)continue;
    own.tableId=candidate.id;own.tableCode=candidate.code;
    own.sessionId=must(r,201,`open ${candidate.code}`)?.id;break;
  }
  if(!own.sessionId)throw new Error('PENDING_FIXTURE: QA 3 tables became occupied');
  own.orderId=must(await post('/api/v1/orders','cashier',{table_session_id:own.sessionId}),201,'create order')?.id;
  if(!own.orderId)throw new Error('CLEANUP REQUIRED: order id missing');
  const added=must(await post(`/api/v1/orders/${own.orderId}/items`,'cashier',
    {items:[{menu_item_id:item.id,quantity:1,note:'QA P2 RWD005007 owned fixture'}]}),201,'add item');
  own.itemId=added.items?.find(x=>x.menu_item_id===item.id)?.id;
  if(!own.itemId)throw new Error('CLEANUP REQUIRED: item id missing');
  const baseDetail=await order();
  own.rewardName=`QA P2RWD005007 ${randomUUID().slice(0,8)}`;
  const created=await post('/api/v1/rewards','admin',
    {name:own.rewardName,reward_type:'FIXED',value:'1.00',min_order_amount:'0'});
  own.rewardId=created.data?.id||null;
  must(created,201,'create owned reward');
  if(!own.rewardId)throw new Error('CLEANUP REQUIRED: reward id missing');
  const applyKey=randomUUID();
  const applied=await post(`/api/v1/orders/${own.orderId}/rewards`,'cashier',
    {reward_id:own.rewardId},applyKey);
  report.apply_http=applied.http;
  own.orderRewardId=applied.data?.applied_reward?.id||null;
  const replay=await post(`/api/v1/orders/${own.orderId}/rewards`,'cashier',
    {reward_id:own.rewardId},applyKey);
  report.apply_replay_http=replay.http;
  const withReward=await order();
  const applyAudit=must(await call('GET',
    `/api/v1/audit-logs?order_id=${own.orderId}&limit=100`,'admin'),200,'apply audit');
  component005=applied.http===201&&replay.http===201&&!!own.orderRewardId&&
    replay.data?.applied_reward?.id===own.orderRewardId&&
    withReward.applied_reward?.id===own.orderRewardId&&
    withReward.applied_reward?.reward_id===own.rewardId&&
    Number(withReward.discount_total)===1&&
    Number(withReward.total)===Number(baseDetail.total)-1&&
    applyAudit.filter(x=>x.action==='ORDER_REWARD_APPLIED').length===1;
  report.applied={order_reward_id:own.orderRewardId,discount:withReward.discount_total,
    total:withReward.total,assertions_passed:component005};
  const removeKey=randomUUID();
  const removed=await call('DELETE',
    `/api/v1/orders/${own.orderId}/rewards/${own.orderRewardId}`,'cashier',undefined,removeKey);
  report.remove_http=removed.http;
  const removeReplay=await call('DELETE',
    `/api/v1/orders/${own.orderId}/rewards/${own.orderRewardId}`,'cashier',undefined,removeKey);
  report.remove_replay_http=removeReplay.http;
  const afterRemove=await order();
  const audit=must(await call('GET',
    `/api/v1/audit-logs?order_id=${own.orderId}&limit=100`,'admin'),200,'remove audit');
  component007=removed.http===200&&removeReplay.http===200&&
    afterRemove.applied_reward==null&&Number(afterRemove.discount_total)===0&&
    Number(afterRemove.total)===Number(baseDetail.total)&&
    audit.filter(x=>x.action==='ORDER_REWARD_REMOVED').length===1;
  report.removed={discount:afterRemove.discount_total,total:afterRemove.total,
    audit_removed:audit.filter(x=>x.action==='ORDER_REWARD_REMOVED').length,
    assertions_passed:component007};
  report.components={'PF-P2-RWD-005':component005?'PASSED':'FAILED',
    'PF-P2-RWD-007':component007?'PASSED':'FAILED'};
}catch(e){error=safe(e);}
finally{
  if(!own.rewardId&&own.rewardName&&tokens.admin){
    try{
      const rewards=await call('GET','/api/v1/rewards','admin');
      if(rewards.http===200&&Array.isArray(rewards.data)){
        const matches=rewards.data.filter(x=>x.name===own.rewardName);
        if(matches.length===1)own.rewardId=matches[0].id;
      }
    }catch{/* preserve primary error */}
  }
  try{orderClean=await finishOrder();}catch(e){report.order_cleanup_error=safe(e);}
  if(own.rewardId&&tokens.admin){
    try{
      const disabled=await call('PATCH',`/api/v1/rewards/${own.rewardId}`,'admin',{is_active:false});
      rewardClean=disabled.http===200&&disabled.data?.is_active===false;
      report.reward_cleanup={http:disabled.http,inactive:rewardClean};
    }catch(e){report.reward_cleanup={inactive:false,error:safe(e)};}
  }
  report.cleanup={table_code:own.tableCode,order_id:own.orderId,order_closed:orderClean,
    table_available:orderClean,reward_disabled:rewardClean};
  try{after=await sha();}catch{/* preserve primary error */}
  report.build_stable=!!before&&before===after;
  if(!report.components)report.components={'PF-P2-RWD-005':'INCONCLUSIVE','PF-P2-RWD-007':'INCONCLUSIVE'};
  report.result=component005&&component007&&orderClean&&rewardClean&&report.build_stable?'PASSED':
    own.orderId&&orderClean&&rewardClean&&report.build_stable?'FAILED':'INCONCLUSIVE';
  if(error)report.error=error;
  if(own.sessionId&&!orderClean||own.rewardId&&!rewardClean)
    report.cleanup_required=`CLEANUP REQUIRED: ${own.tableCode||'Q3'} session ${own.sessionId||'unknown'} order ${own.orderId||'unknown'} reward ${own.rewardId||'unknown'}`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
