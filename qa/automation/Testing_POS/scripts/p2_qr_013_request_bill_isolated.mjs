// P2-QR-013: QA3 DIRECT customer requests billing through an owned QR token.
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
const own = { tableId: null, otherTableId: null, sessionId: null,
  orderId: null, menuId: null, token: null };
const report = {
  run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-P2QR013`,
  test_ref: 'P2-QR-013', checked_at: new Date().toISOString(),
  scope: 'QA3 DIRECT: public QR submits one item and requests bill for its own session; further customer submit rejected; Q3-2 unchanged, audit and owned cleanup checked. CONFIRM excluded.',
  token_recorded: false, secrets_recorded: false, checks: {}, cleanup_pass: false,
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
  try { body = body ? JSON.parse(body) : null; } catch { /* Keep error body for diagnostics. */ }
  return { http: Number(raw.slice(split + 1)), body };
}
function requireHttp(response, http, label) {
  if (response.http !== http) throw new Error(`${label}: HTTP ${response.http}, expected ${http}`);
  return response.body;
}
const get = (path, role) => call('GET', path, role);
const post = (path, role, body) => call('POST', path, role, body);
const table = id => requireHttp(get(`/api/v1/tables/${id}`, 'waiter'), 200, 'table');
const order = () => requireHttp(get(`/api/v1/orders/${own.orderId}`, 'cashier'), 200, 'order');
const ledger = () => requireHttp(get(`/api/v1/orders/${own.orderId}/payments`, 'cashier'), 200, 'ledger');
function queue() {
  const rows = requireHttp(get('/api/v1/kitchen/queue', 'kitchen'), 200, 'queue');
  return rows.filter(row => row.order_id === own.orderId);
}
function version() {
  const body = requireHttp(get('/version'), 200, 'version');
  if (body.environment !== 'staging') throw new Error('Wrong environment');
  return body.commit;
}
function cleanup() {
  if (!own.sessionId) return true;
  const t = table(own.tableId);
  if (t.current_session?.id !== own.sessionId)
    throw new Error('CLEANUP REQUIRED: owned session changed');
  const ids = [...new Set((t.orders || [])
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
      { items: [{ menu_item_id: own.menuId, quantity: 1,
        note: 'P2-QR-013 owned cleanup' }] }), 201, 'cleanup item');
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
        requireHttp(post(`/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,
          role), 200, `cleanup ${action}`);
    }
  }
  if (order().items.some(item => item.status !== 'SERVED'))
    throw new Error('CLEANUP REQUIRED: item not served');
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
    requireHttp(post(`/api/v1/orders/${own.orderId}/request-billing`, 'waiter'),
      200, 'cleanup billing');
  if (order().status === 'BILLING')
    requireHttp(post(`/api/v1/orders/${own.orderId}/pay`, 'cashier'), 200, 'cleanup pay');
  if (order().status === 'PAID')
    requireHttp(post(`/api/v1/orders/${own.orderId}/close`, 'cashier'), 200, 'cleanup close');
  if (table(own.tableId).status === 'CLEANING')
    requireHttp(post(`/api/v1/tables/${own.tableId}/mark-clean`, 'waiter'),
      200, 'cleanup mark clean');
  const finalTable = table(own.tableId);
  report.cleanup_state = {
    order_closed: order().status === 'CLOSED',
    table_available: finalTable.status === 'AVAILABLE' && !finalTable.current_session,
    no_active_ticket: queue().length === 0,
  };
  if (!Object.values(report.cleanup_state).every(Boolean))
    throw new Error('CLEANUP REQUIRED: final fixture mismatch');
  return true;
}

