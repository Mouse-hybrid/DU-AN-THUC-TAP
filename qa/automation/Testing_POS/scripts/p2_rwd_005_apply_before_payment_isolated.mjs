// P2-RWD-005: apply a FIXED reward before payment and verify persisted amount and bill.
import {randomUUID,randomInt} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT,output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_005_apply_before_payment_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}
const tokens={};let own={tableId:null,tableCode:null,sessionId:null,orderId:null,itemId:null,
  rewardId:null,rewardName:null,orderRewardId:null,customerId:null,phone:null,customerName:null};
const report={run_id:'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-P2RWD005',test_ref:'P2-RWD-005',checked_at:new Date().toISOString(),
 result:'INCONCLUSIVE',scope:'QA3 FIXED reward application before payment: persisted reward ID, discount, bill and audit; safe owned cleanup. Customer UI and unapproved SLA excluded.',
 secrets_recorded:false,phone_recorded:false};
let before,after,orderClean=false,rewardClean=false,error;
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
  if(!own.sessionId){if(own.openAttempted)throw new Error('CLEANUP REQUIRED: table open response uncertain; inspect table/session');return true;}
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
  if(!['PAID','CLOSED'].includes(o.status)&&o.customer_id)must(await post('/api/v1/orders/'+own.orderId+'/customer','cashier',{customer_id:null}),200,'cleanup detach customer');
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

