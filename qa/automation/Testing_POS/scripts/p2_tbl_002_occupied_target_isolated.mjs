// P2-TBL-002: transfer into an occupied QA3 target is denied without moving either session.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_002_occupied_target_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = [
  { code: 'Q3-1', tableId: null, sessionId: null, orderId: null },
  { code: 'Q3-2', tableId: null, sessionId: null, orderId: null },
];
let menuId;
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
function queue(orderId, status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => x.order_id === orderId);
}
function finish(x) {
  if (!x.sessionId) return true;
  let t = table(x);
  if (t.current_session?.id !== x.sessionId) throw new Error(`CLEANUP REQUIRED: ${x.code} session moved`);
  if (!x.orderId) {
    const rows = (t.orders || []).filter(o => o.table_session_id === x.sessionId);
    if (rows.length === 1) x.orderId = rows[0].id;
    else if (!rows.length) x.orderId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: x.sessionId }), 201, `${x.code} cleanup create`).id;
  }
  if (!x.orderId || !menuId) throw new Error(`CLEANUP REQUIRED: ${x.code} fixture unavailable`);
  let o = order(x);
  if (o.table_session_id !== x.sessionId) throw new Error(`CLEANUP REQUIRED: ${x.code} order moved`);
  if (o.status === 'NEW') {
    if (!o.items?.length) must(post(`/api/v1/orders/${x.orderId}/items`, 'waiter',
      { items: [{ menu_item_id: menuId, quantity: 1, note: `QA P2TBL002 ${x.code} cleanup` }] }), 201, 'cleanup add');
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
  t = table(x);
  if (t.status === 'CLEANING') must(post(`/api/v1/tables/${x.tableId}/mark-clean`, 'waiter'), 200, 'cleanup table');
  t = table(x); o = order(x);
  if (t.status !== 'AVAILABLE' || t.current_session || o.status !== 'CLOSED' ||
    o.items.some(i => i.status !== 'SERVED') || queue(x.orderId, 'DONE').length !== o.items.length ||
    queue(x.orderId).length) throw new Error(`CLEANUP REQUIRED: ${x.code} final state mismatch`);
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL002',
  test_ref: 'P2-TBL-002', checked_at: new Date().toISOString(),
  scope: 'QA3 API transfer into an occupied target is rejected; two independent sessions/orders remain intact; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, asserted = false, executed = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/transfer']?.post)
    throw new Error('PENDING_CONTRACT: transfer absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'], ['qa3_kitchen', 'KITCHEN']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  menuId = menu.find(m => m.is_available && m.station_id && !m.has_modifiers)?.id;
  for (const x of owned) {
    const matching = tables.filter(t => t.code === x.code && t.status === 'AVAILABLE');
    if (matching.length !== 1 || !menuId)
      throw new Error('PENDING_FIXTURE: Q3-1/Q3-2 both AVAILABLE and mapped menu item required');
    x.tableId = matching[0].id;
  }
  for (const x of owned) {
    x.sessionId = must(post(`/api/v1/tables/${x.tableId}/open-session`, 'waiter',
      { guest_count: 1 }), 201, `open ${x.code}`).id;
    x.orderId = must(post('/api/v1/orders', 'cashier',
      { table_session_id: x.sessionId }), 201, `create ${x.code} order`).id;
    must(post(`/api/v1/orders/${x.orderId}/items`, 'cashier',
      { items: [{ menu_item_id: menuId, quantity: 1, note: `QA P2TBL002 ${x.code}` }] }), 201, `add ${x.code} item`);
  }
  const before = owned.map(x => ({ table: table(x), order: order(x) }));
  if (before.some((state, n) => state.table.status !== 'OCCUPIED' ||
    state.table.current_session?.id !== owned[n].sessionId ||
    state.order.table_session_id !== owned[n].sessionId || state.order.items?.length !== 1))
    throw new Error('PENDING_FIXTURE: independent occupied table state not established');
  executed = true;
  const attempt = post(`/api/v1/tables/${owned[0].tableId}/transfer`, 'waiter',
    { target_table_id: owned[1].tableId });
  const after = owned.map(x => ({ table: table(x), order: order(x) }));
  report.http = { transfer: attempt.http };
  report.checks = {
    occupied_target_rejected: attempt.http === 409,
    both_sessions_unchanged: after.every((state, n) =>
      state.table.status === 'OCCUPIED' && state.table.current_session?.id === owned[n].sessionId),
    both_orders_unchanged: after.every((state, n) =>
      state.order.id === before[n].order.id && state.order.table_session_id === owned[n].sessionId &&
      state.order.items?.length === 1 && state.order.items[0].id === before[n].order.items[0].id &&
      state.order.subtotal === before[n].order.subtotal),
  };
  report.tables = owned.map(x => ({ code: x.code, session_id: x.sessionId, order_id: x.orderId }));
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Occupied target transfer was accepted or changed a table/order');
} catch (error) { failure = redact(error.message || error); }
finally {
  const errors = [];
  const cleaned = owned.map(x => {
    try { return finish(x); } catch (error) { errors.push(redact(error.message || error)); return false; }
  });
  cleanupPass = cleaned.every(Boolean);
  if (errors.length) failure = `${failure ? `${failure}; ` : ''}${errors.join('; ')}`;
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.orders_closed = cleanupPass; report.tables_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.some(x => x.sessionId) && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.some(x => x.sessionId))
    report.cleanup_required = owned.filter((x, n) => x.sessionId && !cleaned[n])
      .map(x => `${x.code} session ${x.sessionId}, order ${x.orderId}`).join('; ');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
