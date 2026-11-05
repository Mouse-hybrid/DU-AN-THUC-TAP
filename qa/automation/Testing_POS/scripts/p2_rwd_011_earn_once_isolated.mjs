// P2-RWD-011: QA3 simulated payment earns points once under replay.
import {randomUUID,randomInt} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const password=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT,output=process.argv[2];
if(base!=='http://160.191.47.17')throw new Error('Approved staging origin only');
if(!output){console.error('Usage: node scripts/p2_rwd_011_earn_once_isolated.mjs OUTPUT.json');process.exit(2);}
if(!password){console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent');process.exit(2);}
const tokens={};let own={tableId:null,tableCode:null,sessionId:null,orderId:null,itemId:null,
  rewardId:null,rewardName:null,orderRewardId:null,customerId:null,phone:null,customerName:null};
const report={run_id:'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-P2RWD011',test_ref:'P2-RWD-011',checked_at:new Date().toISOString(),
 result:'INCONCLUSIVE',scope:'QA3 customer earns points once after simulated payment; same-key replay and new-key denial, ledger/audit and owned cleanup.',
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

let executed=false,passed=false,clean=true,expectedEarn=0;
report.cleanup_errors=[];
function check(ok,label){if(!ok)throw new Error(label);}
function cents(value){const n=Number(value)*100;check(Number.isFinite(n)&&Math.abs(n-Math.round(n))<0.00001,'Invalid monetary value');return Math.round(n);}
const read=async(path,role='admin')=>must(await call('GET',path,role),200,'GET '+path);
try{
 before=await sha();report.staging_commit=before;
 check(/^[a-f0-9]{40}$/.test(before||''),'Invalid staging SHA');
 check(expected&&before.startsWith(expected),'PENDING_BUILD: pin POS_EXPECTED_COMMIT to current SHA');
 const spec=must(await call('GET','/openapi.json'),200,'OpenAPI');
 for(const path of ['/api/v1/customers/{customer_id}/points','/api/v1/orders/{order_id}/pay'])
   check(spec.paths?.[path],'PENDING_CONTRACT: missing '+path);
 for(const [key,name,role] of [['admin','qa3_admin','SUPERVISOR'],['cashier','qa3_cashier','CASHIER'],
  ['waiter','qa3_waiter','WAITER'],['kitchen','qa3_kitchen','KITCHEN']]){
  const login=must(await post('/api/v1/auth/login',null,{username:name,password}),200,'QA3 login');
  tokens[key]=login.access_token;
  const me=await read('/api/v1/auth/me',key);
  check(me.username===name&&me.role===role&&me.outlet_id,'QA3 role mismatch');
  report[key+'_outlet_id']=me.outlet_id;
 }
 check(new Set(['admin','cashier','waiter','kitchen'].map(k=>report[k+'_outlet_id'])).size===1,'QA3 outlet mismatch');
 const tables=await read('/api/v1/tables','waiter');
 const candidates=tables.filter(t=>/^Q3-[12]$/.test(t.code)&&t.status==='AVAILABLE');
 check(candidates.length>0,'PENDING_FIXTURE: no AVAILABLE Q3-1/2');
 const rule=(await read('/api/v1/loyalty-rules'))[0];
 check(rule&&cents(rule.earn_amount_per_point)>0,'PENDING_FIXTURE: no positive earn rule');
 const menu=await read('/api/v1/menu?available_only=true','cashier');
 const item=menu.find(x=>x.is_available&&x.station_id&&!x.has_modifiers&&cents(x.price)>=cents(rule.earn_amount_per_point));
 check(item,'PENDING_FIXTURE: no mapped item earning at least one point');
 expectedEarn=Math.floor(cents(item.price)/cents(rule.earn_amount_per_point));
 report.rule={id:rule.id,version:rule.version,earn_amount_per_point:rule.earn_amount_per_point};
 report.expected_earn=expectedEarn;
 own.phone='09'+String(randomInt(0,100000000)).padStart(8,'0');
 check((await read('/api/v1/customers?phone='+own.phone,'cashier')).length===0,'PENDING_FIXTURE: generated phone already exists');
 own.customerName='QA P2RWD011 '+randomUUID().slice(0,8);
 const customer=await post('/api/v1/customers','cashier',{phone:own.phone,full_name:own.customerName,consent:true});
 own.customerId=customer.data?.id;must(customer,201,'create owned customer');
 check(own.customerId,'CLEANUP REQUIRED: customer id missing');
 const initial=await read('/api/v1/customers/'+own.customerId,'cashier');
 check(initial.points_balance===0,'Owned customer must start at zero points');
 for(const candidate of candidates){
  const response=await post('/api/v1/tables/'+candidate.id+'/open-session','waiter',{guest_count:1});
  if(response.http===409)continue;
  own.tableId=candidate.id;own.tableCode=candidate.code;own.openAttempted=true;
  own.sessionId=response.data?.id;must(response,201,'open QA3 table');break;
 }
 check(own.sessionId,'PENDING_FIXTURE: all candidate QA3 tables occupied');
 const created=await post('/api/v1/orders','cashier',{table_session_id:own.sessionId});
 own.orderId=created.data?.id;must(created,201,'create order');
 check(own.orderId,'CLEANUP REQUIRED: order id missing');
 const added=must(await post('/api/v1/orders/'+own.orderId+'/items','waiter',
  {items:[{menu_item_id:item.id,quantity:1,note:'QA P2RWD011 owned item'}]}),201,'add item');
 own.itemId=added.items?.find(x=>x.menu_item_id===item.id)?.id;
 check(own.itemId,'CLEANUP REQUIRED: item id missing');
 must(await post('/api/v1/orders/'+own.orderId+'/customer','cashier',{customer_id:own.customerId}),200,'attach own customer');
 await serveOwned();
 must(await post('/api/v1/orders/'+own.orderId+'/request-billing','waiter'),200,'billing');
 check((await read('/api/v1/customers/'+own.customerId,'cashier')).points_balance===0,'Points earned before payment');
 check(await sha()===before,'PENDING_BUILD: SHA changed before payment');
 executed=true;
 const payKey=randomUUID();
 const first=await post('/api/v1/orders/'+own.orderId+'/pay','cashier',undefined,payKey);
 must(first,200,'first simulated payment');
 const replay=await post('/api/v1/orders/'+own.orderId+'/pay','cashier',undefined,payKey);
 must(replay,200,'same-key payment replay');
 const another=await post('/api/v1/orders/'+own.orderId+'/pay','cashier',undefined,randomUUID());
 must(another,409,'different-key payment after PAID');
 const current=await read('/api/v1/customers/'+own.customerId,'cashier');
 const ledger=await read('/api/v1/customers/'+own.customerId+'/points?limit=200','cashier');
 const audit=await read('/api/v1/audit-logs?order_id='+own.orderId+'&limit=500');
 const paid=await order();
 report.checks={
  payment_http:first.http===200&&replay.http===200&&another.http===409,
  replay_response_unchanged:JSON.stringify(first.data)===JSON.stringify(replay.data),
  order_paid:paid.status==='PAID',
  earn_once:ledger.filter(x=>x.entry_type==='EARN').length===1&&ledger.length===1&&ledger[0].points===expectedEarn&&ledger[0].order_id===own.orderId,
  balance_correct:current.points_balance===expectedEarn&&ledger[0]?.balance_after===expectedEarn,
  rule_version:ledger[0]?.rule_version===rule.version,
  audit_payment_once:audit.filter(x=>x.action==='ORDER_PAID').length===1,
 };
 report.http={first:first.http,same_key_replay:replay.http,new_key_after_paid:another.http};
 report.balance_after=current.points_balance;
 report.ledger=ledger.map(({id,entry_type,points,balance_after,order_id,rule_version})=>({id,entry_type,points,balance_after,order_id,rule_version}));
 passed=Object.values(report.checks).every(Boolean);report.assertions_passed=passed;
}catch(e){error=safe(e);}
finally{
 if(own.sessionId)try{report.cleanup_state_pass=await finishOrder();clean=clean&&report.cleanup_state_pass;}
 catch(e){clean=false;report.cleanup_errors.push(safe(e));}
 if(!own.customerId&&own.phone&&own.customerName)try{
  const rows=await read('/api/v1/customers?phone='+own.phone,'cashier');
  if(rows.length===1&&rows[0].full_name===own.customerName)own.customerId=rows[0].id;
  else {clean=false;report.cleanup_errors.push('Customer response uncertain; manual ownership check required');}
 }catch(e){clean=false;report.cleanup_errors.push(safe(e));}
 if(own.customerId)try{
  must(await call('PATCH','/api/v1/customers/'+own.customerId,'admin',{is_active:false}),200,'deactivate own customer');
  report.customer_inactive=(await read('/api/v1/customers/'+own.customerId,'admin')).is_active===false;
  clean=clean&&report.customer_inactive;
 }catch(e){clean=false;report.cleanup_errors.push(safe(e));}
 if(report.ledger&&own.customerId)try{
  const rows=await read('/api/v1/customers/'+own.customerId+'/points?limit=200','cashier');
  report.cleanup_ledger_unchanged=JSON.stringify(rows.map(({id,entry_type,points,balance_after,order_id,rule_version})=>({id,entry_type,points,balance_after,order_id,rule_version})))===JSON.stringify(report.ledger);
  clean=clean&&report.cleanup_ledger_unchanged;
 }catch(e){clean=false;report.cleanup_errors.push(safe(e));}
 try{after=await sha();}catch{}
 report.build_stable=!!before&&before===after;report.build_after=after||null;
 report.business_execution=executed?'EXECUTED':'NOT_EXECUTED';
 report.cleanup_pass=clean;
 report.order_id=own.orderId||null;report.table_code=own.tableCode||null;
 report.result=report.checks&&!passed?'FAILED':passed&&clean&&report.build_stable?'PASSED':
  /^PENDING_/.test(error||'')?'PENDING':error?'FAILED':'INCONCLUSIVE';
 if(error)report.error=error;
 if(!clean)report.cleanup_required='Inspect owned IDs; do not reset staging.';
 mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}