let executed=false, assertions=false, cleaned=true;
report.cleanup_errors=[];
const read=async(path,role='admin')=>must(await call('GET',path,role),200,'GET '+path);
const check=(ok,label)=>{if(!ok)throw new Error(label);};
try{
  before=await sha();report.staging_commit=before;
  check(/^[a-f0-9]{40}$/.test(before||''),'Invalid staging SHA');
  check(expected&&/^[a-f0-9]{40}$/.test(expected)&&before===expected,'PENDING_BUILD: full SHA mismatch');
  const spec=await read('/openapi.json');
  for(const [path,method] of [
    ['/api/v1/customers','post'],['/api/v1/rewards','post'],
    ['/api/v1/orders/{order_id}/rewards','post'],
    ['/api/v1/orders/{order_id}/rewards/{order_reward_id}','delete']])
    check(!!spec.paths?.[path]?.[method],`PENDING_CONTRACT: ${method} ${path} absent`);
  for(const [key,name,role] of [['admin','qa3_admin','SUPERVISOR'],
    ['cashier','qa3_cashier','CASHIER'],['waiter','qa3_waiter','WAITER'],
    ['kitchen','qa3_kitchen','KITCHEN']]){
    const login=must(await post('/api/v1/auth/login',null,{username:name,password}),200,'QA3 login');
    tokens[key]=login.access_token;
    const me=await read('/api/v1/auth/me',key);
    check(tokens[key]&&me.username===name&&me.role===role&&me.outlet_id,'QA3 role/outlet mismatch');
    report[key+'_outlet_id']=me.outlet_id;
  }
  check(new Set(['admin','cashier','waiter','kitchen'].map(x=>report[x+'_outlet_id'])).size===1,'QA3 roles differ in outlet');
  const candidates=(await read('/api/v1/tables','waiter')).filter(x=>/^Q3-[12]$/.test(x.code)&&x.status==='AVAILABLE');
  const menu=await read('/api/v1/menu?available_only=true','cashier');
  const item=menu.find(x=>x.is_available&&x.station_id&&!x.has_modifiers&&Number(x.price)>1);
  check(candidates.length>0&&item,'PENDING_FIXTURE: need AVAILABLE Q3-1/2 and mapped positive-price item');
  own.phone='09'+String(randomInt(0,100000000)).padStart(8,'0');
  check((await read('/api/v1/customers?phone='+own.phone,'cashier')).length===0,'PENDING_FIXTURE: generated phone exists');
  own.customerName='QA P2RWD005 '+randomUUID().slice(0,8);
  const customer=await post('/api/v1/customers','cashier',
    {phone:own.phone,full_name:own.customerName,consent:true});
  own.customerId=customer.data?.id;must(customer,201,'create owned customer');
  check(own.customerId,'CLEANUP REQUIRED: customer id missing');
  own.rewardName='QA P2RWD005 '+randomUUID().slice(0,8);
  const reward=await post('/api/v1/rewards','admin',
    {name:own.rewardName,reward_type:'FIXED',value:'1.00',min_order_amount:'0'});
  own.rewardId=reward.data?.id;must(reward,201,'create owned reward');
  check(own.rewardId,'CLEANUP REQUIRED: reward id missing');
  for(const candidate of candidates){
    own.tableId=candidate.id;own.tableCode=candidate.code;own.openAttempted=true;
    const opened=await post('/api/v1/tables/'+candidate.id+'/open-session','waiter',{guest_count:1});
    if(opened.http===409){own.openAttempted=false;continue;}
    own.sessionId=opened.data?.id;must(opened,201,'open own session');break;
  }
  check(own.sessionId,'PENDING_FIXTURE: candidate tables occupied');
  const created=await post('/api/v1/orders','cashier',{table_session_id:own.sessionId});
  own.orderId=created.data?.id;must(created,201,'create own order');
  check(own.orderId,'CLEANUP REQUIRED: order id missing');
  const added=must(await post('/api/v1/orders/'+own.orderId+'/items','waiter',
    {items:[{menu_item_id:item.id,quantity:1,note:'QA P2RWD005 own item'}]}),201,'add item');
  own.itemId=added.items?.find(x=>x.menu_item_id===item.id)?.id;
  check(own.itemId,'CLEANUP REQUIRED: own item id missing');
  must(await post('/api/v1/orders/'+own.orderId+'/customer','cashier',
    {customer_id:own.customerId}),200,'attach own customer');
  const baseOrder=await order();
  const beforePoints=await read('/api/v1/customers/'+own.customerId+'/points?limit=200','cashier');
  const beforeBalance=(await read('/api/v1/customers/'+own.customerId,'cashier')).points_balance;
  check(Array.isArray(beforePoints)&&beforePoints.length===0&&beforeBalance===0,'PENDING_FIXTURE: new customer points not empty');
  executed=true;
  const applyStarted=Date.now();
  const apply=await post('/api/v1/orders/'+own.orderId+'/rewards','cashier',{reward_id:own.rewardId});
  report.apply_elapsed_ms=Date.now()-applyStarted;
  own.orderRewardId=apply.data?.applied_reward?.id;report.apply_http=apply.http;
  const applied=await order();
  const remove=own.orderRewardId
    ?await call('DELETE','/api/v1/orders/'+own.orderId+'/rewards/'+own.orderRewardId,'cashier')
    :{http:null};
  report.remove_http=remove.http;
  const restored=await order();
  const points=await read('/api/v1/customers/'+own.customerId+'/points?limit=200','cashier');
  const balance=(await read('/api/v1/customers/'+own.customerId,'cashier')).points_balance;
  const audit=await read('/api/v1/audit-logs?order_id='+own.orderId+'&limit=200','admin');
  report.checks={
    applied_before_payment:apply.http===201&&!!own.orderRewardId&&baseOrder.status==='NEW'&&
      applied.status==='NEW'&&applied.applied_reward?.reward_id===own.rewardId&&
      applied.applied_reward?.id===own.orderRewardId&&
      Number(applied.applied_reward?.discount_amount)===1&&
      Number(applied.discount_total)===1&&Number(applied.total)===Number(baseOrder.total)-1,
    removed_before_payment:remove.http===200&&restored.applied_reward==null&&
      Number(restored.discount_total)===0&&Number(restored.total)===Number(baseOrder.total),
    points_unchanged:balance===beforeBalance&&JSON.stringify(points)===JSON.stringify(beforePoints),
    audit_once: audit.filter(x=>x.action==='ORDER_REWARD_APPLIED'&&
      x.staff_username==='qa3_cashier'&&x.entity_id===own.orderId).length===1&&
      audit.filter(x=>x.action==='ORDER_REWARD_REMOVED').length===1&&
      audit.filter(x=>x.action==='ORDER_PAID').length===0,
  };
  report.table_code=own.tableCode;report.order_id=own.orderId;report.reward_id=own.rewardId;
  report.before_total=baseOrder.total;report.applied_total=applied.total;
  report.applied_order_reward_id=own.orderRewardId;report.discount_amount=applied.applied_reward?.discount_amount;
  report.restored_total=restored.total;
  report.sla_30s_observed=report.apply_elapsed_ms<=30000;
  report.sla_30s_asserted=false;
  assertions=Object.values(report.checks).every(Boolean);
  if(!assertions)throw new Error('Reward removal failed to restore bill, points, or audit');
}catch(e){error=safe(e);}
finally{
  if(!own.customerId&&own.phone&&own.customerName&&tokens.cashier)try{
    const rows=await read('/api/v1/customers?phone='+own.phone,'cashier');
    if(rows.length===1&&rows[0].full_name===own.customerName)own.customerId=rows[0].id;
    else{cleaned=false;report.cleanup_errors.push('Customer create response uncertain');}
  }catch{cleaned=false;}
  if(!own.rewardId&&own.rewardName&&tokens.admin)try{
    const rows=await read('/api/v1/rewards','admin');
    const matches=rows.filter(x=>x.name===own.rewardName);
    if(matches.length===1)own.rewardId=matches[0].id;
    else{cleaned=false;report.cleanup_errors.push('Reward create response uncertain');}
  }catch{cleaned=false;}
  try{orderClean=await finishOrder();cleaned=cleaned&&orderClean;}
  catch(e){cleaned=false;report.order_cleanup_error=safe(e);}
  if(own.rewardId&&tokens.admin)try{
    const disabled=must(await call('PATCH','/api/v1/rewards/'+own.rewardId,'admin',
      {is_active:false}),200,'disable own reward');
    rewardClean=disabled.is_active===false;cleaned=cleaned&&rewardClean;
  }catch(e){cleaned=false;report.reward_cleanup_error=safe(e);}
  if(own.customerId&&tokens.admin)try{
    must(await call('PATCH','/api/v1/customers/'+own.customerId,'admin',
      {is_active:false}),200,'deactivate own customer');
    report.customer_inactive=(await read('/api/v1/customers/'+own.customerId,'admin')).is_active===false;
    cleaned=cleaned&&report.customer_inactive;
  }catch(e){cleaned=false;report.customer_cleanup_error=safe(e);}
  if(own.customerId&&tokens.cashier)try{
    const finalPoints=await read('/api/v1/customers/'+own.customerId+'/points?limit=200','cashier');
    const finalCustomer=await read('/api/v1/customers/'+own.customerId,'cashier');
    report.cleanup_points_unchanged=finalPoints.length===0&&finalCustomer.points_balance===0;
    cleaned=cleaned&&report.cleanup_points_unchanged;
  }catch(e){cleaned=false;report.points_cleanup_error=safe(e);}
  report.cleanup={table_code:own.tableCode,order_id:own.orderId,
    order_closed:report.cleanup_state?.order_closed===true,
    table_available:report.cleanup_state?.table_available===true,
    item_served:report.cleanup_state?.item_served===true,
    ticket_done:report.cleanup_state?.ticket_done===true,
    reward_inactive:rewardClean,customer_inactive:report.customer_inactive===true,
    points_unchanged:report.cleanup_points_unchanged===true,
    passed:cleaned};
  try{after=await sha();}catch{}
  report.build_after=after||null;report.build_stable=!!before&&before===after;
  report.business_execution=executed?'EXECUTED':'NOT_EXECUTED';
  report.cleanup_pass=cleaned;
  report.result=assertions&&cleaned&&report.build_stable?'PASSED':
    !cleaned?'INCONCLUSIVE':/^PENDING_/.test(error||'')?'PENDING':executed?'FAILED':'INCONCLUSIVE';
  if(error)report.error=error;
  if(!cleaned)report.cleanup_required=`Inspect owned ${own.tableCode||'QA3'} session ${own.sessionId||'unknown'}, order ${own.orderId||'unknown'}, reward ${own.rewardId||'unknown'}, customer ${own.customerId||'unknown'}; no global reset`;
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}

