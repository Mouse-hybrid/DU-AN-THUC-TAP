// P2-RWD-006: isolated QA3 PAID reward state guards with served/DONE cleanup.
import {randomUUID,randomInt} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT,output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_006_concurrent_redeem_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}
const tokens={};let own={tableId:null,tableCode:null,sessionId:null,orderId:null,itemId:null,
  rewardId:null,rewardName:null,orderRewardId:null,customerId:null,phone:null,customerName:null};
const report={run_id:'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-P2RWD006',test_ref:'P2-RWD-006',checked_at:new Date().toISOString(),
 result:'INCONCLUSIVE',scope:'QA3 two concurrent simulated payments compete for one points balance; ledger/history/audit and owned cleanup.',
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

const fixtures=[],shared={phone:null,customerId:null,rewardId:null,customerName:null,rewardName:null};
let executed=false,passed=false,clean=true,rule;
report.cleanup_errors=[];
function check(ok,label){if(!ok)throw new Error(label);}
function cents(v){const n=Number(v)*100;check(Number.isSafeInteger(Math.round(n))&&Math.abs(n-Math.round(n))<0.00001,'Invalid monetary value');return Math.round(n);}
const read=async(path,role='admin')=>must(await call('GET',path,role),200,'GET '+path);
async function rulesStable(){const list=await read('/api/v1/loyalty-rules');check(JSON.stringify(list[0])===JSON.stringify(rule),'PENDING_BUILD: loyalty rule changed');}
try{
 before=await sha();report.staging_commit=before;
 check(/^[a-f0-9]{40}$/.test(before||''),'Invalid staging SHA');
 check(expected&&before.startsWith(expected),'PENDING_BUILD: pin POS_EXPECTED_COMMIT to current SHA');
 for(const [key,name,role] of [['admin','qa3_admin','SUPERVISOR'],['cashier','qa3_cashier','CASHIER'],['waiter','qa3_waiter','WAITER'],['kitchen','qa3_kitchen','KITCHEN']]){
   const login=must(await post('/api/v1/auth/login',null,{username:name,password}),200,'QA3 login');
   tokens[key]=login.access_token;
   const me=await read('/api/v1/auth/me',key);
   check(me.username===name&&me.role===role&&me.outlet_id,'QA3 role mismatch');
   report[key+'_outlet_id']=me.outlet_id;
 }
 check(new Set(['admin','cashier','waiter','kitchen'].map(k=>report[k+'_outlet_id'])).size===1,'QA3 outlet mismatch');
 const tables=(await read('/api/v1/tables')).filter(x=>/^Q3-[12]$/.test(x.code)&&x.status==='AVAILABLE');
 check(tables.length===2,'PENDING_FIXTURE: Q3-1 and Q3-2 must both be AVAILABLE');
 rule=(await read('/api/v1/loyalty-rules'))[0];
 check(rule,'PENDING_FIXTURE: no loyalty rule');
 const value=cents(rule.redeem_value_per_point),earn=cents(rule.earn_amount_per_point);
 check(value>0&&earn>0,'Invalid loyalty rule amounts');
 const menu=await read('/api/v1/menu?available_only=true','cashier');
 const item=menu.find(x=>{
   const subtotal=cents(x.price);
   const points=Math.floor(subtotal*rule.max_redeem_percent/100/value);
   const replenished=Math.floor((subtotal-points*value)/earn);
   return x.is_available&&x.station_id&&!x.has_modifiers&&points>0&&points<=1000000&&replenished<points;
 });
 check(item,'PENDING_FIXTURE: need mapped item with redeem amount larger than points earned at pay');
 const subtotal=cents(item.price),points=Math.floor(subtotal*rule.max_redeem_percent/100/value);
 const expectedEarn=Math.floor((subtotal-points*value)/earn);
 report.rule={id:rule.id,version:rule.version,earn_amount_per_point:rule.earn_amount_per_point,redeem_value_per_point:rule.redeem_value_per_point,max_redeem_percent:rule.max_redeem_percent};
 report.points_to_redeem=points;report.expected_earn=expectedEarn;
 shared.phone='09'+String(randomInt(0,100000000)).padStart(8,'0');
 check((await read('/api/v1/customers?phone='+shared.phone)).length===0,'PENDING_FIXTURE: generated phone already exists');
 shared.customerName='QA P2RWD006 '+randomUUID().slice(0,8);Object.assign(own,shared);
 const customer=await post('/api/v1/customers','cashier',{phone:shared.phone,full_name:shared.customerName,consent:true});
 shared.customerId=customer.data?.id;Object.assign(own,shared);must(customer,201,'create owned customer');
 check(shared.customerId,'CLEANUP REQUIRED: customer id missing');
 must(await post('/api/v1/customers/'+shared.customerId+'/points/adjust','admin',{points,reason:'QA P2-RWD-006 isolated balance'}),201,'seed owned balance');
 shared.rewardName='QA P2RWD006 '+randomUUID().slice(0,8);
 const reward=await post('/api/v1/rewards','admin',{name:shared.rewardName,reward_type:'POINTS',min_order_amount:'0'});
 shared.rewardId=reward.data?.id;Object.assign(own,shared);must(reward,201,'create owned points reward');
 check(shared.rewardId,'CLEANUP REQUIRED: reward id missing');
 for(const table of tables){
   own={...shared,tableId:table.id,tableCode:table.code,sessionId:null,orderId:null,itemId:null};
   fixtures.push(own);
   own.openAttempted=true;
   const opened=await post('/api/v1/tables/'+table.id+'/open-session','waiter',{guest_count:1});
   if(opened.http!==201)own.openAttempted=false;
   own.sessionId=opened.data?.id;must(opened,201,'open owned table');
   check(own.sessionId,'CLEANUP REQUIRED: session id missing');
   const created=await post('/api/v1/orders','cashier',{table_session_id:own.sessionId});
   own.orderId=created.data?.id;must(created,201,'create order');
   const added=must(await post('/api/v1/orders/'+own.orderId+'/items','waiter',{items:[{menu_item_id:item.id,quantity:1,note:'QA P2RWD006 owned fixture'}]}),201,'add item');
   own.itemId=added.items?.find(x=>x.menu_item_id===item.id)?.id;check(own.itemId,'Own item id missing');
   must(await post('/api/v1/orders/'+own.orderId+'/customer','cashier',{customer_id:shared.customerId}),200,'attach customer');
   const applied=must(await post('/api/v1/orders/'+own.orderId+'/rewards','cashier',{reward_id:shared.rewardId,points}),201,'apply points before payment');
   own.orderRewardId=applied.applied_reward?.id;check(own.orderRewardId,'Applied reward missing');
   await serveOwned();
   must(await post('/api/v1/orders/'+own.orderId+'/request-billing','waiter'),200,'billing');
 }
 const initial=await read('/api/v1/customers/'+shared.customerId);
 check(initial.points_balance===points,'Balance changed before concurrent test');
 await rulesStable();check(await sha()===before,'PENDING_BUILD: SHA changed before payments');
 executed=true;
 const attempts=await Promise.allSettled(fixtures.map(async f=>{
   const started=Date.now();
   const response=await post('/api/v1/orders/'+f.orderId+'/pay','cashier',undefined,randomUUID());
   return {order_id:f.orderId,http:response.http,started_ms:started,ended_ms:Date.now(),insufficient_points:/không đủ điểm/i.test(String(response.data?.detail))};
 }));
 report.concurrent=attempts.map((x,i)=>x.status==='fulfilled'?x.value:{order_id:fixtures[i].orderId,http:null,error:'Payment response unavailable'});
 check(attempts.every(x=>x.status==='fulfilled'),'INCONCLUSIVE: payment request transport error; inspect owned orders');
 const replies=attempts.map(x=>x.value);
 const states=await Promise.all(fixtures.map(f=>read('/api/v1/orders/'+f.orderId)));
 const current=await read('/api/v1/customers/'+shared.customerId);
 const ledger=await read('/api/v1/customers/'+shared.customerId+'/points?limit=200');
 const usage=await read('/api/v1/customers/'+shared.customerId+'/reward-usage?limit=200');
 const redemptions=ledger.filter(x=>x.entry_type==='REDEEM'),earned=ledger.filter(x=>x.entry_type==='EARN');
 const paidIndex=replies.findIndex(x=>x.http===200),loserIndex=replies.findIndex(x=>x.http===409);
 const audits=await Promise.all(fixtures.map(f=>read('/api/v1/audit-logs?order_id='+f.orderId+'&limit=500')));
 report.checks={
  exactly_one_paid:replies.filter(x=>x.http===200).length===1&&replies.filter(x=>x.http===409&&x.insufficient_points).length===1,
  state_guard:paidIndex>=0&&loserIndex>=0&&states[paidIndex].status==='PAID'&&states[loserIndex].status==='BILLING',
  one_redemption:redemptions.length===1&&redemptions[0].points===-points&&paidIndex>=0&&redemptions[0].order_id===fixtures[paidIndex].orderId,
  earn_correct:earned.length===(expectedEarn?1:0)&&earned.reduce((n,x)=>n+x.points,0)===expectedEarn,
  balance_correct:current.points_balance===expectedEarn&&ledger.reduce((n,x)=>n+x.points,0)===current.points_balance,
  never_negative:ledger.every(x=>x.balance_after>=0)&&current.points_balance>=0,
  one_usage:usage.length===1&&usage[0].status==='COMMITTED'&&usage[0].points_used===points&&paidIndex>=0&&usage[0].order_id===fixtures[paidIndex].orderId,
  audit_payment_once:audits.flat().filter(x=>x.action==='ORDER_PAID').length===1
 };
 report.balance_after=current.points_balance;
 report.ledger=ledger.map(({id,entry_type,points,balance_after,order_id,rule_version})=>({id,entry_type,points,balance_after,order_id,rule_version}));
 await rulesStable();passed=Object.values(report.checks).every(Boolean);report.assertions_passed=passed;
}catch(e){error=safe(e);}
finally{
 report.cleanup=[];
 for(const fixture of fixtures){
   own=fixture;
   try{const ok=await finishOrder();report.cleanup.push({table_code:own.tableCode,order_id:own.orderId,...report.cleanup_state,passed:ok});if(!ok)clean=false;}
   catch(e){clean=false;report.cleanup.push({table_code:own.tableCode,order_id:own.orderId,passed:false,error:safe(e)});}
 }
 own={...shared};delete report.cleanup_state;
 if(!shared.customerId&&shared.phone&&shared.customerName){
  try{const rows=await read('/api/v1/customers?phone='+shared.phone);if(rows.length===1&&rows[0].full_name===shared.customerName)shared.customerId=rows[0].id;else {clean=false;report.cleanup_errors.push('Customer creation response uncertain; manual check required');}}catch{clean=false;}
 }
 if(!shared.rewardId&&shared.rewardName){
  try{const rows=(await read('/api/v1/rewards')).filter(x=>x.name===shared.rewardName);if(rows.length===1)shared.rewardId=rows[0].id;else {clean=false;report.cleanup_errors.push('Reward creation response uncertain; manual check required');}}catch{clean=false;}
 }
 if(shared.rewardId)try{
   must(await call('PATCH','/api/v1/rewards/'+shared.rewardId,'admin',{is_active:false}),200,'disable reward');
   report.reward_inactive=(await read('/api/v1/rewards')).find(x=>x.id===shared.rewardId)?.is_active===false;
   clean=clean&&report.reward_inactive;
 }catch(e){clean=false;report.reward_cleanup_error=safe(e);}
 if(shared.customerId)try{
   must(await call('PATCH','/api/v1/customers/'+shared.customerId,'admin',{is_active:false}),200,'deactivate customer');
   report.customer_inactive=(await read('/api/v1/customers/'+shared.customerId)).is_active===false;
   clean=clean&&report.customer_inactive;
 }catch(e){clean=false;report.customer_cleanup_error=safe(e);}
 if(report.ledger&&shared.customerId)try{
   const rows=await read('/api/v1/customers/'+shared.customerId+'/points?limit=200');
   report.cleanup_ledger_unchanged=JSON.stringify(rows.map(({id,entry_type,points,balance_after,order_id,rule_version})=>({id,entry_type,points,balance_after,order_id,rule_version})))===JSON.stringify(report.ledger);
   clean=clean&&report.cleanup_ledger_unchanged;
 }catch{clean=false;}
 try{after=await sha();}catch{}
 report.build_stable=!!before&&before===after;report.build_after=after||null;
 report.business_execution=executed?'EXECUTED':'NOT_EXECUTED';
 report.cleanup_pass=clean;
 report.result=report.checks&&!passed?'FAILED':passed&&clean&&report.build_stable?'PASSED':
   /^PENDING_/.test(error||'')?'PENDING':error&&!/^INCONCLUSIVE:/.test(error)?'FAILED':'INCONCLUSIVE';
 if(error)report.error=error;
 if(!clean)report.cleanup_required='Inspect the owned IDs in cleanup; do not reset staging.';
 mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}