let before, failure, cleanupError;
try {
  before = version();
  if (before !== expected) throw new Error('PENDING_BUILD: staging differs from pinned SHA');
  report.staging_commit = before;
  const spec = requireHttp(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/public/qr/{token}/request-bill']?.post)
    throw new Error('PENDING_CONTRACT: public request-bill endpoint missing');
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
  const source = tables.find(row => row.code === 'Q3-1');
  const other = tables.find(row => row.code === 'Q3-2');
  if (!source || !other || source.status !== 'AVAILABLE' || other.status !== 'AVAILABLE')
    throw new Error('PENDING_FIXTURE: Q3-1 and Q3-2 must be AVAILABLE');
  own.tableId = source.id; own.otherTableId = other.id;
  const otherBefore = table(own.otherTableId);
  const menu = requireHttp(get('/api/v1/menu?available_only=true', 'waiter'), 200, 'menu');
  own.menuId = menu.find(item => item.is_available && item.station_id && !item.has_modifiers)?.id;
  if (!own.menuId) throw new Error('PENDING_FIXTURE: mapped menu item required');
  own.sessionId = requireHttp(post(`/api/v1/tables/${own.tableId}/open-session`, 'waiter',
    { guest_count: 1 }), 201, 'open session').id;
  const issued = requireHttp(post(`/api/v1/tables/${own.tableId}/qr-session`, 'admin'),
    201, 'issue QR');
  own.token = issued.token;
  if (!own.token || issued.table_session_id !== own.sessionId)
    throw new Error('PENDING_FIXTURE: QR token/session mismatch');
  const prefix = `/api/v1/public/qr/${encodeURIComponent(own.token)}`;
  const info = requireHttp(get(prefix), 200, 'public QR info');
  if (info.send_mode !== 'DIRECT') throw new Error('PENDING_FIXTURE: QA3 DIRECT mode required');
  requireHttp(post(prefix + '/orders', null,
    { items: [{ menu_item_id: own.menuId, quantity: 1,
      note: 'P2-QR-013 QA3 owned' }] }), 201, 'customer submit');
  const ownedOrders = (table(own.tableId).orders || [])
    .filter(row => row.table_session_id === own.sessionId);
  if (ownedOrders.length !== 1)
    throw new Error('CLEANUP REQUIRED: expected exactly one owned order');
  own.orderId = ownedOrders[0].id;
  const beforeBill = order();
  const beforeTickets = queue();
  const beforeLedger = ledger();
  const requested = post(prefix + '/request-bill', null);
  const afterBill = order();
  const afterTable = table(own.tableId);
  const afterTickets = queue();
  const denied = post(prefix + '/orders', null,
    { items: [{ menu_item_id: own.menuId, quantity: 1 }] });
  const finalOrder = order();
  const afterLedger = ledger();
  const audit = requireHttp(get(`/api/v1/audit-logs?order_id=${own.orderId}&limit=100`,
    'admin'), 200, 'order audit');
  const otherAfter = table(own.otherTableId);
  const sameOther = row => JSON.stringify({ status: row.status,
    current_session: row.current_session, orders: row.orders });
  const stableTickets = rows => JSON.stringify(rows.map(row => ({
    id: row.id, order_id: row.order_id, order_item_id: row.order_item_id,
    station_id: row.station_id, status: row.status,
  })).sort((a, b) => a.id.localeCompare(b.id)));
  report.checks = {
    one_direct_item_before_bill: beforeBill.status === 'SENT' &&
      beforeBill.table_session_id === own.sessionId && beforeBill.items.length === 1 &&
      beforeBill.items[0].source === 'QR' && beforeTickets.length === 1,
    customer_request_bill_200: requested.http === 200,
    own_session_billing: afterBill.status === 'BILLING' &&
      afterTable.status === 'BILLING' && afterTable.current_session?.id === own.sessionId,
    further_customer_submit_409: denied.http === 409 &&
      finalOrder.items.length === 1 && finalOrder.status === 'BILLING',
    ticket_unchanged: stableTickets(afterTickets) === stableTickets(beforeTickets),
    no_payment_recorded: beforeLedger.order_status === 'SENT' &&
      afterLedger.order_status === 'BILLING' &&
      JSON.stringify(afterLedger.payments) === JSON.stringify(beforeLedger.payments) &&
      beforeLedger.payments.length === 0 &&
      Number(afterLedger.summary.total) === Number(beforeLedger.summary.total) &&
      Number(afterLedger.summary.paid) === Number(beforeLedger.summary.paid) &&
      Number(afterLedger.summary.pending) === Number(beforeLedger.summary.pending) &&
      Number(afterLedger.summary.remaining) === Number(beforeLedger.summary.remaining),
    qr_billing_audit_once: audit.filter(row => row.action === 'ORDER_BILLING_REQUESTED' &&
      row.entity_id === own.orderId && row.payload?.source === 'QR').length === 1,
    other_table_unchanged: sameOther(otherBefore) === sameOther(otherAfter),
  };
  report.http = { request_bill: requested.http, further_submit: denied.http };
  report.payment_counts = { before: beforeLedger.payments.length,
    after: afterLedger.payments.length };
  report.order_id = own.orderId;
  report.table_codes = ['Q3-1', 'Q3-2'];
  if (!Object.values(report.checks).every(Boolean))
    throw new Error('QR request-bill/session/audit isolation mismatch');
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
console.log('[P2-QR-013] Result: ' + JSON.stringify(report));
if (report.result !== 'PASSED') process.exitCode = 1;
