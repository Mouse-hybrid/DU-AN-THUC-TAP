// P2-TBL-008: deny merging a QA3 secondary table while BILLING or CLEANING.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_008_merge_billing_cleaning_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = {
  primary: { code: 'Q3-1', tableId: null, sessionId: null, orderId: null },
  secondary: { code: 'Q3-2', tableId: null, sessionId: null, orderId: null },
  menuId: null,
};
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
  const split = raw.lastIndexOf('\n'), http = Number(raw.slice(split + 1)), text = raw.slice(0, split);
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { http, data };
}
function must(response, http, label) {
  if (response.http !== http) throw new Error(`${label} HTTP ${response.http}, expected ${http}`);
  return response.data;
}
const get = (path, role) => call('GET', path, role);
const post = (path, role, body) => call('POST', path, role, body);
const version = () => must(get('/version'), 200, 'version').commit;
const table = x => must(get(`/api/v1/tables/${x.tableId}`, 'waiter'), 200, `${x.code} table`);
const order = x => must(get(`/api/v1/orders/${x.orderId}`, 'cashier'), 200, `${x.code} order`);
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => [owned.primary.orderId, owned.secondary.orderId].includes(x.order_id));
}
function finishOrder(x) {
  if (!x.sessionId) return;
  if (!x.orderId) {
    const t = table(x);
    if (t.current_session?.id !== x.sessionId) throw new Error(`CLEANUP REQUIRED: ${x.code} session moved`);
    const rows = (t.orders || []).filter(o => o.table_session_id === x.sessionId);
    if (rows.length === 1) x.orderId = rows[0].id;
    else if (!rows.length) x.orderId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: x.sessionId }), 201, 'cleanup create').id;
  }
  if (!x.orderId) throw new Error(`CLEANUP REQUIRED: ${x.code} order not uniquely identified`);
  let o = order(x);
  if (o.status === 'CLOSED' && !o.items.length) return; // Source order was folded into master.
  if (o.status === 'NEW') {
    if (!o.items?.length) {
      if (!owned.menuId) throw new Error('CLEANUP REQUIRED: mapped menu unavailable');
      must(post(`/api/v1/orders/${x.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL008 cleanup' }] }), 201, 'cleanup add');
    }
    must(post(`/api/v1/orders/${x.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  }
  o = order(x);
  for (const item of o.items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order(x).items.find(i => i.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${x.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order(x).items.find(i => i.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: ${x.code} item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order(x).status))
    must(post(`/api/v1/orders/${x.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order(x).status))
    must(post(`/api/v1/orders/${x.orderId}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order(x).status !== 'CLOSED')
    must(post(`/api/v1/orders/${x.orderId}/close`, 'cashier'), 200, 'cleanup close');
}
function cleanup() {
  if (!owned.primary.sessionId && !owned.secondary.sessionId) return false;
  // Complete secondary first; paying the primary releases any secondary left MERGED.
  finishOrder(owned.secondary);
  finishOrder(owned.primary);
  for (const x of [owned.primary, owned.secondary]) {
    const t = table(x);
    if (t.status === 'CLEANING') must(post(`/api/v1/tables/${x.tableId}/mark-clean`, 'waiter'), 200, `clean ${x.code}`);
  }
  const first = table(owned.primary), second = table(owned.secondary);
  const orders = [owned.primary, owned.secondary].filter(x => x.orderId).map(x => order(x));
  if (first.status !== 'AVAILABLE' || second.status !== 'AVAILABLE' ||
    first.current_session || second.current_session || second.merged_into_table_id ||
    orders.some(o => o.status !== 'CLOSED' || o.items.some(i => i.status !== 'SERVED')) ||
    queue('DONE').length !== orders.reduce((n, o) => n + o.items.length, 0) || queue().length)
    throw new Error('CLEANUP REQUIRED: final table/order/queue mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL008',
  test_ref: 'P2-TBL-008', checked_at: new Date().toISOString(),
  scope: 'QA3 API merge rejects BILLING and CLEANING secondary table; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, executed = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/merge']?.post)
    throw new Error('PENDING_CONTRACT: table merge absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'], ['qa3_kitchen', 'KITCHEN']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  owned.menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  for (const x of [owned.primary, owned.secondary]) {
    const matches = tables.filter(t => t.code === x.code && t.status === 'AVAILABLE');
    if (matches.length !== 1 || !owned.menuId)
      throw new Error('PENDING_FIXTURE: Q3-1/Q3-2 both AVAILABLE and mapped menu item required');
    x.tableId = matches[0].id;
  }
  for (const x of [owned.primary, owned.secondary]) {
    x.sessionId = must(post(`/api/v1/tables/${x.tableId}/open-session`, 'waiter',
      { guest_count: 1 }), 201, `open ${x.code}`).id;
    x.orderId = must(post('/api/v1/orders', 'cashier',
      { table_session_id: x.sessionId }), 201, `create ${x.code} order`).id;
    must(post(`/api/v1/orders/${x.orderId}/items`, 'cashier',
      { items: [{ menu_item_id: owned.menuId, quantity: 1, note: `QA P2TBL008 ${x.code}` }] }), 201, `add ${x.code} item`);
    must(post(`/api/v1/orders/${x.orderId}/send-to-kitchen`, 'waiter'), 200, `send ${x.code} ticket`);
  }
  const secondItem = order(owned.secondary).items[0]?.id;
  if (!secondItem || queue().length !== 2) throw new Error('PENDING_FIXTURE: two own tickets unavailable');
  for (const [action, role] of [['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
    ['pickup', 'waiter'], ['served', 'waiter']])
    must(post(`/api/v1/orders/${owned.secondary.orderId}/items/${secondItem}/${action}`, role), 200, action);
  must(post(`/api/v1/orders/${owned.secondary.orderId}/request-billing`, 'waiter'), 200, 'secondary billing');
  const path = `/api/v1/tables/${owned.primary.tableId}/merge`;
  const body = { table_ids: [owned.secondary.tableId] };
  const primaryBefore = order(owned.primary), secondaryBefore = order(owned.secondary);
  if (table(owned.secondary).status !== 'BILLING' || table(owned.primary).status !== 'OCCUPIED')
    throw new Error('PENDING_FIXTURE: BILLING secondary state unavailable');
  executed = true;
  const billingAttempt = post(path, 'waiter', body);
  const billingCheck = billingAttempt.http === 409 &&
    table(owned.primary).current_session?.id === owned.primary.sessionId &&
    table(owned.secondary).current_session?.id === owned.secondary.sessionId &&
    table(owned.secondary).status === 'BILLING' &&
    order(owned.primary).items[0]?.id === primaryBefore.items[0]?.id &&
    order(owned.secondary).items[0]?.id === secondaryBefore.items[0]?.id;
  report.http = { billing_merge: billingAttempt.http };
  report.checks = { billing_rejected_without_mutation: billingCheck };
  if (!billingCheck) throw new Error('Merge with BILLING table accepted or changed fixture');
  must(post(`/api/v1/orders/${owned.secondary.orderId}/pay`, 'cashier'), 200, 'secondary simulated pay');
  const paid = order(owned.secondary);
  if (table(owned.secondary).status !== 'CLEANING' || paid.status !== 'PAID')
    throw new Error('PENDING_FIXTURE: CLEANING secondary state unavailable');
  const cleaningAttempt = post(path, 'waiter', body);
  const cleaningCheck = cleaningAttempt.http === 409 &&
    table(owned.primary).current_session?.id === owned.primary.sessionId &&
    !table(owned.secondary).current_session && table(owned.secondary).status === 'CLEANING' &&
    order(owned.secondary).id === paid.id && order(owned.secondary).status === 'PAID';
  report.http.cleaning_merge = cleaningAttempt.http;
  report.checks.cleaning_rejected_without_mutation = cleaningCheck;
  report.primary_table = owned.primary.code; report.secondary_table = owned.secondary.code;
  report.primary_order_id = owned.primary.orderId; report.secondary_order_id = owned.secondary.orderId;
  if (!cleaningCheck) throw new Error('Merge with CLEANING table accepted or changed fixture');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.primary.sessionId || owned.secondary.sessionId)
    try { cleanupPass = cleanup(); }
    catch (error) { failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.orders_closed = cleanupPass; report.tables_available = cleanupPass;
  report.result = executed && report.checks?.billing_rejected_without_mutation &&
    report.checks?.cleaning_rejected_without_mutation && cleanupPass && report.build_stable ? 'PASSED' :
    (owned.primary.sessionId || owned.secondary.sessionId) && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && (owned.primary.sessionId || owned.secondary.sessionId))
    report.cleanup_required = `Inspect QA3 sessions ${owned.primary.sessionId}/${owned.secondary.sessionId}, orders ${owned.primary.orderId}/${owned.secondary.orderId}; no global reset`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
