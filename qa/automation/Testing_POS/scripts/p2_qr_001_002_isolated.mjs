// QA 3 only: issue a QR token, read public menu, revoke it, then finish the
// owned starter order and clean the table. A full QR order submission is separate.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }
const roles = {};
const owned = { tableId: null, tableCode: null, sessionId: null, orderId: null, itemId: null, qrIssued: false };
const log = [];
function redact(value) {
  let safe = String(value).replaceAll(password, '<REDACTED>');
  for (const jwt of Object.values(roles)) safe = safe.replaceAll(jwt, '<REDACTED>');
  return safe.replace(/\/api\/v1\/public\/qr\/[^\s/'"]+/g, '/api/v1/public/qr/<REDACTED>');
}
function call(method, path, role, body, key) {
  const args = ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', '-X', method];
  if (role) args.push('-H', `Authorization: Bearer ${roles[role]}`);
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (method !== 'GET' && method !== 'HEAD') args.push('-H', `Idempotency-Key: ${key || randomUUID()}`);
  args.push(`${base}${path}`);
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const raw = execFileSync(command, args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 3_000_000,
  });
  const split = raw.lastIndexOf('\n');
  const http = Number(raw.slice(split + 1));
  const text = raw.slice(0, split);
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { http, data };
}
function must(r, expectedHttp, label) {
  if (r.http !== expectedHttp) throw new Error(`${label} HTTP ${r.http}, expected ${expectedHttp}`);
  return r.data;
}
function version() { return must(call('GET', '/version'), 200, 'version').commit; }
function order() { return must(call('GET', `/api/v1/orders/${owned.orderId}`, 'cashier'), 200, 'own order'); }
function table() { return must(call('GET', `/api/v1/tables/${owned.tableId}`, 'waiter'), 200, 'own table'); }
function post(path, role, body) { return call('POST', path, role, body); }
function finish() {
  if (!owned.orderId) throw new Error(`CLEANUP REQUIRED: ${owned.tableCode} session ${owned.sessionId}; no owned order`);
  const current = order();
  if (current.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session changed');
  const observed = table();
  if (observed.id !== owned.tableId || (observed.current_session?.id && observed.current_session.id !== owned.sessionId)) {
    throw new Error('CLEANUP REQUIRED: table identity/session changed');
  }
  if (current.status === 'NEW') must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  const s1 = order().status;
  if (!['BILLING', 'PAID', 'CLOSED'].includes(s1)) must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  const s2 = order().status;
  if (!['PAID', 'CLOSED'].includes(s2)) must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order().status !== 'CLOSED') must(post(`/api/v1/orders/${owned.orderId}/close`, 'cashier'), 200, 'cleanup close');
  if (table().status === 'CLEANING') must(post(`/api/v1/tables/${owned.tableId}/mark-clean`, 'waiter'), 200, 'cleanup clean');
  if (order().status !== 'CLOSED' || table().status !== 'AVAILABLE') throw new Error('CLEANUP REQUIRED: final state mismatch');
  return true;
}
let buildBefore, buildAfter, passed = false, cleanupPass = false, failure;
try {
  buildBefore = version();
  if (expected && !buildBefore.startsWith(expected)) throw new Error(`Unexpected build ${buildBefore}`);
  const spec = must(call('GET', '/openapi.json'), 200, 'OpenAPI');
  for (const p of ['/api/v1/tables/{table_id}/qr-session', '/api/v1/public/qr/{token}/menu']) {
    if (!spec.paths?.[p]) throw new Error(`Missing contract ${p}`);
  }
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error(`${name} role/token mismatch`);
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(call('GET', '/api/v1/tables', 'waiter'), 200, 'tables');
  const candidates = tables.filter(x => /^Q3-[12]$/.test(x.code) && x.status === 'AVAILABLE');
  const menu = must(call('GET', '/api/v1/menu?available_only=true', 'cashier'), 200, 'staff menu');
  const item = menu.find(x => x.is_available && x.station_id && x.name !== 'Trà đá');
  if (!candidates.length || !item) throw new Error('PENDING_FIXTURE: no AVAILABLE Q3-1/Q3-2 or mapped starter item; no mutation');
  for (const candidate of candidates) {
    const opened = post(`/api/v1/tables/${candidate.id}/open-session`, 'waiter', { guest_count: 1 });
    if (opened.http === 409) continue;
    const session = must(opened, 201, `open ${candidate.code}`);
    owned.tableId = candidate.id; owned.tableCode = candidate.code; owned.sessionId = session.id;
    break;
  }
  if (!owned.sessionId) throw new Error('PENDING_FIXTURE: all QA 3 tables became occupied; no mutation');
  owned.orderId = must(post('/api/v1/orders', 'cashier', { table_session_id: owned.sessionId }), 201, 'create order').id;
  if (!owned.orderId) throw new Error('CLEANUP REQUIRED: create order returned no id');
  const added = must(post(`/api/v1/orders/${owned.orderId}/items`, 'cashier',
    { items: [{ menu_item_id: item.id, quantity: 1, note: 'QA P2 QR001002 cleanup starter' }] }), 201, 'add starter');
  owned.itemId = added.items?.find(x => x.menu_item_id === item.id)?.id;
  if (!owned.itemId) throw new Error('CLEANUP REQUIRED: starter item missing');
  const issued = must(post(`/api/v1/tables/${owned.tableId}/qr-session`, 'waiter'), 201, 'issue QR');
  owned.qrIssued = true;
  if (issued.table_session_id !== owned.sessionId || !issued.token) throw new Error('QR session mismatch');
  const info = must(call('GET', `/api/v1/public/qr/${issued.token}`), 200, 'QR info');
  if (info.table_code !== owned.tableCode || info.ordering_locked !== false) throw new Error('QR info mismatch');
  const qrMenu = must(call('GET', `/api/v1/public/qr/${issued.token}/menu`), 200, 'QR menu');
  if (!Array.isArray(qrMenu.items) || !qrMenu.items.some(x => x.id === item.id && x.is_available)) {
    throw new Error('QR menu missing available starter');
  }
  log.push({ step: 'issue and public menu', result: 'PASSED', item_count: qrMenu.items.length });
  must(call('DELETE', `/api/v1/tables/${owned.tableId}/qr-session`, 'waiter'), 204, 'revoke QR');
  owned.qrIssued = false;
  must(call('GET', `/api/v1/public/qr/${issued.token}`), 401, 'revoked token');
  log.push({ step: 'revoke token', result: 'PASSED', revoked_http: 401 });
  cleanupPass = finish();
  buildAfter = version();
  if (buildBefore !== buildAfter) throw new Error('Build changed mid-run');
  passed = true;
} catch (e) {
  failure = redact(e.message || e);
} finally {
  if (owned.sessionId && !cleanupPass) {
    try {
      // Revoke only the token issued for this owned table; cleanup uses owned IDs.
      if (owned.qrIssued) call('DELETE', `/api/v1/tables/${owned.tableId}/qr-session`, 'waiter');
      cleanupPass = finish();
    } catch (e) { failure = `${failure || 'Runner error'}; ${redact(e.message || e)}`; }
  }
  if (!buildAfter) { try { buildAfter = version(); } catch { /* preserve primary error */ } }
  const result = {
    test_ref: 'PF-P2-QR-001-002', checked_at: new Date().toISOString(), build_before: buildBefore,
    build_after: buildAfter, build_stable: buildBefore === buildAfter, table_code: owned.tableCode,
    order_id: owned.orderId, item_id: owned.itemId, checks: log, cleanup_pass: cleanupPass,
    order_closed: cleanupPass, table_available: cleanupPass, result: passed && cleanupPass ? 'PASSED' : 'NOT_PASSED',
    business_cases: 'P2-QR-001/002 require testcase-scope review; QR submission and customer UI were not tested',
    error: failure || null, token_recorded: false, secrets_recorded: false,
  };
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'PASSED') process.exitCode = cleanupPass || !owned.sessionId ? 2 : 1;
}
