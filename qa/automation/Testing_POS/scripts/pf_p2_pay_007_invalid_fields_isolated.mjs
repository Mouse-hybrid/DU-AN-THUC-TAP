// PF-P2-PAY-007: negative payment fields; full business case awaits amount contract decision.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/pf_p2_pay_007_invalid_fields_isolated.mjs OUTPUT.json'); process.exit(2); }
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
      { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA PFP2PAY007 cleanup' }] }), 201, 'cleanup add');
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

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-PFP2PAY007',
  test_ref: 'PF-P2-PAY-007', checked_at: new Date().toISOString(),
  scope: 'QA3 Payment v2 negative amount=0 and unknown method: atomic rejection only; missing amount branch not executed; UI not tested',
  business_case: 'P2-PAY-007 PENDING_CONTRACT: missing amount is permitted by the current Payment v2 API',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, executed = false, asserted = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/orders/{order_id}/payments']?.post ||
    !spec.paths?.['/api/v1/orders/{order_id}/payments']?.get)
    throw new Error('PENDING_CONTRACT: Payment v2 CASH endpoint absent');
  const paymentSchema = spec.components?.schemas?.CreatePaymentRequest;
  report.contract_observation = {
    missing_amount_allowed: !!paymentSchema?.properties?.amount &&
      !paymentSchema.required?.includes('amount'),
  };
  if (!report.contract_observation.missing_amount_allowed)
    report.business_case = 'P2-PAY-007 NOT_EXECUTED: missing amount branch not covered by this preflight';
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
    { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA PFP2PAY007 negative' }] }), 201, 'add item');
  owned.itemId = added.items?.find(x => x.note === 'QA PFP2PAY007 negative')?.id;
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
  const zero = post(`/api/v1/orders/${owned.orderId}/payments`, 'cashier',
    { method: 'CASH', amount: '0', cash_received: amount });
  const unknown = post(`/api/v1/orders/${owned.orderId}/payments`, 'cashier',
    { method: 'UNKNOWN', amount });
  const after = order();
  const ledger = must(get(`/api/v1/orders/${owned.orderId}/payments`, 'cashier'), 200, 'payment ledger');
  const afterTable = table();
  const paymentAudit = must(get(`/api/v1/audit-logs?action=PAYMENT_RECORDED&entity_id=${owned.orderId}`,
    'admin'), 200, 'payment audit');
  report.http = { amount_zero: zero.http, method_unknown: unknown.http };
  report.checks = {
    amount_zero_rejected: zero.http === 422,
    unknown_method_rejected: unknown.http === 422,
    bill_unchanged: after.status === 'BILLING' &&
      after.current_version === billing.current_version &&
      Math.round(Number(after.amount_due) * 100) === cents &&
      afterTable.status === 'BILLING' && afterTable.current_session?.id === owned.sessionId,
    no_payment_or_audit: ledger.payments?.length === 0 &&
      Number(ledger.summary?.paid) === 0 && paymentAudit.length === 0,
  };
  report.table_code = owned.code; report.order_id = owned.orderId;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Negative amount/method rejected or atomicity mismatch');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.sessionId) try { cleanupPass = cleanup(); }
    catch (error) { failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'PARTIAL_NEGATIVE_ONLY' : 'NOT_EXECUTED';
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
