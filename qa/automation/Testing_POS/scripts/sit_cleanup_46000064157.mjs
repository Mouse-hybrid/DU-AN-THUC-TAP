import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
const base='http://160.191.47.17', build='d6ee04a173c74530653c5df394dd439c92369eaf';
const own={"id":"939dc4b7-1d71-40b9-b611-ac81c4331529","status":"PAID","session":"5e31cb9f-53d9-4a21-9eca-b352b840a35c","customer":"3a90422f-f572-4326-af16-d28ebd26e0db","reward":"36bc7bd7-3ca2-4533-8b8f-8f9a98407dca","marker":"SIT kitchen 470c7a49"};
const tokens={};
function check(ok,msg){if(!ok) throw Error(msg);}
async function api(method,path,role,data,status=200){
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(tokens[role]?{Authorization:'Bearer '+tokens[role]}:{}),...(method==='GET'?{}:{'Idempotency-Key':randomUUID()})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(20000)});
 check(r.status===status,method+' '+path+' HTTP '+r.status);
 return r.status===204?null:r.json();
}
for(const role of ['admin','cashier','waiter']){
 const auth=await api('POST','/api/v1/auth/login',role,{username:'qa3_'+role,password:process.env.S2_STAGING_PIN});
 tokens[role]=auth.access_token;
}
check((await api('GET','/version','cashier')).commit===build,'Build mismatch');
let order=await api('GET','/api/v1/orders/'+own.id,'cashier');
check(order.table_session_id===own.session && order.customer_id===own.customer && order.items.some(i=>i.note===own.marker),'Owned paid fixture mismatch');
check(['PAID','CLOSED'].includes(order.status),'Recovery only accepts settled fixture');
const customer=await api('GET','/api/v1/customers/'+own.customer,'admin');
const marker=own.marker.replace('SIT kitchen ','');
check(customer.full_name==='SIT QA '+marker,'Owned customer mismatch');
const payments=await api('GET','/api/v1/orders/'+own.id+'/payments','cashier');
check(payments.payments.filter(p=>p.status==='SUCCEEDED' && Number(p.amount)===90000 && ['CASH','VNPAY'].includes(p.method)).length===2 && Number(payments.summary.remaining)===0,'Original split tender must remain settled');
if(order.status==='PAID') await api('POST','/api/v1/orders/'+own.id+'/close','cashier');
for(const code of ['Q3-2','Q3-3']){
 const list=await api('GET','/api/v1/tables','waiter');
 const t=list.find(t=>t.code===code);check(t,'Owned table missing');
 const detail=await api('GET','/api/v1/tables/'+t.id,'waiter');
 check(!detail.current_session && ['CLEANING','AVAILABLE'].includes(detail.status),'Table reused by another session');
 if(detail.status==='CLEANING') await api('POST','/api/v1/tables/'+t.id+'/mark-clean','waiter');
}
await api('PATCH','/api/v1/rewards/'+own.reward,'admin',{is_active:false});
await api('PATCH','/api/v1/customers/'+own.customer,'admin',{is_active:false});
order=await api('GET','/api/v1/orders/'+own.id,'cashier');
const tables=(await api('GET','/api/v1/tables','waiter')).filter(t=>['Q3-1','Q3-2','Q3-3'].includes(t.code));
check(order.status==='CLOSED'&&tables.every(t=>t.status==='AVAILABLE'),'Cleanup not complete');
check((await api('GET','/version','cashier')).commit===build,'Build changed');
const report={test_ref:'SIT-OWNED-RECOVERY',source_run:46000064157,checked_at:new Date().toISOString(),fixture:own,order_closed:true,tables_available:true,original_signed_payment_preserved:true,cleanup_pass:true,staging_commit:build,secrets_recorded:false};
mkdirSync('evidence/sit-pos-001',{recursive:true});
writeFileSync('evidence/sit-pos-001/RECOVERY_46000064157.json',JSON.stringify(report,null,2));
console.log('Owned paid SIT recovery Passed');
