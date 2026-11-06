// P2-QR-003/004/005: QR submit, shared POS session and idempotent replay.
// Own QA3 session, revoke QR, serve items, pay simulated, close and clean.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_qr_003_004_005_business_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }
const roles = {};
const owned = { tableId: null, tableCode: null, sessionId: null, orderId: null, itemId: null, qrItemId: null, qrIssued: false, starterMenuId: null, qrToken: null };
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
function post(path, role, body, key) { return call('POST', path, role, body, key); }
function queue(status) {
  const rows = must(call('GET', `/api/v1/kitchen/queue?status=${status}`, 'kitchen'), 200, 'Kitchen Queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen Queue is not an array');
  return rows.filter(x => x.order_id === owned.orderId);
}
function finish() {
  if (!owned.sessionId) return false;
  let t = table();
  if (t.id !== owned.tableId || (t.current_session?.id && t.current_session.id !== owned.sessionId))
    throw new Error('CLEANUP REQUIRED: table/session changed');
  if (owned.qrIssued && t.current_session?.id === owned.sessionId) {
    must(call('DELETE', `/api/v1/tables/${owned.tableId}/qr-session`, 'waiter'), 204, 'revoke own QR');
    owned.qrIssued = false;
  }
  if (!owned.orderId) {
    const rows = (t.orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.orderId = rows[0].id;
    else if (rows.length === 0 && t.current_session?.id === owned.sessionId)
      owned.orderId = must(post('/api/v1/orders', 'waiter', {table_session_id: owned.sessionId}), 201, 'cleanup create').id;
  }
  if (!owned.orderId) throw new Error(`CLEANUP REQUIRED: ${owned.tableCode} session ${owned.sessionId} has no owned order`);
  let o = order();
  if (o.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session changed');
  if (o.status === 'NEW') {
    if (!o.items.length) {
      if (!owned.starterMenuId) throw new Error('CLEANUP REQUIRED: starter item unavailable');
      must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
        {items: [{menu_item_id: owned.starterMenuId, quantity: 1, note: 'QA P2QR003005 cleanup'}]}), 201, 'cleanup add');
    }
    must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  }
  o = order();
  for (const item of o.items) {
    for (const [from, action, role] of [['SENT','start-cooking','kitchen'],
      ['PREPARING','mark-ready','kitchen'],['READY','pickup','waiter'],['PICKED_UP','served','waiter']]) {
      const current = order().items.find(x => x.id === item.id);
      if (current?.status === from)
        must(post(`/api/v1/orders/${owned.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order().items.find(x => x.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: own item ${item.id} not SERVED`);
  }
  o = order();
  if (!['BILLING','PAID','CLOSED'].includes(o.status))
    must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID','CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'cleanup simulated payment');
  if (order().status !== 'CLOSED')
    must(post(`/api/v1/orders/${owned.orderId}/close`, 'cashier'), 200, 'cleanup close');
  t = table();
  if (t.status === 'CLEANING') must(post(`/api/v1/tables/${owned.tableId}/mark-clean`, 'waiter'), 200, 'cleanup table');
  const done = queue('DONE'), active = must(call('GET','/api/v1/kitchen/queue','kitchen'),200,'active queue');
  const final = order(), end = table();
  if (final.status !== 'CLOSED' || end.status !== 'AVAILABLE' || end.current_session ||
    final.items.some(x => x.status !== 'SERVED') || done.length !== final.items.length ||
    active.some(x => x.order_id === owned.orderId)) throw new Error('CLEANUP REQUIRED: final state mismatch');
  return true;
}

const report = {
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2QR003004005',
  test_refs: ['P2-QR-003', 'P2-QR-004', 'P2-QR-005'],
  checked_at: new Date().toISOString(), result: 'INCONCLUSIVE',
  scope: 'QA3 QR + POS in one session; two same-key replays, one QR line/ticket, table bill and audit. API business; customer UI not tested.',
  token_recorded: false, secrets_recorded: false,
};
let buildBefore, buildAfter, asserted = false, cleanupPass = false, failure, submitted = false;
const cents = x => Math.round(Number(x) * 100);
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!/^[a-f0-9]{40}$/.test(expected) || buildBefore !== expected)
    throw new Error('PENDING_BUILD: full staging SHA changed');
  const spec = must(call('GET', '/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/public/qr/{token}/orders']?.post ||
      !spec.paths?.['/api/v1/tables/{table_id}/qr-session']?.post)
    throw new Error('PENDING_CONTRACT: QR issue/submit absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
    const login = must(post('/api/v1/auth/login', null, {username: name, password}), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(call('GET', '/api/v1/tables', 'waiter'), 200, 'QA3 tables');
  const candidates = tables.filter(x => /^Q3-[12]$/.test(x.code) && x.status === 'AVAILABLE');
  const menu = must(call('GET', '/api/v1/menu?available_only=true', 'cashier'), 200, 'staff menu');
  const mapped = menu.filter(x => x.is_available && x.station_id && !x.has_modifiers);
  const [posMenu, qrMenuItem] = mapped;
  if (!candidates.length || !posMenu || !qrMenuItem)
    throw new Error('PENDING_FIXTURE: own Q3 table and two mapped items without modifiers required');
  owned.starterMenuId = posMenu.id;
  for (const candidate of candidates) {
    const opened = post(`/api/v1/tables/${candidate.id}/open-session`, 'waiter', {guest_count: 1});
    if (opened.http === 409) continue;
    owned.tableId = candidate.id; owned.tableCode = candidate.code;
    owned.sessionId = must(opened, 201, 'open own session').id; break;
  }
  if (!owned.sessionId) throw new Error('PENDING_FIXTURE: all candidate QA3 tables occupied');
  owned.orderId = must(post('/api/v1/orders', 'cashier', {table_session_id: owned.sessionId}), 201, 'create POS order').id;
  if (!owned.orderId) throw new Error('CLEANUP REQUIRED: own order id missing');
  const added = must(post(`/api/v1/orders/${owned.orderId}/items`, 'cashier',
    {items: [{menu_item_id: posMenu.id, quantity: 1, note: 'QA QR003005 POS starter'}]}), 201, 'add POS item');
  owned.itemId = added.items?.find(x => x.menu_item_id === posMenu.id)?.id;
  if (!owned.itemId) throw new Error('CLEANUP REQUIRED: POS starter missing');
  const issued = must(post(`/api/v1/tables/${owned.tableId}/qr-session`, 'waiter'), 201, 'issue own QR');
  owned.qrIssued = true; owned.qrToken = issued.token;
  if (issued.table_session_id !== owned.sessionId || !owned.qrToken) throw new Error('QR session mismatch');
  const publicMenu = must(call('GET', `/api/v1/public/qr/${owned.qrToken}/menu`), 200, 'public menu');
  if (!publicMenu.items?.some(x => x.id === qrMenuItem.id && x.is_available))
    throw new Error('PENDING_FIXTURE: mapped QR item not in public menu');
  const body = {items: [{menu_item_id: qrMenuItem.id, quantity: 1, note: 'QA QR003005 one cart'}]};
  const key = randomUUID(); submitted = true;
  const first = must(post(`/api/v1/public/qr/${owned.qrToken}/orders`, null, body, key), 201, 'QR submit');
  const replay1 = must(post(`/api/v1/public/qr/${owned.qrToken}/orders`, null, body, key), 201, 'QR replay 1');
  const replay2 = must(post(`/api/v1/public/qr/${owned.qrToken}/orders`, null, body, key), 201, 'QR replay 2');
  const publicOrder = must(call('GET', `/api/v1/public/qr/${owned.qrToken}/order`), 200, 'public order');
  const own = order(), detail = table();
  owned.qrItemId = own.items.find(x => x.source === 'QR' && x.menu_item_id === qrMenuItem.id)?.id;
  const expectedSubtotal = cents(posMenu.price) + cents(qrMenuItem.price);
  const auditBefore = must(call('GET', `/api/v1/audit-logs?order_id=${owned.orderId}`, 'admin'), 200, 'order audit');
  const qrAdds = Array.isArray(auditBefore) ? auditBefore.filter(x =>
    x.action === 'ORDER_ITEMS_ADDED' && x.payload?.source === 'QR') : [];
  const sent = must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'Waiter sends to kitchen');
  const afterSend = order();
  const queued = queue('QUEUED');
  const qrTickets = queued.filter(x => x.order_item_id === owned.qrItemId || x.item_id === owned.qrItemId);
  report.checks = {
    qr_003_same_session: own.table_session_id === owned.sessionId &&
      publicOrder.table_code === owned.tableCode && afterSend.items.find(x => x.id === owned.qrItemId)?.status === 'SENT' &&
      qrTickets.length === 1 && Boolean(sent),
    qr_004_shared_bill: detail.current_session?.id === owned.sessionId &&
      detail.orders?.filter(x => x.id === owned.orderId).length === 1 &&
      own.items?.length === 2 && own.items.some(x => x.id === owned.itemId && x.source !== 'QR') &&
      own.items.some(x => x.id === owned.qrItemId && x.source === 'QR') &&
      cents(own.subtotal) === expectedSubtotal && cents(detail.orders.find(x => x.id === owned.orderId).total) === expectedSubtotal,
    qr_005_replay_exact: JSON.stringify(first) === JSON.stringify(replay1) &&
      JSON.stringify(first) === JSON.stringify(replay2) &&
      own.items.filter(x => x.source === 'QR').length === 1 &&
      publicOrder.items?.filter(x => x.source === 'QR').length === 1 &&
      qrAdds.length === 1 && qrTickets.length === 1,
  };
  report.table_code = owned.tableCode; report.order_id = owned.orderId;
  report.qr_item_id = owned.qrItemId; report.expected_subtotal = (expectedSubtotal / 100).toFixed(2);
  report.qr_audit_add_count = qrAdds.length; report.qr_ticket_count = qrTickets.length;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('QR session, shared bill, KDS or idempotency assertion failed');
} catch (e) { failure = redact(e.message || e); }
finally {
  if (owned.sessionId) try { cleanupPass = finish(); }
  catch (e) { failure = `${failure || 'Runner error'}; ${redact(e.message || e)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = submitted ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.order_closed = cleanupPass; report.table_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.sessionId && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : submitted && cleanupPass ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.sessionId)
    report.cleanup_required = `Inspect own ${owned.tableCode} session ${owned.sessionId}, order ${owned.orderId}; no global reset`;
  mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}

