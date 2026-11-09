// P2-TBL-010: merge retains a QR item and releases both QA3 tables to CLEANING on pay.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_010_merge_qr_pay_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = {
  primary: { code: 'Q3-1', tableId: null, sessionId: null, orderId: null, itemId: null, ticketId: null },
  secondary: { code: 'Q3-2', tableId: null, sessionId: null, orderId: null, itemId: null, ticketId: null },
  menuId: null, qrToken: null, qrIssued: false,
};
function redact(value) {
  let safe = String(value).replaceAll(password, '<REDACTED>');
  for (const jwt of Object.values(roles)) safe = safe.replaceAll(jwt, '<REDACTED>');
  if (owned.qrToken) safe = safe.replaceAll(owned.qrToken, '<REDACTED>');
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
      { table_session_id: x.sessionId }), 201, `${x.code} cleanup create`).id;
  }
  if (!x.orderId) throw new Error(`CLEANUP REQUIRED: ${x.code} order not uniquely identified`);
  let o = order(x);
  if (o.table_session_id !== x.sessionId) throw new Error(`CLEANUP REQUIRED: ${x.code} order session changed`);
  if (o.status === 'NEW') {
    if (!o.items?.length) {
      if (!owned.menuId) throw new Error('CLEANUP REQUIRED: mapped menu unavailable');
      must(post(`/api/v1/orders/${x.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL010 cleanup' }] }), 201, 'cleanup add');
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
  const primary = table(owned.primary), secondary = table(owned.secondary);
  if (owned.qrIssued && secondary.current_session?.id === owned.secondary.sessionId) {
    must(call('DELETE', `/api/v1/tables/${owned.secondary.tableId}/qr-session`, 'waiter'), 204, 'revoke own QR');
    owned.qrIssued = false;
  }
  const sourceOrder = owned.secondary.orderId ? order(owned.secondary) : null;
  const folded = sourceOrder?.status === 'CLOSED' && sourceOrder.items?.length === 0 &&
    owned.primary.orderId && order(owned.primary).items.some(i => i.id === owned.secondary.itemId);
  if (folded) {
    if (secondary.current_session || order(owned.primary).table_session_id !== owned.primary.sessionId)
      throw new Error('CLEANUP REQUIRED: merged order/session ownership ambiguous');
    finishOrder(owned.primary); // Also closes the merged table's session when still OPEN.
  } else {
    for (const x of [owned.primary, owned.secondary]) {
      if (!x.sessionId) continue;
      const current = table(x).current_session?.id;
      if (current && current !== x.sessionId)
        throw new Error(`CLEANUP REQUIRED: ${x.code} session moved unexpectedly`);
      finishOrder(x);
    }
  }
  for (const x of [owned.primary, owned.secondary]) {
    const t = table(x);
    if (t.status === 'CLEANING') must(post(`/api/v1/tables/${x.tableId}/mark-clean`, 'waiter'), 200, `clean ${x.code}`);
  }
  const endPrimary = table(owned.primary), endSecondary = table(owned.secondary);
  const master = owned.primary.orderId ? order(owned.primary) : null;
  const secondaryOrder = owned.secondary.orderId ? order(owned.secondary) : null;
  const expectedDone = (master?.items.length || 0) + (secondaryOrder?.items.length || 0);
  if (endPrimary.status !== 'AVAILABLE' || endSecondary.status !== 'AVAILABLE' ||
    endPrimary.current_session || endSecondary.current_session || endSecondary.merged_into_table_id ||
    (master && master.status !== 'CLOSED') || (secondaryOrder && secondaryOrder.status !== 'CLOSED') ||
    (master?.items || []).some(i => i.status !== 'SERVED') ||
    (secondaryOrder?.items || []).some(i => i.status !== 'SERVED') ||
    queue('DONE').length !== expectedDone || queue().length)
    throw new Error('CLEANUP REQUIRED: final merged fixture mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL010',
  test_ref: 'P2-TBL-010', checked_at: new Date().toISOString(),
  scope: 'QA3 API QR item survives table merge; paying master bill releases both tables to CLEANING; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, asserted = false, executed = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/merge']?.post ||
    !spec.paths?.['/api/v1/tables/{table_id}/qr-session']?.post ||
    !spec.paths?.['/api/v1/public/qr/{token}/orders']?.post)
    throw new Error('PENDING_CONTRACT: table merge or QR session/order absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
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
  for (const x of [owned.primary, owned.secondary])
    x.sessionId = must(post(`/api/v1/tables/${x.tableId}/open-session`, 'waiter',
      { guest_count: 1 }), 201, `open ${x.code}`).id;
  owned.primary.orderId = must(post('/api/v1/orders', 'cashier',
    { table_session_id: owned.primary.sessionId }), 201, 'create primary order').id;
  const added = must(post(`/api/v1/orders/${owned.primary.orderId}/items`, 'cashier',
    { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL010 POS' }] }), 201, 'add POS item');
  owned.primary.itemId = added.items?.find(i => i.menu_item_id === owned.menuId)?.id;
  if (!owned.primary.itemId) throw new Error('CLEANUP REQUIRED: POS item id unavailable');
  must(post(`/api/v1/orders/${owned.primary.orderId}/send-to-kitchen`, 'waiter'), 200, 'send POS item');
  const qr = must(post(`/api/v1/tables/${owned.secondary.tableId}/qr-session`, 'waiter'), 201, 'issue secondary QR');
  owned.qrToken = qr.token; owned.qrIssued = !!qr.token;
  if (!owned.qrToken || qr.table_session_id !== owned.secondary.sessionId)
    throw new Error('CLEANUP REQUIRED: QR token/session missing or mismatched');
  must(post(`/api/v1/public/qr/${owned.qrToken}/orders`, null,
    { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL010 QR' }] }), 201, 'submit QR item');
  const secondaryRows = (table(owned.secondary).orders || []).filter(o =>
    o.table_session_id === owned.secondary.sessionId);
  if (secondaryRows.length !== 1) throw new Error('CLEANUP REQUIRED: QR order not uniquely identified');
  owned.secondary.orderId = secondaryRows[0].id;
  const qrItems = order(owned.secondary).items.filter(i => i.source === 'QR');
  if (qrItems.length !== 1) throw new Error('CLEANUP REQUIRED: QR item not uniquely identified');
  owned.secondary.itemId = qrItems[0].id;
  must(post(`/api/v1/orders/${owned.secondary.orderId}/send-to-kitchen`, 'waiter'), 200, 'send QR item');
  for (const x of [owned.primary, owned.secondary]) {
    const tickets = queue().filter(t => t.order_id === x.orderId);
    if (tickets.length !== 1) throw new Error(`PENDING_FIXTURE: ${x.code} ticket unavailable`);
    x.ticketId = tickets[0].id;
  }
  const before = [owned.primary, owned.secondary].map(x => order(x));
  const beforeTickets = queue();
  if (beforeTickets.length !== 2 || before.some((o, n) => o.table_session_id !==
    [owned.primary, owned.secondary][n].sessionId || o.items?.length !== 1))
    throw new Error('PENDING_FIXTURE: independent orders/tickets not established');
  const expectedSubtotal = before.reduce((sum, o) => sum + Math.round(Number(o.subtotal) * 100), 0);
  executed = true;
  const result = must(post(`/api/v1/tables/${owned.primary.tableId}/merge`, 'waiter',
    { table_ids: [owned.secondary.tableId] }), 200, 'merge occupied tables');
  const masterTable = table(owned.primary), mergedTable = table(owned.secondary);
  const master = order(owned.primary), sourceOrder = order(owned.secondary), tickets = queue();
  const revoked = get(`/api/v1/public/qr/${owned.qrToken}`);
  if (revoked.http === 401) owned.qrIssued = false;
  report.checks = {
    merge_http_200: true,
    master_session: result.table_session_id === owned.primary.sessionId &&
      masterTable.current_session?.id === owned.primary.sessionId &&
      masterTable.current_session?.guest_count === 2 && !mergedTable.current_session,
    secondary_merged: mergedTable.status === 'MERGED' &&
      mergedTable.merged_into_table_id === owned.primary.tableId &&
      result.merged_tables?.some(t => t.id === owned.secondary.tableId),
    qr_item_in_master_bill: result.order_id === owned.primary.orderId &&
      master.items.length === 2 && [owned.primary.itemId, owned.secondary.itemId]
        .every(id => master.items.some(i => i.id === id)) &&
      master.items.some(i => i.id === owned.secondary.itemId && i.source === 'QR') &&
      Math.round(Number(master.subtotal) * 100) === expectedSubtotal &&
      sourceOrder.status === 'CLOSED' && sourceOrder.items.length === 0,
    tickets_follow_items: tickets.length === 2 &&
      [owned.primary.ticketId, owned.secondary.ticketId].every(id => tickets.some(t => t.id === id)) &&
      tickets.every(t => t.order_id === owned.primary.orderId && t.table_code === owned.primary.code),
    secondary_qr_revoked: revoked.http === 401,
  };
  report.primary_table = owned.primary.code; report.secondary_table = owned.secondary.code;
  report.master_session_id = owned.primary.sessionId;
  report.master_order_id = owned.primary.orderId; report.source_order_id = owned.secondary.orderId;
  if (!Object.values(report.checks).every(Boolean)) throw new Error('QR item, merge, ticket or revoked token mismatch');
  for (const item of order(owned.primary).items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order(owned.primary).items.find(i => i.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${owned.primary.orderId}/items/${item.id}/${action}`, role), 200, action);
    }
  }
  if (order(owned.primary).items.some(i => i.status !== 'SERVED'))
    throw new Error('Merged items could not complete before billing');
  must(post(`/api/v1/orders/${owned.primary.orderId}/request-billing`, 'waiter'), 200, 'request billing');
  const paid = must(post(`/api/v1/orders/${owned.primary.orderId}/pay`, 'cashier'), 200, 'simulated cash pay');
  const paidPrimary = table(owned.primary), paidSecondary = table(owned.secondary);
  report.checks.paid_master_bill = paid.status === 'PAID' &&
    Math.round(Number(paid.subtotal) * 100) === expectedSubtotal &&
    paid.items?.some(i => i.id === owned.secondary.itemId && i.source === 'QR');
  report.checks.both_tables_cleaning = paidPrimary.status === 'CLEANING' &&
    paidSecondary.status === 'CLEANING' && !paidPrimary.current_session &&
    !paidSecondary.current_session && !paidSecondary.merged_into_table_id;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Paid bill or both CLEANING table states mismatch');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.primary.sessionId || owned.secondary.sessionId)
    try { cleanupPass = cleanup(); }
    catch (error) { failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.orders_closed = cleanupPass; report.tables_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
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
