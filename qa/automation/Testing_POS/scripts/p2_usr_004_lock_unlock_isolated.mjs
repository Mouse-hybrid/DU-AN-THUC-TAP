// P2-USR-004: lock and unlock one newly created QA 3 staff account.
// The final state is locked. Seed accounts and other outlets are never changed.
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base = 'http://160.191.47.17';
const output = process.argv[2];
let password = process.env.P2_QA_SEED_PASSWORD;
if (!output || !password) {
  console.error('Usage: set P2_QA_SEED_PASSWORD privately; node scripts/p2_usr_004_lock_unlock_isolated.mjs OUTPUT.json');
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
  run_id: `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-P2USR004`,
  test_ref: 'P2-USR-004', checked_at: new Date().toISOString(), result: 'INCONCLUSIVE',
  scope: 'One isolated QA3 WAITER: lock, reject old token/login, unlock, fresh login, final lock.',
  secrets_recorded: false,
};
let adminToken, memberToken, memberPassword, staffId, username;
let assertions = false, cleanup = false, error;
try {
  const version = await req('GET', '/version');
  if (version.http !== 200 || version.data?.environment !== 'staging' ||
      !/^[a-f0-9]{40}$/.test(version.data?.commit ?? '')) throw Error('Invalid staging version');
  report.build_before = version.data.commit;
  const expected = process.env.POS_EXPECTED_COMMIT;
  if (!expected || !/^[a-f0-9]{40}$/.test(expected) || version.data.commit !== expected)
    throw Error('Expected full staging SHA missing or mismatched');
  const spec = await req('GET', '/openapi.json');
  const paths = spec.data?.paths ?? {};
  if (spec.http !== 200 || !paths['/api/v1/staff']?.post ||
      !paths['/api/v1/staff/{staff_id}/lock']?.post ||
      !paths['/api/v1/staff/{staff_id}/unlock']?.post)
    throw Error('PENDING_CONTRACT: staff create/lock/unlock absent');
  const login = await req('POST', '/api/v1/auth/login', null, {username: 'qa3_admin', password});
  adminToken = login.data?.access_token;
  if (login.http !== 200 || !adminToken) throw Error(`QA3 supervisor login HTTP ${login.http}`);
  const admin = await req('GET', '/api/v1/auth/me', adminToken);
  if (admin.http !== 200 || admin.data?.username !== 'qa3_admin' ||
      admin.data?.role !== 'SUPERVISOR' || !admin.data?.outlet_id)
    throw Error('QA3 supervisor identity mismatch');
  report.outlet_id = admin.data.outlet_id;
  username = `qa_p2usr004_${Date.now()}_${randomBytes(3).toString('hex')}`;
  memberPassword = randomBytes(24).toString('hex');
  const create = await req('POST', '/api/v1/staff', adminToken,
    {username, password: memberPassword, full_name: 'QA P2USR004 isolated', role: 'WAITER'}, randomUUID());
  staffId = create.data?.id;
  report.fixture_username = username; report.fixture_staff_id = staffId ?? null;
  report.create_http = create.http;
  if (create.http !== 201 || !staffId || create.data?.outlet_id !== admin.data.outlet_id)
    throw Error('Fixture creation failed; inspect own username before rerun');
  const initial = await req('POST', '/api/v1/auth/login', null,
    {username, password: memberPassword});
  memberToken = initial.data?.access_token;
  if (initial.http !== 200 || !memberToken) throw Error('Own fixture login failed');
  const before = await req('GET', '/api/v1/auth/me', memberToken);
  if (before.http !== 200 || before.data?.id !== staffId || before.data?.role !== 'WAITER')
    throw Error('Own fixture identity mismatch');

  const lock = await req('POST', `/api/v1/staff/${staffId}/lock`, adminToken);
  const oldToken = await req('GET', '/api/v1/auth/me', memberToken);
  const deniedLogin = await req('POST', '/api/v1/auth/login', null,
    {username, password: memberPassword});
  const unlock = await req('POST', `/api/v1/staff/${staffId}/unlock`, adminToken);
  const freshLogin = await req('POST', '/api/v1/auth/login', null,
    {username, password: memberPassword});
  const freshMe = freshLogin.data?.access_token
    ? await req('GET', '/api/v1/auth/me', freshLogin.data.access_token)
    : {http: null, data: null};
  report.http = {
    lock: lock.http, old_token_after_lock: oldToken.http, login_while_locked: deniedLogin.http,
    unlock: unlock.http, login_after_unlock: freshLogin.http, me_after_unlock: freshMe.http,
  };
  assertions = lock.http === 200 && lock.data?.is_active === false &&
    oldToken.http === 401 && deniedLogin.http === 401 &&
    unlock.http === 200 && unlock.data?.is_active === true &&
    freshLogin.http === 200 && freshMe.http === 200 && freshMe.data?.id === staffId &&
    freshMe.data?.role === 'WAITER' && freshMe.data?.outlet_id === admin.data.outlet_id;
  report.assertions_passed = assertions;
} catch (e) { error = e.message; }
finally {
  if (staffId && adminToken) {
    try {
      const lock = await req('POST', `/api/v1/staff/${staffId}/lock`, adminToken);
      const verify = await req('GET', `/api/v1/staff/${staffId}`, adminToken);
      cleanup = lock.http === 200 && verify.http === 200 && verify.data?.is_active === false;
      report.cleanup = {lock_http: lock.http, verify_http: verify.http, locked: cleanup};
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
  password = undefined; memberPassword = undefined;
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
