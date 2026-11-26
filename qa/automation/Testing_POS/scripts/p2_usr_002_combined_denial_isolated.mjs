// PF-P2-USR-002: GET/POST/PATCH/lock denial on one QA3-owned staff fixture.
// Denied-write audit policy is observed but still requires a product decision.
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base = 'http://160.191.47.17';
const output = process.argv[2];
const password = process.env.S2_STAGING_PIN || process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
if (!output || !password || !/^[a-f0-9]{40}$/.test(expected || '')) {
  console.error('PENDING_CONFIG: provide output, private QA3 password and full POS_EXPECTED_COMMIT; no request sent');
  process.exit(2);
}

const report = {
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-PFP2USR002MATRIX',
  test_ref: 'PF-P2-USR-002-MATRIX', checked_at: new Date().toISOString(),
  result: 'INCONCLUSIVE',
  scope: 'QA3 CASHIER/WAITER/KITCHEN GET/list/permissions, POST create, PATCH and lock denial against one isolated staff; unchanged state, audit observation and owned cleanup.',
  case_coverage: 'LOWER_ROLE_STAFF_DENIAL_MATRIX',
  full_case_status: 'PENDING_DENIED_ATTEMPT_AUDIT_POLICY',
  secrets_recorded: false, roles: [], cleanup: {locked: false},
};
let supervisor, staffId, fixtureName, before, failure, deniedNames = [];

