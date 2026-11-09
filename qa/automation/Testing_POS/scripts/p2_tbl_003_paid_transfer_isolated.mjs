// P2-TBL-003: transfer after QA3 order payment is rejected; clean only owned fixtures.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_003_paid_transfer_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = { source: null, target: null, sessionId: null, orderId: null, menuId: null };
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
const table = id => must(get(`/api/v1/tables/${id}`, 'waiter'), 200, 'own table');
const order = () => must(get(`/api/v1/orders/${owned.orderId}`, 'cashier'), 200, 'own order');
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => x.order_id === owned.orderId);
}
function finish() {
  if (!owned.sessionId) return false;
  let source = table(owned.source.id), target = table(owned.target.id);
  if (source.current_session?.id && source.current_session.id !== owned.sessionId)
    throw new Error('CLEANUP REQUIRED: QA source is used by another session');
  if (target.current_session?.id === owned.sessionId)
    throw new Error('CLEANUP REQUIRED: own session unexpectedly moved to target');
  if (!owned.orderId) {
    const rows = (source.orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.orderId = rows[0].id;
    else if (!rows.length && source.current_session?.id === owned.sessionId)
      owned.orderId = must(post('/api/v1/orders', 'waiter',
        { table_session_id: owned.sessionId }), 201, 'cleanup create order').id;
  }
  if (!owned.orderId) throw new Error('CLEANUP REQUIRED: own order not uniquely identified');
  let o = order();
  if (o.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session changed');
  if (o.status === 'NEW') {
    if (!o.items?.length) {
      if (!owned.menuId) throw new Error('CLEANUP REQUIRED: starter menu unavailable');
      must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL003 cleanup' }] }), 201, 'cleanup add');
    }
    must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  }
  o = order();
  for (const item of o.items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order().items.find(i => i.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${owned.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order().items.find(i => i.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order().status !== 'CLOSED')
    must(post(`/api/v1/orders/${owned.orderId}/close`, 'cashier'), 200, 'cleanup close');
  source = table(owned.source.id); target = table(owned.target.id);
  if (source.status === 'CLEANING')
    must(post(`/api/v1/tables/${owned.source.id}/mark-clean`, 'waiter'), 200, 'cleanup source');
  source = table(owned.source.id); target = table(owned.target.id);
  const final = order();
  if (final.status !== 'CLOSED' || final.table_session_id !== owned.sessionId ||
    source.status !== 'AVAILABLE' || target.status !== 'AVAILABLE' ||
    source.current_session || target.current_session ||
    final.items.some(x => x.status !== 'SERVED') ||
    queue('DONE').length !== final.items.length || queue().length)
    throw new Error('CLEANUP REQUIRED: final order/table state mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL003',
  test_ref: 'P2-TBL-003', checked_at: new Date().toISOString(),
  scope: 'QA3 API transfer attempt after simulated cash payment; UI not tested',
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
  for (const [code, field] of [['Q3-1', 'source'], ['Q3-2', 'target']]) {
    const matches = tables.filter(t => t.code === code && t.status === 'AVAILABLE');
    if (matches.length !== 1) throw new Error('PENDING_FIXTURE: both QA3 tables must be AVAILABLE');
    owned[field] = matches[0];
  }
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  owned.menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  if (!owned.menuId) throw new Error('PENDING_FIXTURE: mapped starter item unavailable');
  owned.sessionId = must(post(`/api/v1/tables/${owned.source.id}/open-session`, 'waiter',
    { guest_count: 1 }), 201, 'open source').id;
  owned.orderId = must(post('/api/v1/orders', 'cashier',
    { table_session_id: owned.sessionId }), 201, 'create order').id;
  must(post(`/api/v1/orders/${owned.orderId}/items`, 'cashier',
    { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL003 payment' }] }), 201, 'add item');
  must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'send ticket');
  const items = order().items;
  if (items.length !== 1 || queue().length !== 1) throw new Error('PENDING_FIXTURE: own single ticket not established');
  const itemId = items[0].id;
  for (const [action, role] of [['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
    ['pickup', 'waiter'], ['served', 'waiter']]) {
    must(post(`/api/v1/orders/${owned.orderId}/items/${itemId}/${action}`, role), 200, action);
  }
  must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'request billing');
  must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'simulated cash pay');
  const beforeSource = table(owned.source.id), beforeTarget = table(owned.target.id), beforeOrder = order();
  if (beforeOrder.status !== 'PAID' || beforeSource.status !== 'CLEANING' ||
    beforeSource.current_session || beforeTarget.status !== 'AVAILABLE' || beforeTarget.current_session)
    throw new Error('PENDING_FIXTURE: expected paid/cleaning source and available target');
  executed = true;
  const attempt = post(`/api/v1/tables/${owned.source.id}/transfer`, 'waiter',
    { target_table_id: owned.target.id });
  const afterSource = table(owned.source.id), afterTarget = table(owned.target.id), afterOrder = order();
  report.http = { transfer: attempt.http };
  report.checks = {
    paid_transfer_rejected: attempt.http === 409,
    order_unchanged: afterOrder.id === beforeOrder.id && afterOrder.status === 'PAID' &&
      afterOrder.table_session_id === owned.sessionId && afterOrder.subtotal === beforeOrder.subtotal,
    table_states_unchanged: afterSource.status === 'CLEANING' && !afterSource.current_session &&
      afterTarget.status === 'AVAILABLE' && !afterTarget.current_session,
  };
  report.source_table = owned.source.code; report.target_table = owned.target.code;
  report.session_id = owned.sessionId; report.order_id = owned.orderId;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Transfer after payment accepted or changed paid order/table');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.sessionId) try { cleanupPass = finish(); }
    catch (error) { failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.order_closed = cleanupPass; report.tables_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.sessionId && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.sessionId)
    report.cleanup_required = `Inspect own ${owned.source?.code} session ${owned.sessionId}, order ${owned.orderId}; no global reset`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
