// P2-PAY-001: pay the full QA3 bill once via Payment v2 CASH and restore table.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_pay_001_cash_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = { code: 'Q3-1', tableId: null, sessionId: null, orderId: null,
  itemId: null, ticketId: null, menuId: null };
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
const table = () => must(get(`/api/v1/tables/${owned.tableId}`, 'waiter'), 200, 'table');
const order = () => must(get(`/api/v1/orders/${owned.orderId}`, 'cashier'), 200, 'order');
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => x.order_id === owned.orderId);
}
function finishOrder() {
  let current = order();
  if (current.table_session_id !== owned.sessionId)
    throw new Error('CLEANUP REQUIRED: order session changed');
  if (current.status === 'CLOSED') return;
  if (!current.items.length) {
    must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
      { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2PAY001 cleanup' }] }), 201, 'cleanup add');
    current = order();
  }
  if (current.items.some(x => x.status === 'CREATED'))
    must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  for (const item of order().items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order().items.find(x => x.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${owned.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order().items.find(x => x.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'cleanup remaining cash');
  if (order().status !== 'CLOSED')
    must(post(`/api/v1/orders/${owned.orderId}/close`, 'cashier'), 200, 'cleanup close');
}
function cleanup() {
  if (!owned.sessionId) return false;
  if (!owned.orderId) {
    const rows = (table().orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.orderId = rows[0].id;
    else if (!rows.length) owned.orderId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: owned.sessionId }), 201, 'cleanup create').id;
    else throw new Error('CLEANUP REQUIRED: order ownership ambiguous');
  }
  finishOrder();
  if (table().status === 'CLEANING')
    must(post(`/api/v1/tables/${owned.tableId}/mark-clean`, 'waiter'), 200, 'mark clean');
  const finalTable = table(), finalOrder = order();
  if (finalTable.status !== 'AVAILABLE' || finalTable.current_session ||
    finalOrder.status !== 'CLOSED' || finalOrder.items.some(x => x.status !== 'SERVED') ||
    queue('DONE').length !== finalOrder.items.length || queue().length)
    throw new Error('CLEANUP REQUIRED: final payment fixture mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2PAY001',
  test_ref: 'P2-PAY-001', checked_at: new Date().toISOString(),
  scope: 'QA3 Payment v2 full CASH amount against isolated order, exact ledger and table lifecycle; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, executed = false, asserted = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/orders/{order_id}/payments']?.post ||
    !spec.paths?.['/api/v1/orders/{order_id}/payments']?.get)
    throw new Error('PENDING_CONTRACT: Payment v2 CASH endpoint absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token)
      throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const matches = tables.filter(x => x.code === owned.code && x.status === 'AVAILABLE');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  owned.menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  if (matches.length !== 1 || !owned.menuId)
    throw new Error('PENDING_FIXTURE: Q3-1 AVAILABLE and mapped menu item required');
  owned.tableId = matches[0].id;
  owned.sessionId = must(post(`/api/v1/tables/${owned.tableId}/open-session`, 'waiter',
    { guest_count: 1 }), 201, 'open QA3 table').id;
  owned.orderId = must(post('/api/v1/orders', 'cashier',
    { table_session_id: owned.sessionId }), 201, 'create order').id;
  const added = must(post(`/api/v1/orders/${owned.orderId}/items`, 'cashier',
    { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2PAY001 CASH' }] }), 201, 'add item');
  owned.itemId = added.items?.find(x => x.note === 'QA P2PAY001 CASH')?.id;
  if (!owned.itemId) throw new Error('PENDING_FIXTURE: owned item unavailable');
  must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'send to kitchen');
  const tickets = queue();
  if (tickets.length !== 1 || tickets[0].order_item_id !== owned.itemId)
    throw new Error('PENDING_FIXTURE: one kitchen ticket required');
  owned.ticketId = tickets[0].id;
  finishCooking();
  const before = order();
  const cents = Math.round(Number(before.total) * 100);
  if (before.status !== 'SERVED' || !Number.isSafeInteger(cents) || cents <= 0)
    throw new Error('PENDING_FIXTURE: served positive bill required');
  must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'request billing');
  const billing = order();
  if (billing.status !== 'BILLING' || Math.round(Number(billing.amount_due) * 100) !== cents)
    throw new Error('PENDING_FIXTURE: unpaid bill amount mismatch');
  executed = true;
  const amount = (cents / 100).toFixed(2);
  const recorded = must(post(`/api/v1/orders/${owned.orderId}/payments`, 'cashier',
    { method: 'CASH', amount, cash_received: amount }), 201, 'record full cash');
  const detail = order();
  const payments = must(get(`/api/v1/orders/${owned.orderId}/payments`, 'cashier'), 200, 'payment ledger');
  const paidTable = table();
  const paidAudit = must(get(`/api/v1/audit-logs?action=ORDER_PAID&entity_id=${owned.orderId}`,
    'admin'), 200, 'paid audit');
  const paymentAudit = must(get(`/api/v1/audit-logs?action=PAYMENT_RECORDED&entity_id=${owned.orderId}`,
    'admin'), 200, 'payment audit');
  const paymentId = recorded.payment?.id;
  report.checks = {
    payment_http_201: true,
    exact_cash_payment: recorded.payment?.method === 'CASH' &&
      recorded.payment?.status === 'SUCCEEDED' &&
      recorded.payment?.order_id === owned.orderId &&
      Math.round(Number(recorded.payment?.amount) * 100) === cents &&
      Math.round(Number(recorded.payment?.cash_received) * 100) === cents &&
      Number(recorded.payment?.change_due) === 0,
    one_payment_in_ledger: !!paymentId && payments.payments?.length === 1 &&
      payments.payments[0].id === paymentId && payments.payments[0].status === 'SUCCEEDED',
    full_balance_settled: recorded.order_status === 'PAID' && detail.status === 'PAID' &&
      payments.order_status === 'PAID' &&
      Math.round(Number(payments.summary?.total) * 100) === cents &&
      Math.round(Number(payments.summary?.paid) * 100) === cents &&
      Number(payments.summary?.remaining) === 0 && Number(detail.amount_due) === 0,
    table_cleaning: paidTable.status === 'CLEANING' && !paidTable.current_session,
    audit_exact: paidAudit.filter(x => x.action === 'ORDER_PAID' && x.entity_id === owned.orderId).length === 1 &&
      paymentAudit.filter(x => x.action === 'PAYMENT_RECORDED' && x.entity_id === owned.orderId &&
        x.payload?.payment_id === paymentId).length === 1,
  };
  report.table_code = owned.code; report.order_id = owned.orderId;
  report.payment_id = paymentId || null; report.expected_amount = amount;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Full CASH payment/ledger/table/audit mismatch');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.sessionId) try { cleanupPass = cleanup(); }
    catch (error) { failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.order_closed = cleanupPass; report.table_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.sessionId && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.sessionId)
    report.cleanup_required = `Inspect QA3 table Q3-1, session ${owned.sessionId}, order ${owned.orderId}; no global reset`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}

function finishCooking() {
  const id = owned.orderId;
  for (const item of order().items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order().items.find(x => x.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${id}/items/${item.id}/${action}`, role), 200, action);
    }
  }
}
