// P2-RWD-008: isolated QA3 PAID reward state guards with served/DONE cleanup.
import {randomUUID,randomInt} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT,output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_008_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}
const tokens={},own={tableId:null,tableCode:null,sessionId:null,orderId:null,itemId:null,
  rewardId:null,rewardName:null,orderRewardId:null,customerId:null,phone:null,customerName:null};
const report={run_id:'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-P2RWD008',test_ref:'P2-RWD-008',checked_at:new Date().toISOString(),
 result:'INCONCLUSIVE',scope:'QA3 PAID reward apply/remove guards; immutable money, points and audit; simulated payment; no customer UI.',
 secrets_recorded:false,phone_recorded:false};
let before,after,component005=false,component007=false,orderClean=false,rewardClean=false,customerClean=false,error;
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
function safe(e){let s=String(e?.message||e);for(const secret of [password,own.phone,...Object.values(tokens)])
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
  if(o.applied_reward&&!['PAID','CLOSED'].includes(o.status))await removeOwnedReward();
  if(o.status==='NEW')must(await post(`/api/v1/orders/${own.orderId}/send-to-kitchen`,'waiter'),200,'cleanup send');
  await serveOwned();
  o=await order();
  if(!['BILLING','PAID','CLOSED'].includes(o.status))
    must(await post(`/api/v1/orders/${own.orderId}/request-billing`,'waiter'),200,'cleanup billing');
  o=await order();
  if(!['PAID','CLOSED'].includes(o.status))
    must(await post(`/api/v1/orders/${own.orderId}/pay`,'cashier'),200,'cleanup simulated pay');
  if((await order()).status!=='CLOSED')
    must(await post(`/api/v1/orders/${own.orderId}/close`,'cashier'),200,'cleanup close');
  t=await table();
  if(t.current_session?.id&&t.current_session.id!==own.sessionId)throw new Error('CLEANUP REQUIRED: new session detected');
  if(t.status==='CLEANING')must(await post(`/api/v1/tables/${own.tableId}/mark-clean`,'waiter'),200,'cleanup clean');
  const final=await order(),end=await table();
  const tickets=await ownTickets();
  const active=must(await call('GET','/api/v1/kitchen/queue','kitchen'),200,'active queue');
  if(!Array.isArray(active))throw new Error('Queue response not an array');
  report.cleanup_state={order_closed:final.status==='CLOSED',table_available:end.status==='AVAILABLE',
    item_served:final.items.find(x=>x.id===own.itemId)?.status==='SERVED',
    ticket_done:tickets.length===1&&tickets[0].status==='DONE',no_active_ticket:!active.some(x=>x.order_id===own.orderId),open_session:!!end.current_session};
  return Object.entries(report.cleanup_state).every(([k,v])=>k==='open_session'?!v:v);
}
async function serveOwned(){
  let o=await order();
  if(o.table_session_id!==own.sessionId)throw new Error('Owned session mismatch');
  if(o.items.length!==1||o.items[0].id!==own.itemId)throw new Error('Owned item set changed');
  if(o.items[0].status==='CREATED')must(await post('/api/v1/orders/'+own.orderId+'/send-to-kitchen','waiter'),200,'send own item');
  for(const [from,action,role] of [['SENT','start-cooking','kitchen'],['PREPARING','mark-ready','kitchen'],['READY','pickup','waiter'],['PICKED_UP','served','waiter']]){
    if((await order()).items.find(x=>x.id===own.itemId)?.status===from)
      must(await post('/api/v1/orders/'+own.orderId+'/items/'+own.itemId+'/'+action,role),200,action);
  }
  if((await order()).items.find(x=>x.id===own.itemId)?.status!=='SERVED')throw new Error('Own item not SERVED');
}
async function ownTickets(){
  const rows=must(await call('GET','/api/v1/kitchen/queue?status=DONE','kitchen'),200,'own done ticket');
  if(!Array.isArray(rows))throw new Error('Queue response not an array');
  return rows.filter(x=>x.order_id===own.orderId&&x.order_item_id===own.itemId);
}
function unchanged(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function snapshot(){
 const o=await order();
 const points=must(await call('GET','/api/v1/customers/'+own.customerId+'/points','cashier'),200,'points snapshot');
 const audit=must(await call('GET','/api/v1/audit-logs?order_id='+own.orderId+'&limit=500','admin'),200,'audit snapshot');
 return {order:{status:o.status,customer_id:o.customer_id,subtotal:o.subtotal,total:o.total,discount_total:o.discount_total,applied_reward:o.applied_reward},
   points,audit_ids:audit.map(x=>x.id)};
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
    ['qa3_admin','SUPERVISOR','admin'],['qa3_kitchen','KITCHEN','kitchen'],['qa3_waiter','WAITER','waiter'],['qa3_cashier','CASHIER','cashier']]){
    const login=must(await post('/api/v1/auth/login',null,{username:user,password}),200,`${user} login`);
    if(!login?.access_token)throw new Error(`${user} token missing`);
    tokens[key]=login.access_token;
    const me=must(await call('GET','/api/v1/auth/me',key),200,`${user} identity`);
    if(me.username!==user||me.role!==role||!me.outlet_id)throw new Error(`${user} role mismatch`);
    report[`${key}_outlet_id`]=me.outlet_id;
  }
  if(report.admin_outlet_id!==report.kitchen_outlet_id||report.admin_outlet_id!==report.waiter_outlet_id||
     report.admin_outlet_id!==report.cashier_outlet_id)throw new Error('QA 3 role outlet mismatch');
  const tables=must(await call('GET','/api/v1/tables','waiter'),200,'tables');
  const candidates=tables.filter(x=>/^Q3-[12]$/.test(x.code)&&x.status==='AVAILABLE');
  const menu=must(await call('GET','/api/v1/menu?available_only=true','cashier'),200,'menu');
  const item=menu.find(x=>x.is_available&&x.station_id&&!x.has_modifiers&&Number(x.price)>1);
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
    {items:[{menu_item_id:item.id,quantity:1,note:'QA P2 RWD008 owned fixture'}]}),201,'add item');
  own.itemId=added.items?.find(x=>x.menu_item_id===item.id)?.id;
  if(!own.itemId)throw new Error('CLEANUP REQUIRED: item id missing');

  own.phone='09'+String(randomInt(0,100_000_000)).padStart(8,'0');
  const existing=must(await call('GET','/api/v1/customers?phone='+own.phone,'cashier'),200,'phone precheck');
  if(!Array.isArray(existing)||existing.length)throw new Error('PENDING_FIXTURE: generated phone already exists');
  own.customerName='QA P2RWD008 '+randomUUID().slice(0,8);
  const createdCustomer=await post('/api/v1/customers','cashier',
    {phone:own.phone,full_name:own.customerName,consent:true});
  own.customerId=createdCustomer.data?.id;
  must(createdCustomer,201,'create owned customer');
  if(!own.customerId)throw new Error('CLEANUP REQUIRED: created customer id unavailable');
  must(await post('/api/v1/orders/'+own.orderId+'/customer','cashier',{customer_id:own.customerId}),200,'attach customer');
  own.rewardName='QA P2RWD008 '+randomUUID().slice(0,8);
  const created=await post('/api/v1/rewards','admin',{name:own.rewardName,reward_type:'FIXED',value:'1.00',min_order_amount:'0'});
  own.rewardId=created.data?.id;
  must(created,201,'create owned reward');
  if(!own.rewardId)throw new Error('CLEANUP REQUIRED: reward id unavailable');
  const applied=must(await post('/api/v1/orders/'+own.orderId+'/rewards','cashier',{reward_id:own.rewardId}),201,'apply before pay');
  own.orderRewardId=applied.applied_reward?.id;
  if(!own.orderRewardId)throw new Error('Applied reward id missing');
  await serveOwned();
  must(await post('/api/v1/orders/'+own.orderId+'/request-billing','waiter'),200,'billing');
  must(await post('/api/v1/orders/'+own.orderId+'/pay','cashier'),200,'simulated pay');
  const original=await snapshot();
  if(original.order.status!=='PAID'||original.order.applied_reward?.status!=='COMMITTED')
    throw new Error('PAID/COMMITTED precondition not met');
  const applyAfter=await post('/api/v1/orders/'+own.orderId+'/rewards','cashier',{reward_id:own.rewardId});
  const afterApply=await snapshot();
  const removeAfter=await call('DELETE','/api/v1/orders/'+own.orderId+'/rewards/'+own.orderRewardId,'cashier');
  const afterRemove=await snapshot();
  component005=applyAfter.http===409&&/PAID/.test(String(applyAfter.data?.detail))&&unchanged(original,afterApply);
  component007=removeAfter.http===409&&/COMMITTED/.test(String(removeAfter.data?.detail))&&unchanged(original,afterRemove);
  report.apply_after_paid_http=applyAfter.http;
  report.remove_after_paid_http=removeAfter.http;
  report.checks={apply_denied:component005,remove_denied:component007,
    money_points_audit_unchanged:unchanged(original,afterApply)&&unchanged(original,afterRemove)};
  report.paid={order_id:own.orderId,customer_id:own.customerId,discount:original.order.discount_total,total:original.order.total};
  report.assertions_passed=component005&&component007;

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
      const listed=must(await call('GET','/api/v1/rewards?active_only=false','admin'),200,'verify reward disabled');
      rewardClean=disabled.http===200&&Array.isArray(listed)&&listed.find(x=>x.id===own.rewardId)?.is_active===false;
      report.reward_cleanup={http:disabled.http,inactive:rewardClean};
    }catch(e){report.reward_cleanup={inactive:false,error:safe(e)};}
  }
  if(!own.customerId&&own.phone&&own.customerName&&tokens.admin){
    try{const found=must(await call('GET','/api/v1/customers?phone='+own.phone,'admin'),200,'recover owned customer');
      if(Array.isArray(found)&&found.length===1&&found[0].full_name===own.customerName)own.customerId=found[0].id;
    }catch(e){report.customer_recovery_error=safe(e);}
  }
  if(own.customerId&&tokens.admin){
    try{
      must(await call('PATCH','/api/v1/customers/'+own.customerId,'admin',{is_active:false}),200,'deactivate customer');
      customerClean=must(await call('GET','/api/v1/customers/'+own.customerId,'admin'),200,'verify inactive customer').is_active===false;
    }catch(e){report.customer_cleanup_error=safe(e);}
  }
  report.customer_inactive=customerClean;
  report.cleanup={table_code:own.tableCode,order_id:own.orderId,order_closed:report.cleanup_state?.order_closed??false,
    table_available:report.cleanup_state?.table_available??false,reward_disabled:rewardClean};
  try{after=await sha();}catch{/* preserve primary error */}
  report.build_stable=!!before&&before===after;
  report.result=report.checks&&(!component005||!component007)?'FAILED':component005&&component007&&orderClean&&rewardClean&&customerClean&&report.build_stable?'PASSED':
    own.orderId&&orderClean&&rewardClean&&customerClean&&report.build_stable?'FAILED':'INCONCLUSIVE';
  if(error)report.error=error;
  if(own.sessionId&&!orderClean||own.rewardId&&!rewardClean||own.customerId&&!customerClean)
    report.cleanup_required=`CLEANUP REQUIRED: ${own.tableCode||'Q3'} session ${own.sessionId||'unknown'} order ${own.orderId||'unknown'} reward ${own.rewardId||'unknown'} customer ${own.customerId||'unknown'}`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}