function safe(error) {
  let message = String(error?.message || error).replaceAll(password, '<REDACTED>');
  for (const token of [supervisor?.token, ...Object.values(roleTokens)]) {
    if (token) message = message.replaceAll(token, '<REDACTED>');
  }
  return message;
}
const roleTokens = {};
async function request(method, path, token, body) {
  const headers = {Accept: 'application/json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['Idempotency-Key'] = randomUUID();
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  return {http: response.status, data: await response.json().catch(() => null)};
}
async function login(username, role) {
  const auth = await request('POST', '/api/v1/auth/login', null, {username, password});
  if (auth.http !== 200 || !auth.data?.access_token) throw Error(`${username} login HTTP ${auth.http}`);
  const token = auth.data.access_token;
  roleTokens[username] = token;
  const me = await request('GET', '/api/v1/auth/me', token);
  if (me.http !== 200 || me.data?.username !== username ||
      me.data?.role !== role || !me.data?.outlet_id) throw Error(`${username} identity mismatch`);
  return {token, outlet: me.data.outlet_id};
}
async function ownStaff() {
  const result = await request('GET', `/api/v1/staff/${staffId}`, supervisor.token);
  if (result.http !== 200 || result.data?.id !== staffId) throw Error('Cannot verify owned staff');
  return result.data;
}

try {
  const version = await request('GET', '/version');
  before = version.data?.commit;
  report.staging_commit = before || null;
  if (version.http !== 200 || version.data?.environment !== 'staging' || before !== expected)
    throw Error('PENDING_BUILD: staging SHA differs from pinned build');
  supervisor = await login('qa3_admin', 'SUPERVISOR');
  const lower = [];
  for (const [username, role] of [
    ['qa3_cashier', 'CASHIER'], ['qa3_waiter', 'WAITER'], ['qa3_kitchen', 'KITCHEN'],
  ]) {
    const account = await login(username, role);
    if (account.outlet !== supervisor.outlet) throw Error(`${username} belongs to another outlet`);
    lower.push({role, token: account.token});
  }

  fixtureName = `qa_p2usr002_guard_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const created = await request('POST', '/api/v1/staff', supervisor.token, {
    username: fixtureName, password: randomBytes(24).toString('hex'),
    full_name: 'QA P2USR002 guard', role: 'WAITER',
  });
  staffId = created.data?.id;
  report.fixture_staff_id = staffId || null;
  if (created.http !== 201 || !staffId || created.data?.outlet_id !== supervisor.outlet)
    throw Error(`Fixture create HTTP ${created.http}; verify own staff before another run`);
  const original = await ownStaff();
  if (original.is_active !== true || original.role !== 'WAITER') throw Error('Fixture state mismatch');
  const auditPath = `/api/v1/audit-logs?entity_type=staff&entity_id=${staffId}&limit=100`;
  const initialAudit = await request('GET', auditPath, supervisor.token);
  if (initialAudit.http !== 200 || !Array.isArray(initialAudit.data))
    throw Error('Cannot read owned staff audit before denial matrix');
  report.initial_staff_audit_count = initialAudit.data.length;

  for (const user of lower) {
    const deniedName = `qa_p2usr002_denied_${user.role.toLowerCase()}_${randomBytes(4).toString('hex')}`;
    deniedNames.push(deniedName);
    const list = await request('GET', '/api/v1/staff', user.token);
    const matrix = await request('GET', '/api/v1/staff/permissions', user.token);
    const detail = await request('GET', `/api/v1/staff/${staffId}`, user.token);
    const create = await request('POST', '/api/v1/staff', user.token, {
      username: deniedName, password: randomBytes(24).toString('hex'),
      full_name: 'QA P2USR002 forbidden', role: 'WAITER',
    });
    const patch = await request('PATCH', `/api/v1/staff/${staffId}`, user.token,
      {full_name: `QA forbidden ${user.role}`});
    const lock = await request('POST', `/api/v1/staff/${staffId}/lock`, user.token);
    const current = await ownStaff();
    const unchanged = current.full_name === original.full_name &&
      current.role === original.role && current.is_active === true &&
      current.outlet_id === original.outlet_id;
    report.roles.push({role: user.role, list_http: list.http,
      permissions_http: matrix.http, detail_http: detail.http,
      create_http: create.http, patch_http: patch.http, lock_http: lock.http,
      staff_unchanged: unchanged,
      no_staff_in_denial: !detail.data?.id && !create.data?.id &&
        !patch.data?.id && !lock.data?.id});
  }
  const finalAudit = await request('GET', auditPath, supervisor.token);
  if (finalAudit.http !== 200 || !Array.isArray(finalAudit.data))
    throw Error('Cannot read owned staff audit after denial matrix');
  report.denied_staff_audit_delta = finalAudit.data.length - initialAudit.data.length;
  report.assertions_passed = report.roles.length === 3 && report.roles.every(row =>
    row.list_http === 403 && row.permissions_http === 403 &&
    row.detail_http === 403 && row.create_http === 403 &&
    row.patch_http === 403 && row.lock_http === 403 &&
    row.staff_unchanged && row.no_staff_in_denial);
} catch (error) { failure = safe(error); }
finally {
  if (supervisor && fixtureName) {
    try {
      const list = await request('GET', '/api/v1/staff', supervisor.token);
      if (list.http !== 200 || !Array.isArray(list.data))
        throw Error('Cannot verify denied usernames during cleanup');
      const unexpected = list.data.filter(row => deniedNames.includes(row.username));
      report.unexpected_created_count = unexpected.length;
      for (const row of unexpected) {
        const lockUnexpected = row.is_active === false ? {http: 200} :
          await request('POST', `/api/v1/staff/${row.id}/lock`, supervisor.token);
        if (lockUnexpected.http !== 200)
          throw Error(`CLEANUP REQUIRED: unexpected staff ${row.id} remains active`);
      }
      if (!staffId) {
        const matches = list.data.filter(x => x.username === fixtureName);
        if (matches.length === 1) staffId = matches[0].id;
      }
      if (staffId) {
        const state = await ownStaff();
        const lock = state.is_active === false ? {http: 200} :
          await request('POST', `/api/v1/staff/${staffId}/lock`, supervisor.token);
        const verified = await ownStaff();
        report.cleanup = {lock_http: lock.http, verify_http: 200,
          locked: lock.http === 200 && verified.is_active === false};
      } else report.cleanup_required = `Verify isolated staff ${fixtureName} in QA3; ID missing`;
    } catch (error) {
      report.cleanup_required = `Verify isolated staff ${fixtureName} in QA3: ${safe(error)}`;
    }
  }
  let after;
  try { after = (await request('GET', '/version')).data?.commit; } catch { /* keep first error */ }
  report.build_after = after || null;
  report.build_stable = !!before && before === after;
  report.result = report.cleanup_required ? 'INCONCLUSIVE' :
    failure && /(?:^|:\s)PENDING_/.test(failure) ? 'PENDING' :
    failure || !report.cleanup.locked || !report.build_stable ? 'INCONCLUSIVE' :
    report.assertions_passed && report.unexpected_created_count === 0 ?
      'PASSED_BRANCH_ONLY' : 'FAILED';
  if (failure) report.error = failure;
  mkdirSync(dirname(output), {recursive: true});
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED_BRANCH_ONLY' ? 0 :
    report.result === 'FAILED' ? 1 : 2;
}
