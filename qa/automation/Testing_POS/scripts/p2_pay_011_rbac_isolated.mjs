// P2-PAY-011: Waiter denied; Cashier and Supervisor each pay an independent QA3 bill.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_pay_011_rbac_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {}, staffIds = {};
let tableId, menuId, current = null;
function redact(value) {
  let safe = String(value).replaceAll(password, '<REDACTED>');
  for (const jwt of Object.values(roles)) safe = safe.replaceAll(jwt, '<REDACTED>');
  return safe;
}
function call(method, path, role, body) {
  const args = ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', '-X', method];
  if (role) args.push('-H', `Authorization: Bearer ${roles[role]}`);
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (method !== 'GET' && method !== 'HEAD') args.push('-H', `Idempotency-Key: ${randomUUID()}`);
  args.push(`${base}${path}`);
  const raw = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 3_000_000,
  });
  const split = raw.lastIndexOf('\n'), http = Number(raw.slice(split + 1)), value = raw.slice(0, split);
  let data;
  try { data = value ? JSON.parse(value) : null; } catch { data = value; }
  return { http, data };
}
function must(response, http, label) {
  if (response.http !== http) throw new Error(`${label} HTTP ${response.http}, expected ${http}`);
  return response.data;
}
const get = (path, role) => call('GET', path, role);
const post = (path, role, body) => call('POST', path, role, body);
const version = () => must(get('/version'), 200, 'version').commit;
const table = () => must(get(`/api/v1/tables/${tableId}`, 'waiter'), 200, 'table');
const order = () => must(get(`/api/v1/orders/${current.orderId}`, 'cashier'), 200, 'order');
const payments = () => must(get(`/api/v1/orders/${current.orderId}/payments`, 'cashier'), 200, 'payments');
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => x.order_id === current.orderId);
}
function finishItems() {
  for (const item of order().items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order().items.find(x => x.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${current.orderId}/items/${item.id}/${action}`, role), 200, action);
    }
  }
}
function cleanup() {
  if (!current?.sessionId) return true;
  if (!current.orderId) {
    const rows = (table().orders || []).filter(x => x.table_session_id === current.sessionId);
    if (rows.length === 1) current.orderId = rows[0].id;
    else if (!rows.length) current.orderId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: current.sessionId }), 201, 'cleanup create').id;
    else throw new Error('CLEANUP REQUIRED: order ownership ambiguous');
  }
  let o = order();
  if (o.table_session_id !== current.sessionId) throw new Error('CLEANUP REQUIRED: session mismatch');
  if (o.status !== 'CLOSED') {
    if (!o.items.length) {
      must(post(`/api/v1/orders/${current.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: menuId, quantity: 1, note: 'QA P2PAY011 cleanup' }] }), 201, 'cleanup add');
      o = order();
    }
    if (o.items.some(x => x.status === 'CREATED'))
      must(post(`/api/v1/orders/${current.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
    finishItems();
    if (order().items.some(x => x.status !== 'SERVED'))
      throw new Error('CLEANUP REQUIRED: unserved item');
    if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
      must(post(`/api/v1/orders/${current.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
    if (!['PAID', 'CLOSED'].includes(order().status))
      must(post(`/api/v1/orders/${current.orderId}/pay`, 'cashier'), 200, 'cleanup remaining cash');
    if (order().status !== 'CLOSED')
      must(post(`/api/v1/orders/${current.orderId}/close`, 'cashier'), 200, 'cleanup close');
  }
  if (table().status === 'CLEANING')
    must(post(`/api/v1/tables/${tableId}/mark-clean`, 'waiter'), 200, 'mark clean');
  const finalTable = table(), finalOrder = order();
  if (finalTable.status !== 'AVAILABLE' || finalTable.current_session ||
    finalOrder.status !== 'CLOSED' || finalOrder.items.some(x => x.status !== 'SERVED') ||
    queue('DONE').length !== finalOrder.items.length || queue().length)
    throw new Error('CLEANUP REQUIRED: final RBAC fixture mismatch');
  current = null;
  return true;
}
function createFixture(label) {
  if (table().status !== 'AVAILABLE' || table().current_session)
    throw new Error('PENDING_FIXTURE: Q3-1 unavailable');
  current = { label, sessionId: null, orderId: null };
  current.sessionId = must(post(`/api/v1/tables/${tableId}/open-session`, 'waiter',
    { guest_count: 1 }), 201, 'open QA3 table').id;
  current.orderId = must(post('/api/v1/orders', 'cashier',
    { table_session_id: current.sessionId }), 201, 'create order').id;
  const added = must(post(`/api/v1/orders/${current.orderId}/items`, 'cashier',
    { items: [{ menu_item_id: menuId, quantity: 1, note: `QA P2PAY011 ${label}` }] }), 201, 'add item');
  if (added.items?.length !== 1) throw new Error('PENDING_FIXTURE: single POS line required');
  must(post(`/api/v1/orders/${current.orderId}/send-to-kitchen`, 'waiter'), 200, 'send to kitchen');
  if (queue().length !== 1) throw new Error('PENDING_FIXTURE: single ticket required');
  finishItems();
  if (order().status !== 'SERVED') throw new Error('PENDING_FIXTURE: served bill required');
  must(post(`/api/v1/orders/${current.orderId}/request-billing`, 'waiter'), 200, 'request billing');
  const detail = order(), cents = Math.round(Number(detail.amount_due) * 100);
  if (detail.status !== 'BILLING' || !Number.isSafeInteger(cents) || cents <= 0)
    throw new Error('PENDING_FIXTURE: positive billing amount required');
  return { orderId: current.orderId, amount: (cents / 100).toFixed(2), cents };
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2PAY011',
  test_ref: 'P2-PAY-011', checked_at: new Date().toISOString(),
  scope: 'QA3 Payment v2 role guard: Waiter denied, Cashier and Supervisor each pay separate full CASH bills; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE', scenarios: [] };
let buildBefore, buildAfter, executed = false, asserted = false, cleanupPass = true, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/orders/{order_id}/payments']?.post)
    throw new Error('PENDING_CONTRACT: Payment v2 endpoint absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token)
      throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
    staffIds[name.slice(4)] = login.staff.id;
  }
  const matches = must(get('/api/v1/tables', 'waiter'), 200, 'tables')
    .filter(x => x.code === 'Q3-1' && x.status === 'AVAILABLE');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  if (matches.length !== 1 || !menuId)
    throw new Error('PENDING_FIXTURE: Q3-1 AVAILABLE and mapped menu item required');
  tableId = matches[0].id;
  for (const role of ['cashier', 'admin']) {
    const fixture = createFixture(role);
    executed = true;
    const payload = { method: 'CASH', amount: fixture.amount, cash_received: fixture.amount };
    const waiter = post(`/api/v1/orders/${fixture.orderId}/payments`, 'waiter', payload);
    const afterDenied = order(), deniedLedger = payments(), deniedTable = table();
    const deniedAudit = must(get(`/api/v1/audit-logs?action=PAYMENT_RECORDED&entity_id=${fixture.orderId}`,
      'admin'), 200, 'denied payment audit');
    const denied = waiter.http === 403 && afterDenied.status === 'BILLING' &&
      Math.round(Number(afterDenied.amount_due) * 100) === fixture.cents &&
      deniedLedger.payments?.length === 0 && deniedTable.status === 'BILLING' &&
      deniedAudit.length === 0;
    const scenario = { role: role === 'admin' ? 'SUPERVISOR' : 'CASHIER',
      order_id: fixture.orderId,
      waiter_http: waiter.http, waiter_denied_unchanged: denied, permitted_http: null,
      permitted_payment: false, cleanup_pass: false };
    report.scenarios.push(scenario);
    if (!denied) throw new Error('Waiter processed payment or mutated QA3 bill');
    const payment = post(`/api/v1/orders/${fixture.orderId}/payments`, role, payload);
    scenario.permitted_http = payment.http;
    scenario.payment_id = payment.data?.payment?.id || null;
    const ledger = payments(), paid = order(), paidTable = table();
    const audit = must(get(`/api/v1/audit-logs?action=PAYMENT_RECORDED&entity_id=${fixture.orderId}`,
      'admin'), 200, 'payment audit');
    scenario.permitted_payment = payment.http === 201 && payment.data?.order_status === 'PAID' &&
      payment.data?.payment?.created_by_staff_id === staffIds[role] &&
      paid.status === 'PAID' && paidTable.status === 'CLEANING' && !paidTable.current_session &&
      ledger.payments?.length === 1 &&
      ledger.payments[0].id === payment.data?.payment?.id &&
      Math.round(Number(ledger.summary?.paid) * 100) === fixture.cents &&
      Number(ledger.summary?.remaining) === 0 &&
      audit.filter(x => x.action === 'PAYMENT_RECORDED' && x.entity_id === fixture.orderId &&
        x.staff_id === staffIds[role] && x.payload?.payment_id === payment.data?.payment?.id).length === 1;
    if (!scenario.permitted_payment) throw new Error(`${scenario.role} payment/actor/ledger mismatch`);
    scenario.cleanup_pass = cleanup();
  }
  asserted = report.scenarios.length === 2 && report.scenarios.every(x =>
    x.waiter_denied_unchanged && x.permitted_payment && x.cleanup_pass);
} catch (error) { failure = redact(error.message || error); }
finally {
  if (current?.sessionId) try { cleanupPass = cleanup(); }
    catch (error) { cleanupPass = false; failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass && !current?.sessionId;
  report.tables_available = report.cleanup_pass; report.orders_closed = report.cleanup_pass;
  report.result = asserted && report.cleanup_pass && report.build_stable ? 'PASSED' :
    !report.cleanup_pass ? 'INCONCLUSIVE' : /^PENDING_/.test(failure || '') ? 'PENDING' :
    executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (current?.sessionId)
    report.cleanup_required = `Inspect QA3 table Q3-1, session ${current.sessionId}, order ${current.orderId}; no global reset`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
