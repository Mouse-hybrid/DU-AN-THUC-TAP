import test from 'node:test';
import assert from 'node:assert/strict';
import {runAuditSuite} from './p2_audit_readonly.mjs';

const ORDER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHA='be90389e58fb009ba949d3984d2a5941ad974948';
const ID=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rows=tie=>[
  {id:ID(1),action:'ORDER_CREATED',entity_type:'order',entity_id:ORDER,staff_id:ID(11),staff_role:'WAITER',created_at:'2026-11-03T00:00:00.123456Z'},
  {id:ID(2),action:'ORDER_ITEMS_ADDED',entity_type:'order_item',entity_id:ITEM,staff_id:ID(11),staff_role:'WAITER',created_at:tie?'2026-11-03T00:00:00.123456Z':'2026-11-03T00:00:00.123457Z'},
  {id:ID(3),action:'ORDER_SENT_TO_KITCHEN',entity_type:'order',entity_id:ORDER,staff_id:ID(11),staff_role:'WAITER',created_at:'2026-11-03T00:00:01.123456Z'},
  {id:ID(4),action:'ORDER_PAID',entity_type:'order',entity_id:ORDER,staff_id:ID(12),staff_role:'CASHIER',created_at:'2026-11-03T00:00:02.123456Z'},
];
const staff={
  admin:{role:'SUPERVISOR',outlet_id:'outlet-a'},
  qa2_admin:{role:'SUPERVISOR',outlet_id:'outlet-b'},
  cashier:{role:'CASHIER',outlet_id:'outlet-a'},
  waiter:{role:'WAITER',outlet_id:'outlet-a'},
  kitchen:{role:'KITCHEN',outlet_id:'outlet-a'},
};
const parameters=['order_id','action','created_from','created_to','limit','offset'].map(name=>({name}));
function mockClient(tie){
  const source=rows(tie), calls=[];
  const request=async(method,path,token,body)=>{
    calls.push({method,path});
    if(path==='/api/v1/auth/login'){
      const user=body?.username;
      return {status:staff[user]?200:401,data:staff[user]?{access_token:`token-${user}`,staff:staff[user]}:{detail:'unauthorized'}};
    }
    if(path==='/version')return {status:200,data:{commit:SHA,environment:'staging'}};
    if(path==='/health')return {status:200,data:{status:'ok'}};
    if(path==='/openapi.json')return {status:200,data:{paths:{'/api/v1/audit-logs':{get:{parameters}}}}};
    if(path===`/api/v1/orders/${ORDER}`)return {status:200,data:{id:ORDER,status:'CLOSED',items:[{id:ITEM}]}};
    if(path.startsWith('/api/v1/audit-logs?')){
      if(!token)return {status:401,data:{detail:'unauthorized'}};
      if(token==='token-qa2_admin')return {status:404,data:{detail:'not found'}};
      if(token!=='token-admin')return {status:403,data:{detail:'forbidden'}};
      const params=new URL(path,'http://staging.invalid').searchParams;
      const limit=Number(params.get('limit')),offset=Number(params.get('offset'));
      if(limit<1||limit>500||offset<0)return {status:422,data:{detail:'invalid pagination'}};
      const actions=params.getAll('action');
      const selected=source.filter(r=>(!actions.length||actions.includes(r.action))&&
        (!params.has('created_from')||r.created_at>=params.get('created_from'))&&
        (!params.has('created_to')||r.created_at<params.get('created_to')));
      return {status:200,data:selected.slice(offset,offset+limit)};
    }
    throw Error(`Unexpected mock request: ${method} ${path}`);
  };
  return {request,calls};
}
const config={runId:'UNIT-P2-AUD-002',orderId:ORDER,password:'mock-only',expectedCommit:SHA,
 supervisorUser:'admin',otherOutletSupervisorUser:'qa2_admin',cashierUser:'cashier',waiterUser:'waiter',kitchenUser:'kitchen'};

test('equal timestamp audit rows remain ordered by id across limit=1 pages',async()=>{
  const {request,calls}=mockClient(true);
  const report=await runAuditSuite(config,request);
  const aud=report.cases.find(c=>c.tc_id==='P2-AUD-002');
  assert.deepEqual(report.counts,{passed:3,failed:0,pending:0,blocked:0});
  assert.equal(report.stability,'VERIFIED');
  assert.equal(aud.same_timestamp_fixture,true);
  assert.ok(aud.checks.some(c=>c.name==='equal timestamps across single-row page boundary'));
  assert.ok(calls.filter(c=>c.path.includes('limit=1&offset=0')).length>=2);
  assert.ok(calls.filter(c=>c.path.includes('limit=1&offset=1')).length>=2);
  assert.ok(calls.every(c=>c.method==='GET'||c.path==='/api/v1/auth/login'));
});

test('without equal timestamps the staging case remains Pending',async()=>{
  const {request}=mockClient(false);
  const report=await runAuditSuite(config,request);
  const aud=report.cases.find(c=>c.tc_id==='P2-AUD-002');
  assert.equal(aud.result,'PENDING');
  assert.equal(aud.same_timestamp_fixture,false);
  assert.equal(aud.component_result,'PASSED');
  assert.deepEqual(report.counts,{passed:2,failed:0,pending:1,blocked:0});
});
