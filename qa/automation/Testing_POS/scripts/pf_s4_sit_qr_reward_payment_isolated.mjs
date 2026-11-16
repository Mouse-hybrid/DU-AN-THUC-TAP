// Sprint 4 SIT: one QA3 session through POS + public QR + KDS + reward + Payment v2.
// This is a cross-module rehearsal, not a new Passed result for individual 71-case IDs.
import {randomInt, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base=(process.env.POS_STAGING_URL||'http://160.191.47.17').replace(/\/+$/,'');
const seed=process.env.P2_QA_SEED_PASSWORD,expected=process.env.POS_EXPECTED_COMMIT,output=process.argv[2];
if(base!=='http://160.191.47.17')throw Error('Approved staging origin only');
if(!output||!seed||!/^[a-f0-9]{40}$/.test(expected||'')){
  console.error('Usage: set P2_QA_SEED_PASSWORD and full POS_EXPECTED_COMMIT privately; node scripts/pf_s4_sit_qr_reward_payment_isolated.mjs OUTPUT.json');
  process.exit(2);
}
const tokens={};
const own={tableId:null,tableCode:null,sessionId:null,orderId:null,posItemId:null,qrItemId:null,
  menuId:null,qrToken:null,qrIssued:false,openAttempted:false,
  customerId:null,customerName:null,phone:null,rewardId:null,rewardName:null,orderRewardId:null};
const report={run_id:'RUN-'+new Date().toISOString().replace(/\D/g,'')+'-S4SIT',
  test_ref:'PF-S4-SIT-QR-REWARD-PAYMENT',checked_at:new Date().toISOString(),result:'INCONCLUSIVE',
  scope:'One isolated QA3 API flow: POS item + public QR item share session/bill, KDS serve, FIXED reward, Payment v2 CASH, audit and owned cleanup; no customer UI or gateway',
  secrets_recorded:false,phone_recorded:false,token_recorded:false,checks:{},cleanup_errors:[]};
function safe(error){let value=String(error?.message||error);
  for(const secret of [seed,own.phone,own.qrToken,...Object.values(tokens)])
    if(secret)value=value.replaceAll(secret,'<REDACTED>');
  return value.replace(/\/api\/v1\/public\/qr\/[^\s/'"]+/g,'/api/v1/public/qr/<REDACTED>');
}
async function call(method,path,role,body){
  const headers={Accept:'application/json'};
  if(role)headers.Authorization=`Bearer ${tokens[role]}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET')headers['Idempotency-Key']=randomUUID();
  const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(30000)});
  return {http:response.status,data:await response.json().catch(()=>null)};
}
function must(response,status,label){
  if(response.http!==status)throw Error(`${label} HTTP ${response.http}, expected ${status}`);
  return response.data;
}
const get=(path,role)=>call('GET',path,role);
const post=(path,role,body)=>call('POST',path,role,body);
const patch=(path,role,body)=>call('PATCH',path,role,body);
const version=async()=>must(await get('/version'),200,'version').commit;
const read=async(path,role='admin')=>must(await get(path,role),200,'GET '+path);
const order=()=>read(`/api/v1/orders/${own.orderId}`,'cashier');
const table=()=>read(`/api/v1/tables/${own.tableId}`,'waiter');
const cents=value=>Math.round(Number(value)*100);
function check(ok,label){if(!ok)throw Error(label);}
async function tickets(status){
  const rows=await read(`/api/v1/kitchen/queue${status?'?status='+status:''}`,'kitchen');
  check(Array.isArray(rows),'PENDING_CONTRACT: kitchen queue must be array');
  return rows.filter(row=>row.order_id===own.orderId);
}
async function serveItems(){
  let current=await order();
  check(current.table_session_id===own.sessionId,'CLEANUP REQUIRED: order/session ownership mismatch');
  if(current.items.some(item=>item.status==='CREATED'))
    must(await post(`/api/v1/orders/${own.orderId}/send-to-kitchen`,'waiter'),200,'send to kitchen');
  for(const item of (await order()).items){
    for(const [status,action,role] of [['SENT','start-cooking','kitchen'],
      ['PREPARING','mark-ready','kitchen'],['READY','pickup','waiter'],
      ['PICKED_UP','served','waiter']]){
      if((await order()).items.find(row=>row.id===item.id)?.status===status)
        must(await post(`/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,role),200,action);
    }
  }
  check((await order()).items.every(item=>item.status==='SERVED'),'CLEANUP REQUIRED: unserved own item');
}
async function cleanupOrder(){
  if(!own.sessionId){
    if(own.openAttempted)throw Error('CLEANUP REQUIRED: own table open response uncertain');
    return true;
  }
  if(!own.orderId){
    const current=await table();
    check(current.current_session?.id===own.sessionId,'CLEANUP REQUIRED: own session changed');
    const rows=(current.orders||[]).filter(row=>row.table_session_id===own.sessionId);
    if(rows.length===1)own.orderId=rows[0].id;
    else if(!rows.length)own.orderId=must(await post('/api/v1/orders','waiter',
      {table_session_id:own.sessionId}),201,'cleanup create order').id;
    else throw Error('CLEANUP REQUIRED: ambiguous own orders');
  }
  let current=await order();
  check(current.table_session_id===own.sessionId,'CLEANUP REQUIRED: order/session mismatch');
  if(current.status!=='CLOSED'){
    if(current.applied_reward&&!['PAID','CLOSED'].includes(current.status)){
      must(await call('DELETE',`/api/v1/orders/${own.orderId}/rewards/${current.applied_reward.id}`,
        'cashier'),200,'cleanup remove reward');
    }
    current=await order();
    if(!current.items?.length){
      must(await post(`/api/v1/orders/${own.orderId}/items`,'waiter',
        {items:[{menu_item_id:own.menuId,quantity:1,note:'QA S4SIT cleanup'}]}),201,'cleanup add');
    }
    await serveItems();
    current=await order();
    if(!['PAID','CLOSED'].includes(current.status)&&current.customer_id)
      must(await post(`/api/v1/orders/${own.orderId}/customer`,'cashier',
        {customer_id:null}),200,'cleanup detach customer');
    if(!['BILLING','PAID','CLOSED'].includes((await order()).status))
      must(await post(`/api/v1/orders/${own.orderId}/request-billing`,'waiter'),200,'cleanup billing');
    if(!['PAID','CLOSED'].includes((await order()).status))
      must(await post(`/api/v1/orders/${own.orderId}/pay`,'cashier'),200,'cleanup simulated payment');
    if((await order()).status!=='CLOSED')
      must(await post(`/api/v1/orders/${own.orderId}/close`,'cashier'),200,'cleanup close');
  }
  if((await table()).status==='CLEANING')
    must(await post(`/api/v1/tables/${own.tableId}/mark-clean`,'waiter'),200,'cleanup clean table');
  const end=await table(),final=await order(),done=await tickets('DONE'),active=await tickets();
  report.cleanup_state={order_closed:final.status==='CLOSED',table_available:end.status==='AVAILABLE',
    no_open_session:!end.current_session,items_served:final.items.every(item=>item.status==='SERVED'),
    tickets_done:done.length===final.items.length,no_active_ticket:active.length===0};
  return Object.values(report.cleanup_state).every(Boolean);
}
let before,after,executed=false,asserted=false,clean=true;
try{
  before=await version();report.staging_commit=before;
  check(before===expected,'PENDING_BUILD: staging SHA changed');
  const spec=await read('/openapi.json');
  for(const [path,method] of [['/api/v1/public/qr/{token}/orders','post'],
    ['/api/v1/orders/{order_id}/rewards','post'],
    ['/api/v1/orders/{order_id}/payments','post'],['/api/v1/rewards','post']])
    check(!!spec.paths?.[path]?.[method],`PENDING_CONTRACT: ${method} ${path} absent`);
  for(const [role,username,expectedRole] of [['admin','qa3_admin','SUPERVISOR'],
    ['cashier','qa3_cashier','CASHIER'],['waiter','qa3_waiter','WAITER'],
    ['kitchen','qa3_kitchen','KITCHEN']]){
    const login=must(await post('/api/v1/auth/login',null,{username,password:seed}),200,'QA3 login');
    tokens[role]=login.access_token;
    const me=await read('/api/v1/auth/me',role);
    check(tokens[role]&&me.username===username&&me.role===expectedRole&&me.outlet_id,
      'PENDING_AUTH: QA3 role mismatch');
    report[role+'_outlet_id']=me.outlet_id;
  }
  check(new Set(['admin','cashier','waiter','kitchen'].map(role=>report[role+'_outlet_id'])).size===1,
    'PENDING_FIXTURE: QA3 outlet mismatch');
  const menu=await read('/api/v1/menu?available_only=true','cashier');
  const mapped=menu.filter(item=>item.is_available&&item.station_id&&!item.has_modifiers&&cents(item.price)>100);
  check(mapped.length>=2,'PENDING_FIXTURE: two mapped items required');
  own.menuId=mapped[0].id;
  const candidates=(await read('/api/v1/tables','waiter'))
    .filter(row=>/^Q3-[12]$/.test(row.code)&&row.status==='AVAILABLE');
  check(candidates.length>0,'PENDING_FIXTURE: QA3 table unavailable');
  own.phone='09'+String(randomInt(0,100000000)).padStart(8,'0');
  check((await read('/api/v1/customers?phone='+own.phone,'cashier')).length===0,
    'PENDING_FIXTURE: generated customer phone exists');
  own.customerName='QA S4SIT '+randomUUID().slice(0,8);
  const createdCustomer=await post('/api/v1/customers','cashier',
    {phone:own.phone,full_name:own.customerName,consent:true});
  own.customerId=createdCustomer.data?.id;
  must(createdCustomer,201,'create own customer');
  check(own.customerId,'CLEANUP REQUIRED: customer id absent');
  own.rewardName='QA S4SIT '+randomUUID().slice(0,8);
  const createdReward=await post('/api/v1/rewards','admin',
    {name:own.rewardName,reward_type:'FIXED',value:'1.00',min_order_amount:'0'});
  own.rewardId=createdReward.data?.id;
  must(createdReward,201,'create own reward');
  check(own.rewardId,'CLEANUP REQUIRED: reward id absent');
  for(const candidate of candidates){
    own.tableId=candidate.id;own.tableCode=candidate.code;own.openAttempted=true;
    const opened=await post(`/api/v1/tables/${candidate.id}/open-session`,'waiter',{guest_count:1});
    if(opened.http===409){own.openAttempted=false;continue;}
    own.sessionId=opened.data?.id;
    must(opened,201,'open own session');break;
  }
  check(own.sessionId,'PENDING_FIXTURE: no QA3 session opened');
  const createdOrder=await post('/api/v1/orders','cashier',{table_session_id:own.sessionId});
  own.orderId=createdOrder.data?.id;
  must(createdOrder,201,'create own order');
  check(own.orderId,'CLEANUP REQUIRED: order id absent');
  const added=must(await post(`/api/v1/orders/${own.orderId}/items`,'cashier',
    {items:[{menu_item_id:mapped[0].id,quantity:1,note:'QA S4SIT POS'}]}),201,'POS item');
  own.posItemId=added.items?.find(item=>item.menu_item_id===mapped[0].id)?.id;
  check(own.posItemId,'CLEANUP REQUIRED: POS item absent');
  const issued=await post(`/api/v1/tables/${own.tableId}/qr-session`,'waiter');
  own.qrToken=issued.data?.token;own.qrIssued=issued.http===201;
  must(issued,201,'issue own QR');
  check(own.qrToken&&issued.data?.table_session_id===own.sessionId,
    'CLEANUP REQUIRED: QR token/session mismatch');
  const publicMenu=must(await get(`/api/v1/public/qr/${own.qrToken}/menu`),200,'public QR menu');
  check(publicMenu.items?.some(item=>item.id===mapped[1].id&&item.is_available),
    'PENDING_FIXTURE: second mapped item absent from public menu');
  executed=true;
  const qr=must(await post(`/api/v1/public/qr/${own.qrToken}/orders`,null,
    {items:[{menu_item_id:mapped[1].id,quantity:1,note:'QA S4SIT QR'}]}),201,'submit QR item');
  const withQr=await order();
  own.qrItemId=withQr.items.find(item=>item.source==='QR'&&item.menu_item_id===mapped[1].id)?.id;
  const shared=withQr.table_session_id===own.sessionId&&withQr.items.length===2&&!!own.qrItemId&&
    cents(withQr.subtotal)===cents(mapped[0].price)+cents(mapped[1].price)&&!!qr;
  const revoked=await call('DELETE',`/api/v1/tables/${own.tableId}/qr-session`,'waiter');
  must(revoked,204,'revoke own QR');
  own.qrIssued=false;
  report.qr_revoke_http=revoked.http;
  const publicAfterRevoke=await get(`/api/v1/public/qr/${own.qrToken}/order`);
  check(publicAfterRevoke.http===401,'QR token remains usable after revoke');
  must(await post(`/api/v1/orders/${own.orderId}/customer`,'cashier',
    {customer_id:own.customerId}),200,'attach own customer');
  const applied=must(await post(`/api/v1/orders/${own.orderId}/rewards`,'cashier',
    {reward_id:own.rewardId}),201,'apply own reward');
  own.orderRewardId=applied.applied_reward?.id;
  const rewardOrder=await order();
  const rewardCorrect=!!own.orderRewardId&&rewardOrder.applied_reward?.reward_id===own.rewardId&&
    cents(rewardOrder.applied_reward?.discount_amount)===100&&
    cents(rewardOrder.total)===cents(withQr.total)-100;
  await serveItems();
  const done=await tickets('DONE');
  must(await post(`/api/v1/orders/${own.orderId}/request-billing`,'waiter'),200,'request billing');
  const bill=await order(),due=(cents(bill.amount_due)/100).toFixed(2);
  check(bill.status==='BILLING'&&Number(due)>0,'PENDING_FIXTURE: discounted bill not BILLING');
  const paid=must(await post(`/api/v1/orders/${own.orderId}/payments`,'cashier',
    {method:'CASH',amount:due,cash_received:due}),201,'Payment v2 CASH');
  const ledger=await read(`/api/v1/orders/${own.orderId}/payments`,'cashier');
  const afterOrder=await order(),afterTable=await table();
  const audit=await read(`/api/v1/audit-logs?order_id=${own.orderId}&limit=200`,'admin');
  const qrAdd=audit.filter(row=>row.action==='ORDER_ITEMS_ADDED'&&row.payload?.source==='QR');
  const rewardApplied=audit.filter(row=>row.action==='ORDER_REWARD_APPLIED'&&row.entity_id===own.orderId);
  const paymentRecorded=audit.filter(row=>row.action==='PAYMENT_RECORDED'&&
    row.payload?.payment_id===paid.payment?.id);
  report.checks={qr_pos_shared_session_bill:shared&&publicAfterRevoke.http===401,
    kitchen_two_served_done:afterOrder.items.length===2&&
      afterOrder.items.every(item=>item.status==='SERVED')&&done.length===2&&
      [own.posItemId,own.qrItemId].every(id=>done.some(row=>row.order_item_id===id)),
    fixed_reward_on_bill:rewardCorrect&&cents(bill.total)===cents(withQr.total)-100,
    payment_exact_once:paid.order_status==='PAID'&&afterOrder.status==='PAID'&&
      ledger.payments?.length===1&&ledger.payments[0].id===paid.payment?.id&&
      cents(ledger.summary?.paid)===cents(due)&&cents(ledger.summary?.remaining)===0,
    table_released_to_cleaning:afterTable.status==='CLEANING'&&!afterTable.current_session,
    audit_once_each:qrAdd.length===1&&rewardApplied.length===1&&paymentRecorded.length===1};
  report.table_code=own.tableCode;report.order_id=own.orderId;
  report.customer_id=own.customerId;report.reward_id=own.rewardId;
  report.payment_id=paid.payment?.id??null;
  report.amounts={subtotal:withQr.subtotal,discount:'1.00',paid:due};
  asserted=Object.values(report.checks).every(Boolean);
  if(!asserted)throw Error('SIT cross-module bill, KDS, reward, payment or audit mismatch');
}catch(error){report.error=safe(error);}
finally{
  if(own.qrIssued&&own.tableId&&tokens.waiter)try{
    const revoked=await call('DELETE',`/api/v1/tables/${own.tableId}/qr-session`,'waiter');
    report.qr_revoke_http=revoked.http;
    if(![204,404].includes(revoked.http))throw Error(`QR revoke HTTP ${revoked.http}`);
  }catch(error){clean=false;report.cleanup_errors.push(safe(error));}
  if(!own.customerId&&own.phone&&own.customerName&&tokens.cashier)try{
    const rows=await read('/api/v1/customers?phone='+own.phone,'cashier');
    const matches=rows.filter(row=>row.full_name===own.customerName);
    if(matches.length===1)own.customerId=matches[0].id;
    else throw Error('Customer response uncertain');
  }catch(error){clean=false;report.cleanup_errors.push(safe(error));}
  if(!own.rewardId&&own.rewardName&&tokens.admin)try{
    const matches=(await read('/api/v1/rewards','admin')).filter(row=>row.name===own.rewardName);
    if(matches.length===1)own.rewardId=matches[0].id;
    else throw Error('Reward response uncertain');
  }catch(error){clean=false;report.cleanup_errors.push(safe(error));}
  try{clean=(await cleanupOrder())&&clean;}
  catch(error){clean=false;report.cleanup_errors.push(safe(error));}
  if(own.rewardId&&tokens.admin)try{
    const disabled=must(await patch(`/api/v1/rewards/${own.rewardId}`,'admin',
      {is_active:false}),200,'disable own reward');
    report.reward_inactive=disabled.is_active===false;clean=clean&&report.reward_inactive;
  }catch(error){clean=false;report.cleanup_errors.push(safe(error));}
  if(own.customerId&&tokens.admin)try{
    must(await patch(`/api/v1/customers/${own.customerId}`,'admin',
      {is_active:false}),200,'deactivate own customer');
    report.customer_inactive=(await read(`/api/v1/customers/${own.customerId}`,'admin')).is_active===false;
    clean=clean&&report.customer_inactive;
  }catch(error){clean=false;report.cleanup_errors.push(safe(error));}
  try{after=await version();}catch{}
  report.build_after=after||null;report.build_stable=!!before&&before===after;
  report.business_execution=executed?'EXECUTED':'NOT_EXECUTED';
  report.cleanup_pass=clean;report.order_closed=report.cleanup_state?.order_closed===true;
  report.table_available=report.cleanup_state?.table_available===true;
  report.result=!clean?'INCONCLUSIVE':!report.build_stable?'PENDING':
    /^PENDING_/.test(report.error||'')?'PENDING':
    asserted&&report.build_stable?'PASSED':executed?'FAILED':'INCONCLUSIVE';
  if(!clean)report.cleanup_required={table_code:own.tableCode,session_id:own.sessionId,
    order_id:own.orderId,customer_id:own.customerId,reward_id:own.rewardId,no_global_reset:true};
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
