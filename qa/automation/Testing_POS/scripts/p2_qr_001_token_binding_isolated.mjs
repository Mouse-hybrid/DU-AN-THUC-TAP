// P2-QR-001: issue and revoke an owned QA3 QR session with RBAC and audit.
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
if (!output) { console.error('Usage: node scripts/p2_qr_001_token_binding_isolated.mjs OUTPUT.json'); process.exit(2); }
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
        {items: [{menu_item_id: owned.starterMenuId, quantity: 1, note: 'QA P2QR001 cleanup'}]}), 201, 'cleanup add');
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
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2QR001',
  test_ref: 'P2-QR-001', checked_at: new Date().toISOString(), result: 'INCONCLUSIVE',
  scope: 'QA3 QR token bound to own table/session: issue, metadata, role guard, revoke, audit and cleanup. API business; no customer UI.',
  token_recorded: false, secrets_recorded: false,
};
let buildBefore, buildAfter, asserted = false, cleanupPass = false, failure, issuedToken = false;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!/^[a-f0-9]{40}$/.test(expected) || buildBefore !== expected)
    throw new Error('PENDING_BUILD: full staging SHA changed');
  const spec = must(call('GET', '/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/qr-session']?.post ||
      !spec.paths?.['/api/v1/tables/{table_id}/qr-session']?.delete ||
      !spec.paths?.['/api/v1/public/qr/{token}']?.get)
    throw new Error('PENDING_CONTRACT: QR issue/revoke/public metadata absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
    const login = must(post('/api/v1/auth/login', null, {username: name, password}), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(call('GET', '/api/v1/tables', 'waiter'), 200, 'QA3 tables');
  const candidates = tables.filter(x => /^Q3-[12]$/.test(x.code) && x.status === 'AVAILABLE');
  const menu = must(call('GET', '/api/v1/menu?available_only=true', 'cashier'), 200, 'staff menu');
  const starter = menu.find(x => x.is_available && x.station_id && !x.has_modifiers);
  if (!candidates.length || !starter)
    throw new Error('PENDING_FIXTURE: AVAILABLE Q3 table and mapped menu item required');
  owned.starterMenuId = starter.id;
  for (const candidate of candidates) {
    const opened = post(`/api/v1/tables/${candidate.id}/open-session`, 'waiter', {guest_count: 1});
    if (opened.http === 409) continue;
    owned.tableId = candidate.id; owned.tableCode = candidate.code;
    owned.sessionId = must(opened, 201, 'open own session').id; break;
  }
  if (!owned.sessionId) throw new Error('PENDING_FIXTURE: candidate QA3 tables occupied');
  owned.orderId = must(post('/api/v1/orders', 'cashier', {table_session_id: owned.sessionId}), 201, 'own order').id;
  if (!owned.orderId) throw new Error('CLEANUP REQUIRED: own order id missing');
  must(post(`/api/v1/orders/${owned.orderId}/items`, 'cashier',
    {items: [{menu_item_id: starter.id, quantity: 1, note: 'QA P2QR001 starter'}]}), 201, 'own starter');
  const issue = must(post(`/api/v1/tables/${owned.tableId}/qr-session`, 'waiter'), 201, 'issue QR');
  issuedToken = true; owned.qrIssued = true; owned.qrToken = issue.token;
  if (!owned.qrToken) throw new Error('Issued QR token missing');
  const staffRead = must(call('GET', `/api/v1/tables/${owned.tableId}/qr-session`, 'waiter'), 200, 'staff QR read');
  const publicInfo = must(call('GET', `/api/v1/public/qr/${owned.qrToken}`), 200, 'public QR info');
  const denied = post(`/api/v1/tables/${owned.tableId}/qr-session`, 'kitchen');
  const stillValid = must(call('GET', `/api/v1/public/qr/${owned.qrToken}`), 200, 'valid after role denial');
  const revoke = call('DELETE', `/api/v1/tables/${owned.tableId}/qr-session`, 'waiter');
  if (revoke.http === 204) owned.qrIssued = false;
  const revoked = call('GET', `/api/v1/public/qr/${owned.qrToken}`);
  const audit = must(call('GET', `/api/v1/audit-logs?entity_type=table_session&entity_id=${owned.sessionId}&limit=100`,
    'admin'), 200, 'owned session audit');
  const issueRows = Array.isArray(audit) ? audit.filter(x => x.action === 'QR_SESSION_ISSUED' && x.entity_id === owned.sessionId) : [];
  const revokeRows = Array.isArray(audit) ? audit.filter(x => x.action === 'QR_SESSION_REVOKED' && x.entity_id === owned.sessionId) : [];
  report.http = {issue: 201, staff_read: 200, public_read: 200, kitchen_issue: denied.http,
    revoke: revoke.http, revoked_read: revoked.http, audit: 200};
  report.checks = {
    bound_to_own_session: issue.table_id === owned.tableId && issue.table_session_id === owned.sessionId &&
      staffRead.table_session_id === owned.sessionId && staffRead.token === owned.qrToken &&
      table().current_session?.id === owned.sessionId,
    expiry_in_future: Number.isFinite(Date.parse(issue.expires_at)) &&
      Date.parse(issue.expires_at) > Date.now() && Date.parse(issue.expires_at) === Date.parse(staffRead.expires_at),
    public_scoped: publicInfo.table_code === owned.tableCode && stillValid.table_code === owned.tableCode &&
      publicInfo.ordering_locked === false,
    role_denied: denied.http === 403,
    revoked: revoke.http === 204 && revoked.http === 401,
    audit_exact: issueRows.length === 1 && revokeRows.length === 1 &&
      issueRows[0].staff_username === 'qa3_waiter' && revokeRows[0].staff_username === 'qa3_waiter',
    no_secret_in_audit: !JSON.stringify(audit).includes(owned.qrToken),
  };
  report.table_code = owned.tableCode; report.order_id = owned.orderId;
  report.session_id = owned.sessionId; report.audit_issued = issueRows.length;
  report.audit_revoked = revokeRows.length;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('QR binding, RBAC, expiry, revoke or audit assertion failed');
} catch (e) { failure = redact(e.message || e); }
finally {
  if (owned.sessionId) try { cleanupPass = finish(); }
  catch (e) { failure = `${failure || 'Runner error'}; ${redact(e.message || e)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = issuedToken ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.order_closed = cleanupPass; report.table_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.sessionId && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : issuedToken && cleanupPass ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.sessionId)
    report.cleanup_required = `Inspect own ${owned.tableCode} session ${owned.sessionId}, order ${owned.orderId}; no global reset`;
  mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}

