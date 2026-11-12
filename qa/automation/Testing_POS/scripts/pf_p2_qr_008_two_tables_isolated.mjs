// PF-P2-QR-008: compare public QR reads across two owned QA3 table sessions.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/pf_p2_qr_008_two_tables_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!/^[a-f0-9]{40}$/.test(expected??'')) { console.error('PENDING_BUILD: full POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = [
  { code: 'Q3-1', tableId: null, sessionId: null, orderId: null, menuId: null, menuName: null, qrToken: null },
  { code: 'Q3-2', tableId: null, sessionId: null, orderId: null, menuId: null, menuName: null, qrToken: null },
];
function redact(value) {
  let safe = String(value).replaceAll(password, '<REDACTED>');
  for (const jwt of Object.values(roles)) safe = safe.replaceAll(jwt, '<REDACTED>');
  for (const x of owned) if (x.qrToken) safe = safe.replaceAll(x.qrToken, '<REDACTED>');
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
  if (!x.orderId || !x.menuId) throw new Error(`CLEANUP REQUIRED: ${x.code} fixture unavailable`);
  let o = order(x);
  if (o.table_session_id !== x.sessionId) throw new Error(`CLEANUP REQUIRED: ${x.code} order moved`);
  if (o.status === 'NEW') {
    if (!o.items?.length) must(post(`/api/v1/orders/${x.orderId}/items`, 'waiter',
      { items: [{ menu_item_id: x.menuId, quantity: 1, note: `QA P2QR008 ${x.code} cleanup` }] }), 201, 'cleanup add');
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

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-PFQR008',
  test_ref: 'PF-P2-QR-008', checked_at: new Date().toISOString(),
  scope: 'Two QA3 QR tokens read only their own table/order with distinct menu items; API only, no cross-outlet or customer UI.',
  business_case: 'P2-QR-008 NOT_EXECUTED: no direct order-B selector in public QR GET; cross-outlet and browser branches not covered.',
  token_recorded: false, secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, asserted = false, executed = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (buildBefore !== expected) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/qr-session']?.post ||
      !spec.paths?.['/api/v1/public/qr/{token}']?.get ||
      !spec.paths?.['/api/v1/public/qr/{token}/order']?.get)
    throw new Error('PENDING_CONTRACT: public QR read absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'], ['qa3_kitchen', 'KITCHEN']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  const candidates = menu.filter(m => m.is_available && m.station_id && !m.has_modifiers && m.name);
  const distinct = candidates.find(m => m.name !== candidates[0]?.name);
  if (!candidates[0] || !distinct) throw new Error('PENDING_FIXTURE: two distinct available mapped menu items required');
  owned[0].menuId = candidates[0].id; owned[0].menuName = candidates[0].name;
  owned[1].menuId = distinct.id; owned[1].menuName = distinct.name;
  for (const x of owned) {
    const matching = tables.filter(t => t.code === x.code && t.status === 'AVAILABLE');
    if (matching.length !== 1 || !x.menuId)
      throw new Error('PENDING_FIXTURE: Q3-1/Q3-2 both AVAILABLE and mapped menu item required');
    x.tableId = matching[0].id;
  }
  for (const x of owned) {
    x.sessionId = must(post(`/api/v1/tables/${x.tableId}/open-session`, 'waiter',
      { guest_count: 1 }), 201, `open ${x.code}`).id;
    x.orderId = must(post('/api/v1/orders', 'cashier',
      { table_session_id: x.sessionId }), 201, `create ${x.code} order`).id;
    must(post(`/api/v1/orders/${x.orderId}/items`, 'cashier',
      { items: [{ menu_item_id: x.menuId, quantity: 1, note: `QA P2QR008 ${x.code}` }] }), 201, `add ${x.code} item`);
  }
  const before = owned.map(x => ({ table: table(x), order: order(x) }));
  if (before.some((state, n) => state.table.status !== 'OCCUPIED' ||
    state.table.current_session?.id !== owned[n].sessionId ||
    state.order.table_session_id !== owned[n].sessionId || state.order.items?.length !== 1))
    throw new Error('PENDING_FIXTURE: two independent occupied sessions not established');
  for (const x of owned) {
    const issued = must(post(`/api/v1/tables/${x.tableId}/qr-session`, 'waiter'), 201, `QR ${x.code}`);
    x.qrToken = issued.token;
    if (!x.qrToken || issued.table_session_id !== x.sessionId) throw new Error('PENDING_FIXTURE: QR issue mismatch');
  }
  executed = true;
  const publicRows = owned.map(x => ({
    info: must(get(`/api/v1/public/qr/${x.qrToken}`), 200, `QR info ${x.code}`),
    order: must(get(`/api/v1/public/qr/${x.qrToken}/order`), 200, `QR order ${x.code}`)
  }));
  const after = owned.map(x => ({ table: table(x), order: order(x) }));
  const publicNames = publicRows.map(x => Array.isArray(x.order.items)
    ? x.order.items.map(i => i.menu_item_name) : []);
  report.checks = {
    two_distinct_tokens: owned[0].qrToken !== owned[1].qrToken,
    qr_info_scoped: publicRows.every((x,n) => x.info.table_code === owned[n].code &&
      x.info.ordering_locked === false),
    qr_order_scoped: publicRows.every((x,n) => x.order.table_code === owned[n].code &&
      publicNames[n].includes(owned[n].menuName) &&
      !publicNames[n].includes(owned[1-n].menuName) &&
      !JSON.stringify(x.order).includes(owned[1-n].orderId)),
    sessions_unchanged: after.every((state,n) => state.table.current_session?.id === owned[n].sessionId &&
      state.order.id === before[n].order.id && state.order.subtotal === before[n].order.subtotal)
  };
  report.tables = owned.map((x,n) => ({ code:x.code, order_id:x.orderId, public_item_count:publicNames[n].length }));
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Public QR read crossed table boundary or changed own order');
} catch (error) { failure = redact(error.message || error); }
finally {
  const errors = [];
  for (const x of owned) if (x.qrToken) {
    try { must(call('DELETE', `/api/v1/tables/${x.tableId}/qr-session`, 'waiter'), 204, `revoke ${x.code}`); x.qrToken=null; }
    catch (error) { errors.push(redact(error.message || error)); }
  }
  const cleaned = owned.map(x => {
    try { return finish(x); } catch (error) { errors.push(redact(error.message || error)); return false; }
  });
  cleanupPass = cleaned.every(Boolean) && !errors.length;
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
