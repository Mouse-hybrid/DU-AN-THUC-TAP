// P2-USR-005: reset password of one newly created QA3 staff account.
// No seed-account mutation; the newly created account is locked after the test.
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base = 'http://160.191.47.17', output = process.argv[2];
let seed = process.env.P2_QA_SEED_PASSWORD;
if (!output || !seed) {
  console.error('Usage: set P2_QA_SEED_PASSWORD privately; node scripts/p2_usr_005_reset_password_isolated.mjs OUTPUT.json');
  process.exit(2);
}
const req = async (method, path, token, body, key) => {
  const headers = {Accept: 'application/json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(base + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  return {http: response.status, data: await response.json().catch(() => null)};
};
const report = {
  run_id: `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-P2USR005`,
  test_ref: 'PF-P2-USR-005', checked_at: new Date().toISOString(), result: 'INCONCLUSIVE',
  scope: 'Reset password for isolated QA3 WAITER; old token/password denied, new login works, no response secret; final lock.',
  business_case: 'P2-USR-005 NOT_EXECUTED: audit, logs and password-change policy not covered.',
  secrets_recorded: false,
};
let adminToken, staffId, username, oldPassword, newPassword, cleanup = false, assertions = false, error;
try {
  const version = await req('GET', '/version');
  if (version.http !== 200 || version.data?.environment !== 'staging' ||
      !/^[a-f0-9]{40}$/.test(version.data?.commit ?? '')) throw Error('Invalid staging version');
  report.build_before = version.data.commit;
  const expected = process.env.POS_EXPECTED_COMMIT;
  if (!expected || !/^[a-f0-9]{40}$/.test(expected) || expected !== version.data.commit)
    throw Error('Expected full staging SHA missing or mismatched');
  const schema = await req('GET', '/openapi.json');
  if (schema.http !== 200 || !schema.data?.paths?.['/api/v1/staff']?.post ||
      !schema.data?.paths?.['/api/v1/staff/{staff_id}/reset-password']?.post ||
      !schema.data?.paths?.['/api/v1/staff/{staff_id}/lock']?.post)
    throw Error('PENDING_CONTRACT: create/reset-password/lock absent');
  const login = await req('POST', '/api/v1/auth/login', null,
    {username: 'qa3_admin', password: seed});
  adminToken = login.data?.access_token;
  if (login.http !== 200 || !adminToken) throw Error(`QA3 supervisor login HTTP ${login.http}`);
  const admin = await req('GET', '/api/v1/auth/me', adminToken);
  if (admin.http !== 200 || admin.data?.username !== 'qa3_admin' ||
      admin.data?.role !== 'SUPERVISOR' || !admin.data?.outlet_id)
    throw Error('QA3 supervisor identity mismatch');
  username = `qa_p2usr005_${Date.now()}_${randomBytes(3).toString('hex')}`;
  oldPassword = randomBytes(24).toString('hex');
  newPassword = randomBytes(24).toString('hex');
  const created = await req('POST', '/api/v1/staff', adminToken,
    {username, password: oldPassword, full_name: 'QA P2USR005 isolated', role: 'WAITER'}, randomUUID());
  staffId = created.data?.id;
  report.fixture_username = username; report.fixture_staff_id = staffId ?? null;
  report.create_http = created.http;
  if (created.http !== 201 || !staffId || created.data?.outlet_id !== admin.data.outlet_id)
    throw Error('Fixture creation failed; inspect own username before rerun');
  const initial = await req('POST', '/api/v1/auth/login', null,
    {username, password: oldPassword});
  if (initial.http !== 200 || !initial.data?.access_token) throw Error('Initial fixture login failed');
  const reset = await req('POST', `/api/v1/staff/${staffId}/reset-password`, adminToken,
    {new_password: newPassword}, randomUUID());
  const stale = await req('GET', '/api/v1/auth/me', initial.data.access_token);
  const oldLogin = await req('POST', '/api/v1/auth/login', null,
    {username, password: oldPassword});
  const newLogin = await req('POST', '/api/v1/auth/login', null,
    {username, password: newPassword});
  const fresh = newLogin.data?.access_token
    ? await req('GET', '/api/v1/auth/me', newLogin.data.access_token)
    : {http: null, data: null};
  const secretExposed = [created.data, reset.data, fresh.data].some(x => {
    const serialized = JSON.stringify(x ?? {});
    return serialized.includes(oldPassword) || serialized.includes(newPassword) ||
      /"(?:password|password_hash|new_password)"\s*:/.test(serialized);
  });
  report.http = {reset: reset.http, stale_token: stale.http, old_password_login: oldLogin.http,
    new_password_login: newLogin.http, fresh_me: fresh.http};
  report.credential_not_exposed = !secretExposed;
  assertions = reset.http === 200 && stale.http === 401 && oldLogin.http === 401 &&
    newLogin.http === 200 && fresh.http === 200 && fresh.data?.id === staffId &&
    fresh.data?.outlet_id === admin.data.outlet_id && !secretExposed;
  report.assertions_passed = assertions;
} catch (e) { error = e.message; }
finally {
  if (!staffId && username && adminToken) {
    try {
      const list = await req('GET', '/api/v1/staff', adminToken);
      const matches = Array.isArray(list.data) ? list.data.filter(x => x.username === username) : [];
      if (list.http === 200 && matches.length === 1) {
        staffId = matches[0].id;
        report.fixture_staff_id = staffId;
      }
    } catch { /* preserve original error */ }
  }
  if (staffId && adminToken) {
    try {
      const locked = await req('POST', `/api/v1/staff/${staffId}/lock`, adminToken, undefined, randomUUID());
      const verify = await req('GET', `/api/v1/staff/${staffId}`, adminToken);
      cleanup = [200, 409].includes(locked.http) && verify.http === 200 && verify.data?.is_active === false;
      report.cleanup = {lock_http: locked.http, verify_http: verify.http, locked: cleanup};
    } catch (e) { report.cleanup = {locked: false, error: e.message}; }
  }
  try {
    const after = await req('GET', '/version');
    report.build_after = after.data?.commit;
    report.build_stable = after.http === 200 && after.data?.commit === report.build_before;
  } catch { report.build_stable = false; }
  report.result = error || !cleanup || !report.build_stable ? 'INCONCLUSIVE' :
    assertions ? 'PASSED' : 'FAILED';
  if (error) report.runner_error = error;
  if (staffId && !cleanup) report.cleanup_required = `Lock only owned staff ${staffId} (${username})`;
  mkdirSync(dirname(output), {recursive: true});
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  seed = undefined; oldPassword = undefined; newPassword = undefined;
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
