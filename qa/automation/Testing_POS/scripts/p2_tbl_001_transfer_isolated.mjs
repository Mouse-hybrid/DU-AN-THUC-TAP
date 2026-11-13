// P2-TBL-001: isolated QA3 transfer preserves the session, order and kitchen ticket.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_001_transfer_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const staffByRole = {};
const owned = { source: null, target: null, sessionId: null, orderId: null, itemId: null, menuId: null, transferred: false };
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
  const split = raw.lastIndexOf('\n');
  const http = Number(raw.slice(split + 1));
  const text = raw.slice(0, split);
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
  const path = `/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`;
  const rows = must(get(path, 'kitchen'), 200, 'kitchen queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => x.order_id === owned.orderId);
}
function cleanup() {
  if (!owned.sessionId) return false;
  let source = table(owned.source.id);
  let target = table(owned.target.id);
  const holder = source.current_session?.id === owned.sessionId ? source :
    target.current_session?.id === owned.sessionId ? target : null;
  if (!holder || (source.current_session?.id === owned.sessionId && target.current_session?.id === owned.sessionId))
    throw new Error('CLEANUP REQUIRED: session holder ambiguous');
  if (!owned.orderId) {
    const rows = (holder.orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.orderId = rows[0].id;
    else if (rows.length === 0)
      owned.orderId = must(post('/api/v1/orders', 'waiter', { table_session_id: owned.sessionId }), 201, 'cleanup create order').id;
  }
  if (!owned.orderId) throw new Error('CLEANUP REQUIRED: order not uniquely identified');
  let o = order();
  if (o.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session changed');
  if (o.status === 'NEW') {
    if (!o.items?.length) {
      if (!owned.menuId) throw new Error('CLEANUP REQUIRED: starter item unavailable');
      must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL001 cleanup' }] }), 201, 'cleanup add item');
    }
    must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  }
  o = order();
  for (const item of o.items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order().items.find(x => x.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${owned.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order().items.find(x => x.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: own item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order().status !== 'CLOSED')
    must(post(`/api/v1/orders/${owned.orderId}/close`, 'cashier'), 200, 'cleanup close');
  for (const id of [owned.source.id, owned.target.id]) {
    const t = table(id);
    if (t.status === 'CLEANING') must(post(`/api/v1/tables/${id}/mark-clean`, 'waiter'), 200, 'cleanup table');
  }
  source = table(owned.source.id); target = table(owned.target.id);
  const final = order(), done = queue('DONE'), active = queue();
  if (final.status !== 'CLOSED' || final.table_session_id !== owned.sessionId ||
    source.status !== 'AVAILABLE' || target.status !== 'AVAILABLE' ||
    source.current_session || target.current_session ||
    final.items.some(x => x.status !== 'SERVED') || done.length !== final.items.length || active.length)
    throw new Error('CLEANUP REQUIRED: final state mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL001',
  test_ref: 'P2-TBL-001', checked_at: new Date().toISOString(),
  scope: 'QA3 API transfer preserves session, order and kitchen ticket; source CLEANING and one actor/time audit; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, asserted = false, cleanupPass = false, executed = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/transfer']?.post)
    throw new Error('PENDING_CONTRACT: transfer absent');
  if (!spec.paths?.['/api/v1/audit-logs']?.get)
    throw new Error('PENDING_CONTRACT: audit read absent');
  for (const [name, role] of [['qa3_admin', 'SUPERVISOR'], ['qa3_waiter', 'WAITER'],
    ['qa3_cashier', 'CASHIER'], ['qa3_kitchen', 'KITCHEN']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.staff?.id || !login.staff?.outlet_id || !login.access_token)
      throw new Error('PENDING_FIXTURE: QA3 role or identity mismatch');
    roles[name.slice(4)] = login.access_token;
    staffByRole[name.slice(4)] = login.staff;
  }
  if (!['waiter', 'cashier', 'kitchen'].every(role =>
    staffByRole[role].outlet_id === staffByRole.admin.outlet_id))
    throw new Error('PENDING_FIXTURE: QA3 roles belong to different outlets');
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const candidates = tables.filter(x => /^Q3-[12]$/.test(x.code) && x.status === 'AVAILABLE');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  const starter = menu.find(x => x.is_available && x.station_id && !x.has_modifiers);
  if (candidates.length !== 2 || !starter)
    throw new Error('PENDING_FIXTURE: Q3-1/Q3-2 both AVAILABLE and mapped menu item required');
  owned.source = candidates.find(x => x.code === 'Q3-1');
  owned.target = candidates.find(x => x.code === 'Q3-2');
  owned.menuId = starter.id;
  if (!owned.source || !owned.target) throw new Error('PENDING_FIXTURE: exact Q3 table pair missing');
  owned.sessionId = must(post(`/api/v1/tables/${owned.source.id}/open-session`, 'waiter', { guest_count: 1 }), 201, 'open QA source').id;
  owned.orderId = must(post('/api/v1/orders', 'cashier', { table_session_id: owned.sessionId }), 201, 'create own order').id;
  const added = must(post(`/api/v1/orders/${owned.orderId}/items`, 'cashier',
    { items: [{ menu_item_id: starter.id, quantity: 1, note: 'QA P2TBL001 transfer' }] }), 201, 'add own item');
  owned.itemId = added.items?.find(x => x.menu_item_id === starter.id)?.id;
  if (!owned.itemId) throw new Error('CLEANUP REQUIRED: own item id missing');
  must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'send own ticket');
  const before = order(), beforeQueue = queue();
  const beforeSource = table(owned.source.id), beforeTarget = table(owned.target.id);
  if (before.table_session_id !== owned.sessionId || beforeQueue.length !== 1 ||
    beforeSource.current_session?.id !== owned.sessionId || beforeTarget.current_session ||
    !before.items.some(x => x.id === owned.itemId))
    throw new Error('PENDING_FIXTURE: own source state not isolated before transfer');
  const ticketBefore = beforeQueue[0];
  executed = true;
  const response = must(post(`/api/v1/tables/${owned.source.id}/transfer`, 'waiter',
    { target_table_id: owned.target.id }), 200, 'transfer');
  owned.transferred = true;
  const afterSource = table(owned.source.id), afterTarget = table(owned.target.id);
  const after = order(), afterQueue = queue();
  const transferAudit = must(get(`/api/v1/audit-logs?entity_id=${owned.sessionId}` +
    '&entity_type=table_session&action=TABLE_TRANSFERRED&limit=100', 'admin'), 200, 'transfer audit');
  const auditRows = Array.isArray(transferAudit) ? transferAudit.filter(x =>
    x.entity_id === owned.sessionId && x.action === 'TABLE_TRANSFERRED') : [];
  report.checks = {
    transfer_http_200: true,
    same_session: response.table_session_id === owned.sessionId &&
      afterTarget.current_session?.id === owned.sessionId && !afterSource.current_session,
    same_order: after.id === before.id && after.table_session_id === before.table_session_id &&
      after.items.length === before.items.length && after.items[0].id === before.items[0].id &&
      after.subtotal === before.subtotal,
    same_ticket: afterQueue.length === 1 && afterQueue[0].id === ticketBefore.id &&
      afterQueue[0].order_id === owned.orderId,
    table_states: afterSource.status === 'CLEANING' && afterTarget.status === 'OCCUPIED' &&
      response.from_table?.id === owned.source.id && response.to_table?.id === owned.target.id,
    audit_once: auditRows.length === 1,
    audit_actor_time_entity: auditRows.length === 1 &&
      auditRows[0].staff_id === staffByRole.waiter.id && auditRows[0].staff_role === 'WAITER' &&
      auditRows[0].entity_type === 'table_session' && auditRows[0].entity_id === owned.sessionId &&
      Number.isFinite(Date.parse(auditRows[0].created_at)),
  };
  report.audit = { action: 'TABLE_TRANSFERRED', count: auditRows.length,
    actor: auditRows[0]?.staff_username ?? null, entity_type: 'table_session' };
  report.source_table = owned.source.code; report.target_table = owned.target.code;
  report.session_id = owned.sessionId; report.order_id = owned.orderId;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Transfer session/order/ticket/table state or audit mismatch');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.sessionId) try { cleanupPass = cleanup(); }
    catch (error) { failure = `${failure || 'Runner error'}; ${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass;
  report.order_closed = cleanupPass; report.tables_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.sessionId && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.sessionId)
    report.cleanup_required = `Inspect own ${owned.source?.code}/${owned.target?.code} session ${owned.sessionId}, order ${owned.orderId}; no global reset`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
