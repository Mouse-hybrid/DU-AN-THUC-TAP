// PF-P2-USR-008: read-only staff role observation for POS/KDS and staff permissions.
// QR customer actions and write actions require separate owned fixtures.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base = 'http://160.191.47.17';
const output = process.argv[2];
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
if (!output || !password || !expected || !/^[a-f0-9]{40}$/i.test(expected)) {
  console.error('PENDING_FIXTURE: OUTPUT, P2_QA_SEED_PASSWORD and full POS_EXPECTED_COMMIT required; no request sent');
  process.exit(2);
}
async function call(path, token, body) {
  const headers = {Accept:'application/json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method:body?'POST':'GET', headers, body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(25000),
  });
  return {http:res.status, data:await res.json().catch(()=>null)};
}
const report = {
  run_id:'RUN-' + new Date().toISOString().replace(/\D/g,'') + '-PFUSR008',
  test_ref:'PF-P2-USR-008', checked_at:new Date().toISOString(),
  scope:'Read-only QA3 staff GET matrix for tables (POS), kitchen queue (KDS), and staff permissions. QR customer and write actions not tested.',
  business_case:'P2-USR-008 NOT_EXECUTED: Customer/QR and action-level policy remain unverified.',
  secrets_recorded:false, result:'INCONCLUSIVE', rows:[],
};
let before;
try {
  const v = await call('/version');
  if (v.http !== 200 || v.data?.environment !== 'staging' ||
      v.data?.commit !== expected) throw Error('PENDING_BUILD: staging SHA mismatch');
  before = v.data.commit;
  report.staging_commit = before;
  const spec = await call('/openapi.json');
  if (spec.http !== 200 ||
      !spec.data?.paths?.['/api/v1/tables']?.get ||
      !spec.data?.paths?.['/api/v1/kitchen/queue']?.get ||
      !spec.data?.paths?.['/api/v1/staff/permissions']?.get)
    throw Error('PENDING_CONTRACT: GET routes absent');
  let outlet;
  for (const [username, role] of [
    ['qa3_admin','SUPERVISOR'],['qa3_cashier','CASHIER'],
    ['qa3_waiter','WAITER'],['qa3_kitchen','KITCHEN']]) {
    const login = await call('/api/v1/auth/login', null, {username,password});
    const token = login.data?.access_token;
    if (login.http !== 200 || !token) throw Error(`${username} login failed`);
    const me = await call('/api/v1/auth/me',token);
    if (me.http !== 200 || me.data?.role !== role || !me.data?.outlet_id ||
        (outlet && outlet !== me.data.outlet_id))
      throw Error(`${username} role/outlet mismatch`);
    outlet = me.data.outlet_id;
    const tables = await call('/api/v1/tables',token);
    const queue = await call('/api/v1/kitchen/queue',token);
    const permissions = await call('/api/v1/staff/permissions',token);
    report.rows.push({role,tables_http:tables.http,kitchen_queue_http:queue.http,
      staff_permissions_http:permissions.http});
  }
  const after = await call('/version');
  report.build_stable = after.http === 200 && after.data?.commit === before;
  report.result = report.build_stable && report.rows.length === 4 ? 'OBSERVED' : 'INCONCLUSIVE';
} catch (error) {
  report.error = String(error.message || error).replaceAll(password,'<REDACTED>');
  report.result = /^PENDING_/.test(report.error) ? 'PENDING' : 'INCONCLUSIVE';
} finally {
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  process.exitCode = report.result === 'OBSERVED' ? 0 : 2;
}
