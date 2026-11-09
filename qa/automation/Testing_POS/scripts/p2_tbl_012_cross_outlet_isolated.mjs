// P2-TBL-012: deny QA2 cross-outlet transfer, merge and split of isolated QA3 data.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_012_cross_outlet_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = { code: 'Q3-1', tableId: null, targetId: null, sessionId: null, originalId: null,
  splitId: null, menuId: null, sourceItemId: null, movingItemId: null,
  sourceTicketId: null, movingTicketId: null };
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
const targetTable = () => must(get(`/api/v1/tables/${owned.targetId}`, 'waiter'), 200, 'target table');
const order = id => must(get(`/api/v1/orders/${id}`, 'cashier'), 200, 'order');
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => [owned.originalId, owned.splitId].includes(x.order_id));
}
function discoverOrders() {
  const rows = (table().orders || []).filter(x => x.table_session_id === owned.sessionId);
  const ids = [...new Set(rows.map(x => x.id))];
  if (ids.length > 2 || ids.some(id => id !== owned.originalId && owned.splitId && id !== owned.splitId))
    throw new Error('CLEANUP REQUIRED: unexpected order in QA session');
  const extra = ids.find(id => id !== owned.originalId);
  if (extra && !owned.splitId) owned.splitId = extra;
}
function finishOrder(id) {
  let current = order(id);
  if (current.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session mismatch');
  if (current.status === 'CLOSED') return;
  if (!current.items.length) {
    must(post(`/api/v1/orders/${id}/items`, 'waiter',
      { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL012 cleanup' }] }), 201, 'cleanup add');
    current = order(id);
  }
  if (current.items.some(x => x.status === 'CREATED'))
    must(post(`/api/v1/orders/${id}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  for (const item of order(id).items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order(id).items.find(i => i.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${id}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order(id).items.find(i => i.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order(id).status))
    must(post(`/api/v1/orders/${id}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order(id).status))
    must(post(`/api/v1/orders/${id}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order(id).status !== 'CLOSED')
    must(post(`/api/v1/orders/${id}/close`, 'cashier'), 200, 'cleanup close');
}
function cleanup() {
  if (!owned.sessionId) return false;
  discoverOrders();
  if (!owned.originalId) {
    const rows = (table().orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.originalId = rows[0].id;
    else if (!rows.length) owned.originalId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: owned.sessionId }), 201, 'cleanup create').id;
    else throw new Error('CLEANUP REQUIRED: order ownership ambiguous');
  }
  discoverOrders();
  for (const id of [owned.originalId, owned.splitId].filter(Boolean)) finishOrder(id);
  for (const [id, detail] of [[owned.tableId, table()], [owned.targetId, targetTable()]])
    if (detail.status === 'CLEANING')
      must(post(`/api/v1/tables/${id}/mark-clean`, 'waiter'), 200, 'mark clean');
  const finalTable = table(), finalTarget = targetTable();
  const orders = [owned.originalId, owned.splitId].filter(Boolean).map(order);
  const expectedTickets = orders.flatMap(x => x.items).length;
  if (finalTable.status !== 'AVAILABLE' || finalTable.current_session ||
    finalTarget.status !== 'AVAILABLE' || finalTarget.current_session || finalTarget.merged_into_table_id ||
    orders.some(x => x.status !== 'CLOSED' || x.items.some(i => i.status !== 'SERVED')) ||
    queue('DONE').length !== expectedTickets || queue().length)
    throw new Error('CLEANUP REQUIRED: final cross-outlet fixture mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL012',
  test_ref: 'P2-TBL-012', checked_at: new Date().toISOString(),
  scope: 'QA2 Supervisor attempts cross-outlet transfer, merge and split against isolated QA3 data; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, executed = false, asserted = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/orders/{order_id}/split']?.post ||
    !spec.paths?.['/api/v1/tables/{table_id}/transfer']?.post ||
    !spec.paths?.['/api/v1/tables/{table_id}/merge']?.post)
    throw new Error('PENDING_CONTRACT: transfer/merge/split absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const foreign = must(post('/api/v1/auth/login', null,
    { username: 'qa2_admin', password }), 200, 'qa2_admin login');
  if (foreign.staff?.role !== 'SUPERVISOR' || !foreign.access_token)
    throw new Error('PENDING_FIXTURE: QA2 Supervisor missing');
  roles.qa2 = foreign.access_token;
  const ownActor = must(get('/api/v1/auth/me', 'admin'), 200, 'QA3 identity');
  const foreignActor = must(get('/api/v1/auth/me', 'qa2'), 200, 'QA2 identity');
  if (!ownActor.outlet_id || !foreignActor.outlet_id ||
    ownActor.outlet_id === foreignActor.outlet_id)
    throw new Error('PENDING_FIXTURE: distinct QA2/QA3 outlets required');
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const matches = tables.filter(x => x.code === owned.code && x.status === 'AVAILABLE');
  const targets = tables.filter(x => x.code === 'Q3-2' && x.status === 'AVAILABLE');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  owned.menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  if (matches.length !== 1 || targets.length !== 1 || !owned.menuId)
    throw new Error('PENDING_FIXTURE: Q3-1/Q3-2 AVAILABLE and mapped menu item required');
  owned.tableId = matches[0].id;
  owned.targetId = targets[0].id;
  owned.sessionId = must(post(`/api/v1/tables/${owned.tableId}/open-session`, 'waiter',
    { guest_count: 2 }), 201, 'open QA3 table').id;
  owned.originalId = must(post('/api/v1/orders', 'cashier',
    { table_session_id: owned.sessionId }), 201, 'create order').id;
  const added = must(post(`/api/v1/orders/${owned.originalId}/items`, 'cashier',
    { items: [
      { menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL012 keep' },
      { menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL012 move' },
    ] }), 201, 'add two independent lines');
  owned.sourceItemId = added.items?.find(x => x.note === 'QA P2TBL012 keep')?.id;
  owned.movingItemId = added.items?.find(x => x.note === 'QA P2TBL012 move')?.id;
  if (!owned.sourceItemId || !owned.movingItemId || owned.sourceItemId === owned.movingItemId)
    throw new Error('PENDING_FIXTURE: two distinct POS lines required');
  must(post(`/api/v1/orders/${owned.originalId}/send-to-kitchen`, 'waiter'), 200, 'send both lines');
  const before = order(owned.originalId), beforeTickets = queue();
  if (before.items.length !== 2 || beforeTickets.length !== 2 ||
    beforeTickets.some(x => x.order_id !== owned.originalId))
    throw new Error('PENDING_FIXTURE: order/tickets not established');
  owned.sourceTicketId = beforeTickets.find(x => x.order_item_id === owned.sourceItemId)?.id;
  owned.movingTicketId = beforeTickets.find(x => x.order_item_id === owned.movingItemId)?.id;
  if (!owned.sourceTicketId || !owned.movingTicketId)
    throw new Error('PENDING_FIXTURE: ticket ownership missing');
  const initialTarget = targetTable();
  const snapshot = () => {
    const source = table(), target = targetTable(), bill = order(owned.originalId);
    return JSON.stringify({ source: { status: source.status, session: source.current_session?.id,
      orders: (source.orders || []).map(x => x.id).sort() },
    target: { status: target.status, session: target.current_session?.id,
      mergedInto: target.merged_into_table_id },
    bill: { session: bill.table_session_id, status: bill.status, version: bill.current_version,
      subtotal: bill.subtotal, items: bill.items.map(x => [x.id, x.status, x.quantity]).sort() },
    tickets: queue().map(x => [x.id, x.order_id, x.order_item_id, x.status]).sort() });
  };
  if (initialTarget.status !== 'AVAILABLE' || initialTarget.current_session)
    throw new Error('PENDING_FIXTURE: QA3 target table no longer available');
  const baseline = snapshot();
  executed = true;
  const foreignTable = get(`/api/v1/tables/${owned.tableId}`, 'qa2');
  const foreignOrder = get(`/api/v1/orders/${owned.originalId}`, 'qa2');
  if (foreignTable.http !== 404 || foreignOrder.http !== 404)
    throw new Error('Cross-outlet read access unexpectedly returned non-404');
  report.http = { foreign_table_get: foreignTable.http, foreign_order_get: foreignOrder.http };
  report.checks = { distinct_outlets: true, foreign_reads_denied: true };
  const transfer = post(`/api/v1/tables/${owned.tableId}/transfer`, 'qa2',
    { target_table_id: owned.targetId });
  report.http.transfer = transfer.http;
  report.checks.foreign_transfer_denied = transfer.http === 404;
  if (transfer.http !== 404) throw new Error(`Cross-outlet transfer returned HTTP ${transfer.http}`);
  report.checks.transfer_no_mutation = snapshot() === baseline;
  if (!report.checks.transfer_no_mutation) throw new Error('Cross-outlet transfer changed QA3 state');
  const merge = post(`/api/v1/tables/${owned.tableId}/merge`, 'qa2',
    { table_ids: [owned.targetId] });
  report.http.merge = merge.http;
  report.checks.foreign_merge_denied = merge.http === 404;
  if (merge.http !== 404) throw new Error(`Cross-outlet merge returned HTTP ${merge.http}`);
  report.checks.merge_no_mutation = snapshot() === baseline;
  if (!report.checks.merge_no_mutation) throw new Error('Cross-outlet merge changed QA3 state');
  const split = post(`/api/v1/orders/${owned.originalId}/split`, 'qa2',
    { items: [{ order_item_id: owned.movingItemId, quantity: 1 }] });
  owned.splitId = split.data?.new_order?.id || null;
  report.http.split = split.http;
  report.checks.foreign_split_denied = split.http === 404;
  if (split.http !== 404) throw new Error(`Cross-outlet split returned HTTP ${split.http}`);
  report.checks.split_no_mutation = snapshot() === baseline;
  if (!report.checks.split_no_mutation) throw new Error('Cross-outlet split changed QA3 state');
  const auditPaths = [
    `/api/v1/audit-logs?action=TABLE_TRANSFERRED&entity_id=${owned.sessionId}`,
    `/api/v1/audit-logs?action=TABLE_MERGED&entity_id=${owned.sessionId}`,
    `/api/v1/audit-logs?action=ORDER_SPLIT&entity_id=${owned.originalId}`,
  ];
  report.checks.no_foreign_action_audit = auditPaths.every(path =>
    must(get(path, 'admin'), 200, 'audit').length === 0);
  report.source_table = owned.code; report.target_table = 'Q3-2';
  report.order_id = owned.originalId;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Cross-outlet table/order isolation mismatch');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.sessionId) try { cleanupPass = cleanup(); }
    catch (error) { failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.orders_closed = cleanupPass; report.table_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.sessionId && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.sessionId)
    report.cleanup_required = `Inspect QA3 tables Q3-1/Q3-2, session ${owned.sessionId}, orders ${owned.originalId}/${owned.splitId}; no global reset`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
