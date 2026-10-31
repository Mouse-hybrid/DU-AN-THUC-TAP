import test from 'node:test';
import assert from 'node:assert/strict';
import { runAuditSuite, timestampNs } from '../p2_audit_readonly.mjs';

const orderId='5e34b15d-291a-4e02-a715-6be0edacf883';
const itemId='fd02ebfc-8d38-4bb7-be45-217d65046940';
const sha='be90389e58fb009ba949d3984d2a5941ad974948';
const config={orderId,expectedCommit:sha,password:'LOCAL_TEST_SECRET',supervisorUser:'admin',
  cashierUser:'cashier',waiterUser:'waiter',kitchenUser:'kitchen',otherOutletSupervisorUser:'qa2_admin'};
const parameters=['order_id','action','created_from','created_to','limit','offset'].map(name=>({name,in:'query'}));
function fixture({ties=true,missing=false,ignoreAction=false,leak=false,drift=false,badPage=false}={}){
 const users={admin:['SUPERVISOR','A'],cashier:['CASHIER','A'],waiter:['WAITER','A'],kitchen:['KITCHEN','A'],qa2_admin:['SUPERVISOR','B']};
 const rows=Array.from({length:7},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
   entity_id:i%2?itemId:orderId,entity_type:i%2?'order_item':'order',
   action:i%2?'ORDER_ITEM_SERVED':'ORDER_CREATED',staff_id:'staff',staff_role:i%2?'WAITER':'SUPERVISOR',
   created_at:`2026-10-30T00:57:04.${String(ties&&i===3?2:i).padStart(6,'0')}Z`,payload:{token:'DO_NOT_RECORD'}}));
 let versions=0;
 const calls=[];
 const client=async(method,path,token,body)=>{
  calls.push({method,path});
  const u=new URL(path,'http://localhost');
  if(u.pathname==='/version')return {status:200,data:{commit:drift&&versions++>0?'a'.repeat(40):sha,environment:'staging'}};
  if(u.pathname==='/health')return {status:200,data:{status:'ok'}};
  if(u.pathname==='/openapi.json')return {status:200,data:{paths:{'/api/v1/audit-logs':{get:{parameters}},'/api/v1/auth/login':{post:{}}}}};
  if(u.pathname==='/api/v1/auth/login'){
   const [role,outlet_id]=users[body.username]??[];
   return {status:role?200:401,data:role?{access_token:body.username,staff:{role,outlet_id,username:body.username}}:{detail:'invalid'}};
  }
  if(u.pathname.startsWith('/api/v1/orders/'))return missing?{status:404,data:{detail:'not found'}}:{status:200,data:{id:orderId,status:'CLOSED',items:[{id:itemId}]}};
  if(u.pathname==='/api/v1/audit-logs'){
   if(!token)return {status:401,data:{detail:'unauthorized'}};
   if(token!=='admin'&&token!=='qa2_admin')return {status:403,data:leak?{order_id:orderId,items:rows}:{detail:'forbidden'}};
   if(token==='qa2_admin')return {status:404,data:{detail:'not found'}};
   const p=u.searchParams,limit=Number(p.get('limit')??100),offset=Number(p.get('offset')??0);
   if(limit<1||limit>500||offset<0)return {status:422,data:{detail:'invalid'}};
   let found=rows.filter(r=>(ignoreAction||!p.has('action')||p.getAll('action').includes(r.action))&&
    (!p.has('created_from')||timestampNs(r.created_at)>=timestampNs(p.get('created_from')))&&
    (!p.has('created_to')||timestampNs(r.created_at)<timestampNs(p.get('created_to'))));
   found=found.slice(badPage&&offset>0?0:offset,(badPage&&offset>0?0:offset)+limit);
   return {status:200,data:found};
  }
  throw new Error('Unexpected request');
 };
 return {client,calls};
}
test('microsecond timestamps remain distinct and timezone offsets normalize',()=>{
 assert.equal(timestampNs('2026-10-30T00:57:04.000001Z')+1n,timestampNs('2026-10-30T00:57:04.000001001Z'));
 assert.equal(timestampNs('2026-10-30T00:57:04.000001Z'),timestampNs('2026-10-30T07:57:04.000001+07:00'));
});
test('complete fixture passes filters, pagination with ties, and role guards',async()=>{
 const f=fixture();const r=await runAuditSuite(config,f.client);
 assert.deepEqual(r.cases.map(x=>x.result),['PASSED','PASSED','PASSED']);
 assert.ok(f.calls.every(c=>c.method==='GET'||c.path==='/api/v1/auth/login'));
 assert.ok(!JSON.stringify(r).includes('LOCAL_TEST_SECRET'));
 assert.ok(!JSON.stringify(r).includes('DO_NOT_RECORD'));
});
test('missing same-timestamp fixture does not pass full P2-AUD-002',async()=>{
 const r=await runAuditSuite(config,fixture({ties:false}).client);
 assert.equal(r.cases[1].result,'PENDING');assert.equal(r.cases[1].component_result,'PASSED');
});
test('ignored action filter fails P2-AUD-001',async()=>{
 const r=await runAuditSuite(config,fixture({ignoreAction:true}).client);assert.equal(r.cases[0].result,'FAILED');
});
test('pagination returning the first page repeatedly fails P2-AUD-002',async()=>{
 const r=await runAuditSuite(config,fixture({badPage:true}).client);assert.equal(r.cases[1].result,'FAILED');
});
test('403 with leaked order data fails P2-AUD-003',async()=>{
 const r=await runAuditSuite(config,fixture({leak:true}).client);assert.equal(r.cases[2].result,'FAILED');
});
test('403 with a plain-text leaked order ID also fails without saving the raw body',async()=>{
 const f=fixture();
 const client=async(...args)=>{
  const r=await f.client(...args);
  return r.status===403?{...r,text:`QA_LEAK_SENTINEL ${orderId}`} : r;
 };
 const r=await runAuditSuite(config,client);
 assert.equal(r.cases[2].result,'FAILED');
 assert.ok(!JSON.stringify(r).includes('QA_LEAK_SENTINEL'));
});
test('reset/deleted order blocks the run and never creates a replacement fixture',async()=>{
 const f=fixture({missing:true});const r=await runAuditSuite(config,f.client);
 assert.ok(r.cases.every(c=>c.result==='BLOCKED'));
 assert.ok(f.calls.every(c=>c.method==='GET'||c.path==='/api/v1/auth/login'));
});
test('deploy during execution invalidates observed passes',async()=>{
 const r=await runAuditSuite(config,fixture({drift:true}).client);
 assert.ok(r.cases.every(c=>c.result==='PENDING'));
 assert.ok(r.cases.every(c=>c.observed_result==='PASSED'));
});
