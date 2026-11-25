// P2-QR-007: invalid, revoked and naturally expired QR tokens on one owned QA3 session.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.S2_STAGING_PIN;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('QA3 staging only');
if (!pin || !/^[a-f0-9]{40}$/.test(expected || '') || !output)
  throw new Error('S2_STAGING_PIN, full POS_EXPECTED_COMMIT and evidence output path required');

const roles = {};
const own = { tableId: null, sessionId: null, orderId: null, itemId: null, menuId: null, token: null };
const report = {
  run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-P2QR007`,
  test_ref: 'P2-QR-007', checked_at: new Date().toISOString(),
  scope: 'QA3 invalid, revoked and naturally expired QR tokens: public info/menu/order/submit denied without private data or customer order; owned cleanup and stable build.',
  token_recorded: false, secrets_recorded: false, checks: {}, cleanup_pass: false,
  case_coverage: 'INVALID_REVOKED_EXPIRED_TOKEN',
};
function redact(value) {
  let safe = String(value);
  for (const secret of [pin, own.token, ...Object.values(roles)])
    if (secret) safe = safe.replaceAll(secret, '<REDACTED>');
  return safe;
}
function call(method, path, role, data) {
  const args = ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', '-X', method];
  if (role) args.push('-H', `Authorization: Bearer ${roles[role]}`);
  if (data !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (!['GET', 'HEAD'].includes(method)) args.push('-H', `Idempotency-Key: ${randomUUID()}`);
  args.push(base + path);
  const raw = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'utf8', input: data === undefined ? undefined : JSON.stringify(data), maxBuffer: 3_000_000,
  });
  const split = raw.lastIndexOf('\n');
  let body = raw.slice(0, split);
  try { body = body ? JSON.parse(body) : null; } catch { /* Keep the HTTP body for diagnostics. */ }
  return { http: Number(raw.slice(split + 1)), body };
}
function requireHttp(response, http, label) {
  if (response.http !== http) throw new Error(`${label}: HTTP ${response.http}, expected ${http}`);
  return response.body;
}
const get = (path, role) => call('GET', path, role);
const post = (path, role, data) => call('POST', path, role, data);
const table = () => requireHttp(get(`/api/v1/tables/${own.tableId}`, 'waiter'), 200, 'table');
const order = () => requireHttp(get(`/api/v1/orders/${own.orderId}`, 'cashier'), 200, 'order');
function version() {
  const body = requireHttp(get('/version'), 200, 'version');
  if (body.environment !== 'staging') throw new Error('Wrong environment');
  return body.commit;
}
function cleanup() {
  if (!own.sessionId) return true;
  const currentTable = table();
  if (currentTable.current_session?.id !== own.sessionId)
    throw new Error('CLEANUP REQUIRED: owned session changed');
  if (own.token) {
    const path = `/api/v1/public/qr/${encodeURIComponent(own.token)}`;
    if ([200, 410].includes(get(path).http))
      requireHttp(call('DELETE', `/api/v1/tables/${own.tableId}/qr-session`, 'admin'),
        204, 'cleanup revoke QR');
    if (get(path).http !== 401)
      throw new Error('CLEANUP REQUIRED: owned QR token still usable');
  }
  const ids = [...new Set((currentTable.orders || [])
    .filter(row => row.table_session_id === own.sessionId).map(row => row.id))];
  if (ids.length > 1 || ids.some(id => own.orderId && id !== own.orderId))
    throw new Error('CLEANUP REQUIRED: unexpected order in owned session');
  own.orderId ||= ids[0] || requireHttp(post('/api/v1/orders', 'waiter',
    { table_session_id: own.sessionId }), 201, 'cleanup order').id;
  let current = order();
  if (current.table_session_id !== own.sessionId)
    throw new Error('CLEANUP REQUIRED: order/session mismatch');
  if (!current.items.length) {
    requireHttp(post(`/api/v1/orders/${own.orderId}/items`, 'waiter',
      { items: [{ menu_item_id: own.menuId, quantity: 1, note: 'PF-P2-QR-007 owned cleanup' }] }),
    201, 'cleanup add item');
    current = order();
  }
  if (current.status === 'NEW')
    requireHttp(post(`/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  for (const item of order().items) {
    for (const [state, action, role] of [
      ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
      ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
    ]) {
      if (order().items.find(row => row.id === item.id)?.status === state)
        requireHttp(post(`/api/v1/orders/${own.orderId}/items/${item.id}/${action}`, role),
          200, `cleanup ${action}`);
    }
  }
  if (order().items.some(item => item.status !== 'SERVED'))
    throw new Error('CLEANUP REQUIRED: item not served');
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
    requireHttp(post(`/api/v1/orders/${own.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (order().status === 'BILLING')
    requireHttp(post(`/api/v1/orders/${own.orderId}/pay`, 'cashier'), 200, 'cleanup pay');
  if (order().status === 'PAID')
    requireHttp(post(`/api/v1/orders/${own.orderId}/close`, 'cashier'), 200, 'cleanup close');
  if (table().status === 'CLEANING')
    requireHttp(post(`/api/v1/tables/${own.tableId}/mark-clean`, 'waiter'), 200, 'cleanup clean');
  const finalTable = table();
  const activeTickets = requireHttp(get('/api/v1/kitchen/queue', 'kitchen'),
    200, 'cleanup queue').filter(row => row.order_id === own.orderId);
  report.cleanup_state = {
    order_closed: order().status === 'CLOSED',
    table_available: finalTable.status === 'AVAILABLE' && !finalTable.current_session,
    no_active_ticket: activeTickets.length === 0,
  };
  if (!Object.values(report.cleanup_state).every(Boolean))
    throw new Error('CLEANUP REQUIRED: table/order not closed');
  return true;
}

let before, failure, cleanupError;
try {
  before = version();
  if (before !== expected) throw new Error('PENDING_BUILD: staging differs from pinned SHA');
  report.staging_commit = before;
  for (const [role, name, expectedRole] of [
    ['admin', 'qa3_admin', 'SUPERVISOR'], ['waiter', 'qa3_waiter', 'WAITER'],
    ['cashier', 'qa3_cashier', 'CASHIER'], ['kitchen', 'qa3_kitchen', 'KITCHEN'],
  ]) {
    const login = requireHttp(post('/api/v1/auth/login', null,
      { username: name, password: pin }), 200, `${role} login`);
    if (login.staff?.role !== expectedRole || !login.access_token)
      throw new Error(`PENDING_FIXTURE: ${role} role missing`);
    roles[role] = login.access_token;
  }
  const tables = requireHttp(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const source = tables.find(row => row.code === 'Q3-3');
  if (!source || source.status !== 'AVAILABLE')
    throw new Error('PENDING_FIXTURE: Q3-3 must be AVAILABLE');
  own.tableId = source.id;
  const menu = requireHttp(get('/api/v1/menu?available_only=true', 'waiter'), 200, 'menu');
  own.menuId = menu.find(item => item.is_available && item.station_id && !item.has_modifiers)?.id;
  if (!own.menuId) throw new Error('PENDING_FIXTURE: mapped menu item required');
  own.sessionId = requireHttp(post(`/api/v1/tables/${own.tableId}/open-session`, 'waiter',
    { guest_count: 1 }), 201, 'open session').id;
  const invalid = `invalid-${randomUUID()}`;
  const invalidHttp = {
    info: get(`/api/v1/public/qr/${invalid}`).http,
    menu: get(`/api/v1/public/qr/${invalid}/menu`).http,
    order: get(`/api/v1/public/qr/${invalid}/order`).http,
    submit: post(`/api/v1/public/qr/${invalid}/orders`, null,
      { items: [{ menu_item_id: own.menuId, quantity: 1 }] }).http,
    oversized: get(`/api/v1/public/qr/${'x'.repeat(256)}`).http,
  };
  report.checks.invalid_token_denied =
    ['info', 'menu', 'order', 'submit'].every(key => invalidHttp[key] === 401) &&
    invalidHttp.oversized === 422;
  report.invalid_http = invalidHttp;
  if (!report.checks.invalid_token_denied)
    throw new Error('Invalid token access mismatch');
  const issued = requireHttp(post(`/api/v1/tables/${own.tableId}/qr-session`, 'admin'),
    201, 'issue QR');
  own.token = issued.token;
  if (!own.token || issued.table_session_id !== own.sessionId)
    throw new Error('PENDING_FIXTURE: issued token/session mismatch');
  const prefix = `/api/v1/public/qr/${encodeURIComponent(own.token)}`;
  requireHttp(get(prefix), 200, 'owned token before revoke');
  requireHttp(call('DELETE', `/api/v1/tables/${own.tableId}/qr-session`, 'admin'),
    204, 'revoke owned token');
  const outcomes = [
    ['info', get(prefix).http], ['menu', get(prefix + '/menu').http],
    ['order', get(prefix + '/order').http],
    ['submit', post(prefix + '/orders', null,
      { items: [{ menu_item_id: own.menuId, quantity: 1 }] }).http],
  ];
  const after = table();
  const ownOrders = (after.orders || []).filter(row => row.table_session_id === own.sessionId);
  report.checks.revoked_reads_401 =
    outcomes.slice(0, 3).every(([, http]) => http === 401);
  report.checks.revoked_submit_401 = outcomes[3][1] === 401;
  report.checks.no_customer_order = ownOrders.length === 0;
  report.checks.session_unchanged = after.current_session?.id === own.sessionId;
  report.revoked_http = Object.fromEntries(outcomes);
  if (!Object.values(report.checks).every(Boolean))
    throw new Error('Revoked-token access or order isolation mismatch');
  // A new key after revoke issues a new token on the same owned session.
  const expiring = requireHttp(post(`/api/v1/tables/${own.tableId}/qr-session`, 'admin'),
    201, 'issue QR for natural expiry');
  own.token = expiring.token;
  if (!own.token || expiring.table_session_id !== own.sessionId)
    throw new Error('PENDING_FIXTURE: expiring token/session mismatch');
  const expiry = Date.parse(expiring.expires_at);
  const remaining = expiry - Date.now();
  if (!Number.isFinite(expiry) || remaining < 1_000 || remaining > 4 * 60 * 60_000 + 90_000)
    throw new Error('PENDING_CONTRACT: QR expiry outside four-hour TTL');
  const expiringPath = `/api/v1/public/qr/${encodeURIComponent(own.token)}`;
  requireHttp(get(expiringPath), 200, 'QR valid before natural expiry');
  report.expires_at = expiring.expires_at;
  report.wait_ms = remaining + 1_500;
  console.log('[P2-QR-007] Owned Q3-3 QR remains open until expiry; keep this terminal running.');
  const waited = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(true), remaining + 1_500);
    const stop = () => { clearTimeout(timer); resolve(false); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  if (!waited) throw new Error('PENDING_INTERRUPTED: expiry wait interrupted; cleanup follows');
  if (version() !== before) throw new Error('PENDING_BUILD: staging changed during expiry wait');
  const expiredHttp = {
    info: get(expiringPath).http,
    menu: get(expiringPath + '/menu').http,
    order: get(expiringPath + '/order').http,
    submit: post(expiringPath + '/orders', null,
      { items: [{ menu_item_id: own.menuId, quantity: 1 }] }).http,
  };
  report.expired_http = expiredHttp;
  report.checks.expired_token_410 =
    Object.values(expiredHttp).every(http => http === 410);
  const expiredTable = table();
  report.checks.expired_no_order_or_session_change =
    expiredTable.current_session?.id === own.sessionId &&
    !(expiredTable.orders || []).some(row => row.table_session_id === own.sessionId);
  if (!Object.values(report.checks).every(Boolean))
    throw new Error('Expired token access/order isolation mismatch');
} catch (error) { failure = redact(error); }
try { report.cleanup_pass = cleanup(); }
catch (error) { cleanupError = redact(error); }
try { report.build_after = version(); } catch { report.build_after = null; }
report.build_stable = before === report.build_after;
report.result = !failure && !cleanupError && report.cleanup_pass && report.build_stable ?
  'PASSED' : cleanupError ? 'INCONCLUSIVE' : failure?.startsWith('PENDING_') ?
  'PENDING' : 'FAILED';
if (failure) report.error = failure;
if (cleanupError) report.cleanup_required = cleanupError;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('[P2-QR-007] Result: ' + JSON.stringify(report));
if (report.result !== 'PASSED') process.exitCode = 1;
