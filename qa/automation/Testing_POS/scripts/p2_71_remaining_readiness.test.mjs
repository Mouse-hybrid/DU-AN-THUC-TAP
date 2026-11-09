import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const manifest=JSON.parse(readFileSync(process.env.P2_CASE_MANIFEST??new URL('../testdata/p2_71_case_manifest.json',import.meta.url),'utf8'));
const mod=await import('./p2_71_remaining_readiness.mjs').catch(()=>({assessRemaining:()=>({cases:[],counts:{business_pass:0}})}));
const assess=mod.assessRemaining;
const sha='be90389e58fb009ba949d3984d2a5941ad974948';
const auditParams=['order_id','action','created_from','created_to','limit','offset'].map(name=>({name}));

test('45 remaining cases are readiness only with explicit contract gaps',()=>{
  const result=assess(manifest,{commit:sha},{paths:{
    '/api/v1/audit-logs':{get:{parameters:auditParams}},
    '/api/v1/orders/{order_id}/items/{item_id}/void':{post:{}}
  }});
  assert.equal(result.cases.length,45);
  assert.equal(result.counts.business_pass,0);
  const byId=Object.fromEntries(result.cases.map(c=>[c.id,c]));
  assert.equal(byId['P2-PAY-001'].readiness,'BLOCKED_MISSING_OPERATION');
  assert.equal(byId['P2-AUD-001'].readiness,'CONTRACT_PRESENT');
  assert.equal(byId['P2-AUD-004'].readiness,'BLOCKED_MISSING_OPERATION');
  assert.equal(byId['P2-AUD-005'].readiness,'BLOCKED_SCOPE_DEPENDENCY');
  assert.equal(byId['P2-ORD-001'].readiness,'BLOCKED_MISSING_VERSION_CONTRACT');
  assert.equal(byId['P2-ORD-003'].readiness,'BLOCKED_MISSING_PIN_CONTRACT');
  assert.equal(byId['P2-MON-002'].readiness,'BLOCKED_EXTERNAL_ACCESS');
  assert.ok(result.cases.every(c=>c.business_execution==='NOT_EXECUTED_IN_THIS_RUN'));
  assert.ok(!result.cases.some(c=>c.id.startsWith('P2-QR-')||c.id.startsWith('P2-RWD-')));
});

test('adding a proposed staff operation changes contract readiness, never business status',()=>{
  const result=assess(manifest,{commit:sha},{paths:{'/api/v1/staff':{post:{}}}});
  const staff=result.cases.find(c=>c.id==='P2-USR-001');
  assert.equal(staff.readiness,'CONTRACT_PRESENT');
  assert.equal(staff.business_execution,'NOT_EXECUTED_IN_THIS_RUN');
});

test('table merge canonical route resolves the manifest alias without executing business cases',()=>{
  const paths={
    '/api/v1/tables/{table_id}/transfer':{post:{}},
    '/api/v1/tables/{table_id}/merge':{post:{}},
    '/api/v1/orders/{order_id}/split':{post:{}},
  };
  const result=assess(manifest,{commit:sha},{paths});
  const byId=Object.fromEntries(result.cases.map(c=>[c.id,c]));
  for(const id of ['P2-TBL-007','P2-TBL-008','P2-TBL-009','P2-TBL-010','P2-TBL-012']) {
    assert.equal(byId[id].readiness,'CONTRACT_PRESENT',id);
    assert.deepEqual(byId[id].missing_operations,[],id);
    assert.equal(byId[id].business_execution,'NOT_EXECUTED_IN_THIS_RUN',id);
  }
  assert.equal(result.counts.business_pass,0);
});
