// PF-P2-RWD-001: customer creation, ledger, audit and role PII observations.
// The record remains for audit; no global staging reset or seed account changes.
import {randomInt, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expectedCommit = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_rwd_001_customer_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expectedCommit) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const tokens = {};
const report = {test_ref:'PF-P2-RWD-001', checked_at:new Date().toISOString(),
  scope:'QA 3 customer: create and lookup, points ledger, audit, role/PII observation; deactivate owned fixture.',
  business_case:'P2-RWD-001 NOT_EXECUTED: role-based PII policy is not approved; order/session step is not applicable to standalone customer creation.',
  result:'INCONCLUSIVE', secrets_recorded:false, phone_recorded:false};
let customerId, customerPhone, fixtureName, buildBefore, buildAfter;
let assertionPassed = false, cleaned = false, failure, mutated = false, mutationPossible = false;
function call(method, path, role, body) {
  const args = ['--max-time','30','--silent','--show-error','--write-out','\n%{http_code}','-X',method];
  if (role) args.push('-H',`Authorization: Bearer ${tokens[role]}`);
  if (body !== undefined) args.push('-H','Content-Type: application/json','--data-binary','@-');
  if (method !== 'GET') args.push('-H',`Idempotency-Key: ${randomUUID()}`);
  args.push(base+path);
  const raw = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl',args,
    {encoding:'utf8',input:body === undefined ? undefined : JSON.stringify(body),maxBuffer:3_000_000});
  const n=raw.lastIndexOf('\n');
  const http=Number(raw.slice(n+1));
  let data;
  try { data=JSON.parse(raw.slice(0,n)); } catch { data=null; }
  return {http,data};
}
function must(reply,http,label) {
  if(reply.http!==http)throw new Error(`${label}: HTTP ${reply.http}, expected ${http}`);
  return reply.data;
}
function safeError(error) {
  let s=String(error?.message || error);
  for(const secret of [password,customerPhone,...Object.values(tokens)])
    if(secret)s=s.replaceAll(secret,'<REDACTED>');
  return s;
}
function version(){return must(call('GET','/version'),200,'version')?.commit;}
try {
  buildBefore=version();
  if(!/^[0-9a-f]{40}$/.test(buildBefore||''))throw new Error('Invalid staging SHA');
  if(!/^[0-9a-f]{7,40}$/.test(expectedCommit)||!buildBefore.startsWith(expectedCommit))
    throw new Error('Staging SHA mismatch');
  report.staging_commit=buildBefore;
  const spec=must(call('GET','/openapi.json'),200,'OpenAPI');
  if(!spec?.paths?.['/api/v1/customers']?.post || !spec?.paths?.['/api/v1/customers']?.get ||
     !spec?.paths?.['/api/v1/customers/{customer_id}']?.patch ||
     !spec?.paths?.['/api/v1/customers/{customer_id}/points']?.get ||
     !spec?.paths?.['/api/v1/audit-logs']?.get)
    throw new Error('Customer create/search/lock/points/audit contract missing');
  for(const [role,username,wantRole] of [
    ['admin','qa3_admin','SUPERVISOR'],['cashier','qa3_cashier','CASHIER'],
    ['waiter','qa3_waiter','WAITER'],['kitchen','qa3_kitchen','KITCHEN']]){
    const auth=must(call('POST','/api/v1/auth/login',null,{username,password}),200,`${username} login`);
    if(!auth?.access_token)throw new Error(`${username} has no access token`);
    tokens[role]=auth.access_token;
    const me=must(call('GET','/api/v1/auth/me',role),200,`${username} identity`);
    if(me.username!==username||me.role!==wantRole||!me.outlet_id)
      throw new Error(`${username} role/outlet mismatch`);
    report[`${role}_outlet_id`]=me.outlet_id;
  }
  if(['cashier','waiter','kitchen'].some(role=>report[`${role}_outlet_id`]!==report.admin_outlet_id))
    throw new Error('QA 3 roles are in different outlets');
  const tables=must(call('GET','/api/v1/tables','admin'),200,'QA 3 tables');
  if(!Array.isArray(tables)||!tables.some(t=>/^Q3-[123]$/.test(t.code)))
    throw new Error('QA 3 fixture gate: Q3 tables not found');
  fixtureName=`QA P2RWD001 ${randomUUID().slice(0,8)}`;
  // Dedicated test phone. The exact number is kept only in memory and never printed.
  customerPhone=`09${String(randomInt(0,100_000_000)).padStart(8,'0')}`;
  const pre=must(call('GET',`/api/v1/customers?phone=${encodeURIComponent(customerPhone)}`,'cashier'),200,'pre-create lookup');
  if(!Array.isArray(pre)||pre.length)throw new Error('Generated QA phone already in use; no mutation');
  mutationPossible=true;
  const created=call('POST','/api/v1/customers','cashier',
    {phone:customerPhone,full_name:fixtureName,consent:true});
  report.create_http=created.http;
  customerId=created.data?.id;
  report.fixture_customer_id=customerId||null;
  if(customerId)mutated=true;
  if(created.http!==201||!customerId)throw new Error(`create customer HTTP ${created.http}; inspect staging if response lacks id`);
  const list=call('GET',`/api/v1/customers?phone=${encodeURIComponent(customerPhone)}`,'cashier');
  report.lookup_http=list.http;
  const byId=call('GET',`/api/v1/customers/${customerId}`,'cashier');
  report.own_get_http=byId.http;
  const c=created.data, found=list.data?.[0], own=byId.data;
  report.assertions_passed=list.http===200&&Array.isArray(list.data)&&list.data.length===1&&
    byId.http===200&&[c,found,own].every(x=>x?.id===customerId&&x.phone===customerPhone&&
      x.full_name===fixtureName&&x.is_active===true&&typeof x.member_code==='string'&&
      !!x.consent_at);
  const points=must(call('GET',`/api/v1/customers/${customerId}/points`,'cashier'),200,'own points');
  const audit=must(call('GET',
    `/api/v1/audit-logs?entity_id=${customerId}&entity_type=customer&limit=100`,'admin'),200,'customer audit');
  report.ledger_entries=Array.isArray(points)?points.length:null;
  report.customer_created_audit_count=Array.isArray(audit)?audit.filter(x=>x.action==='CUSTOMER_CREATED').length:null;
  report.role_pii_observed={};
  for(const role of ['admin','cashier','waiter','kitchen']){
    const response=call('GET',`/api/v1/customers/${customerId}`,role);
    if(![200,403,404].includes(response.http))throw new Error(`${role} customer read HTTP ${response.http}`);
    report.role_pii_observed[role]={http:response.http,
      phone_visible:response.http===200 && response.data?.phone===customerPhone,
      phone_masked:response.http===200 && typeof response.data?.phone==='string' &&
        response.data.phone!==customerPhone};
  }
  report.assertions_passed=report.assertions_passed &&
    Array.isArray(points)&&points.length===0&&
    Array.isArray(audit)&&report.customer_created_audit_count===1;
  assertionPassed=report.assertions_passed;
} catch(error) { failure=safeError(error); }
finally {
  if(mutationPossible && !customerId && customerPhone && fixtureName && tokens.cashier) {
    try {
      const found=call('GET',`/api/v1/customers?phone=${encodeURIComponent(customerPhone)}`,'cashier');
      const owned=found.http===200 && Array.isArray(found.data) ?
        found.data.filter(x=>x.full_name===fixtureName && x.phone===customerPhone) : [];
      if(owned.length===1)customerId=owned[0].id;
      if(owned.length>1)failure=`${failure||'Create response unavailable'}; CLEANUP REQUIRED: multiple QA profiles for generated phone`;
    } catch { /* preserve primary error */ }
  }
  if(customerId&&tokens.admin){
    try {
      const locked=call('PATCH',`/api/v1/customers/${customerId}`,'admin',{is_active:false});
      const verify=call('GET',`/api/v1/customers/${customerId}`,'admin');
      cleaned=locked.http===200&&verify.http===200&&verify.data?.id===customerId&&verify.data?.is_active===false;
      report.cleanup={lock_http:locked.http,verify_http:verify.http,inactive:cleaned};
    } catch(error) { report.cleanup={inactive:false,error:safeError(error)}; }
  }
  try { buildAfter=version(); } catch { /* preserve primary error */ }
  report.build_stable=!!buildBefore&&buildBefore===buildAfter;
  report.result=assertionPassed&&cleaned&&report.build_stable?'PASSED':
    mutated&&cleaned&&report.build_stable?'FAILED':'INCONCLUSIVE';
  if(failure)report.error=failure;
  if(mutationPossible&&!cleaned)report.cleanup_required=`CLEANUP REQUIRED: check own QA customer ${customerId||'unknown id'} with generated fixture name ${fixtureName||'unknown'}`;
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.result==='PASSED'?0:report.result==='FAILED'?1:2;
}
