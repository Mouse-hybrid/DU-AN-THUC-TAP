// EXE-QA-08: compose same-build, read-only Sprint 3 gates; no business requests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [root, day] = process.argv.slice(2);
if (!root || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) {
  console.error('Usage: node exe_qa_08_integration_matrix.mjs EVIDENCE_ROOT YYYY-MM-DD');
  process.exit(1);
}
const sources = {
  inventory:`DES-QA-07/DES_QA_07_LIVE_${day}.json`,
  fixture:`DES-QA-07/ENV_QA_04_GATE_${day}.json`,
  smoke:`EXE-QA-06/EXE_QA_06_READONLY_${day}.json`,
  qr:`DES-QA-07/TSK_QA_012_QR_READINESS_${day}.json`,
  rewards:`DES-QA-07/EXE_QA_07_REWARDS_READINESS_${day}.json`,
  billing:`DES-QA-07/TSK_QA_013_BILLING_READINESS_${day}.json`,
  stock:`DES-QA-07/TSK_QA_014_INVENTORY_READINESS_${day}.json`,
  scope:`DES-QA-07/TSK_QA_015_SCOPE_GATE_${day}.json`,
};
const data=Object.fromEntries(Object.entries(sources).map(([key,path])=>
  [key,JSON.parse(readFileSync(join(root,path),'utf8'))]));
const sha=data.inventory.commit;
if(!/^[a-f0-9]{40}$/i.test(sha || ''))throw new Error('Invalid inventory SHA');
for(const [key,obj] of Object.entries(data)){
  if((obj.commit || obj.staging_commit)!==sha)throw new Error(`SHA mismatch: ${key}`);
}
const group=(name)=>Array.isArray(data.inventory.groups?.[name])&&data.inventory.groups[name].length>0;
const reasons={
  QR:[...(!group('qr')?['QR public operation absent']:[]),
    ...(data.qr.counts?.blocked?['TSK-QA-012 case gate blocked']:[])],
  'POS Order':['Order write/read contract and same-build business evidence not audited by these inputs'],
  KDS:['Kitchen Queue/ticket and same-build event evidence not audited by these inputs'],
  Bill:[...(!group('payment_v2')?['Payment v2/split-bill operation absent']:[]),
    ...(data.billing.counts?.blocked?['TSK-QA-013 billing branch gate blocked']:[])],
  Rewards:[...(!group('rewards')?['Rewards operation absent']:[]),
    ...(data.rewards.counts?.blocked?['EXE-QA-07 case gate blocked']:[])],
  Pay:[...(!group('payment_v2')?['Payment v2 operation absent']:[]),
    ...(data.billing.counts?.blocked?['TSK-QA-013 payment branch gate blocked']:[])],
};
const stageDefs=[
  ['QR','QR-001/003/010; token, table/session, retry','Public QR schema + FE route + owned token/session'],
  ['POS Order','QR-009/020; QR/POS same session','Order/source audit and POS + QR fixture'],
  ['KDS','QR-015/017; ticket station and event','Kitchen Queue/ticket and same-build FE evidence'],
  ['Bill','QR-014; P2-PAY-008..010','Billing lock and split policy + owned bill'],
  ['Rewards','RW-004/005/010/011/015','CRM member/ledger, eligibility and replay policy'],
  ['Pay','P2-PAY-004/005; RW-012/016/018','Sandbox success/fail/UNKNOWN, reversal and cleanup'],
];
const stages=stageDefs.map(([stage,test_refs,required_gate])=>{
  const blockers=[...reasons[stage],
    ...(data.fixture.status!=='READY_FOR_QA_REVIEW'?['ENV-QA-04 fixture not ready']:[])];
  return {stage,test_refs,required_gate,readiness:blockers.length?'BLOCKED':'REVIEW_REQUIRED',
    blockers,business_execution:'NOT_EXECUTED_IN_THIS_RUN'};
});
// Read-only evidence must never turn a stage green, even if candidate paths appear.
const matrix={task:'EXE-QA-08',checked_at:new Date().toISOString(),staging_commit:sha,
  type:'SAME_BUILD_READINESS_ONLY',stages,
  result:{stages:stages.length,blocked:stages.filter(s=>s.readiness==='BLOCKED').length,
    review_required:stages.filter(s=>s.readiness==='REVIEW_REQUIRED').length,
    integration_business_pass:0},sources};
const freeze={task:'QA-FREEZE',checked_at:matrix.checked_at,staging_commit:sha,
  status:'DRAFT_INCOMPLETE',source:'Current-date read-only evidence only',
  api_preflight:data.smoke.api_preflight?.status || 'UNVERIFIED',
  qr_design_cases:{total:data.qr.counts?.total,readiness_blocked:data.qr.counts?.blocked,
    business_execution:'NOT_EXECUTED_IN_SUPPLIED_GATE'},
  rewards_design_cases:{total:data.rewards.counts?.total,readiness_blocked:data.rewards.counts?.blocked,
    business_execution:'NOT_EXECUTED_IN_SUPPLIED_GATE'},
  other_gates:{billing:data.billing.counts,stock:data.stock.counts,scope:data.scope.counts},
  integrated_flow:'BLOCKED; no same-build business run supplied',
  caveat:'This draft does not aggregate historical Phase 1/Sprint 2 results or adjudicate bugs and cannot support go/no-go.'};
for(const [path,value] of [
  [`EXE-QA-08/EXE_QA_08_MATRIX_${day}.json`,matrix],
  [`QA-FREEZE/QA_FREEZE_DRAFT_${day}.json`,freeze],
]){
  const dest=join(root,path);mkdirSync(dirname(dest),{recursive:true});
  writeFileSync(dest,JSON.stringify(value,null,2)+'\n');
}
console.log(JSON.stringify({sha,matrix:matrix.result,qa_freeze:freeze.status,
  output:[`EXE-QA-08/EXE_QA_08_MATRIX_${day}.json`,`QA-FREEZE/QA_FREEZE_DRAFT_${day}.json`]},null,2));
process.exitCode=matrix.result.blocked?2:0;
