// P2-MON-005: isolated WAITER -> CASHIER role change and sensitive payment guard.
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const seed = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output || !seed || !/^[a-f0-9]{40}$/.test(expected || '')) {
  console.error('Usage: set P2_QA_SEED_PASSWORD and full POS_EXPECTED_COMMIT privately; node scripts/p2_mon_005_role_change_payment_isolated.mjs OUTPUT.json');
  process.exit(2);
}

const tokens = {};
const owned = { staffId: null, username: null, password: null, outletId: null,
  tableId: null, menuId: null, sessionId: null, orderId: null };
function redact(value) {
  let safe = String(value).replaceAll(seed, '<REDACTED>');
  if (owned.password) safe = safe.replaceAll(owned.password, '<REDACTED>');
  for (const token of Object.values(tokens)) safe = safe.replaceAll(token, '<REDACTED>');
  return safe;
}
function call(method, path, role, body) {
  const args = ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', '-X', method];
  if (role) args.push('-H', `Authorization: Bearer ${tokens[role]}`);
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (!['GET', 'HEAD'].includes(method)) args.push('-H', `Idempotency-Key: ${randomUUID()}`);
  args.push(base + path);
  const raw = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 3_000_000,
  });
  const split = raw.lastIndexOf('\n');
  const http = Number(raw.slice(split + 1));
  let data;
  try { data = raw.slice(0, split) ? JSON.parse(raw.slice(0, split)) : null; }
  catch { data = null; }
  return { http, data };
}
function must(response, http, label) {
  if (response.http !== http) throw new Error(`${label} HTTP ${response.http}, expected ${http}`);
  return response.data;
}
const get = (path, role) => call('GET', path, role);
const post = (path, role, body) => call('POST', path, role, body);
const patch = (path, role, body) => call('PATCH', path, role, body);
const version = () => must(get('/version'), 200, 'version').commit;
const table = () => must(get(`/api/v1/tables/${owned.tableId}`, 'waiter'), 200, 'table');
const order = () => must(get(`/api/v1/orders/${owned.orderId}`, 'admin'), 200, 'order');
const ledger = () => must(get(`/api/v1/orders/${owned.orderId}/payments`, 'admin'), 200, 'payments');
const audit = (path) => must(get(`/api/v1/audit-logs?${path}`, 'admin'), 200, 'audit');
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('PENDING_CONTRACT: kitchen queue is not an array');
  return rows.filter(row => row.order_id === owned.orderId);
}
function finishItems() {
  for (const item of order().items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'],
      ['PICKED_UP', 'served', 'waiter']]) {
      if (order().items.find(row => row.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${owned.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
  }
}
function cleanupOrder() {
  if (!owned.sessionId) return true;
  if (!owned.orderId) {
    const current = table();
    if (current.current_session?.id !== owned.sessionId)
      throw new Error('CLEANUP REQUIRED: own session no longer on Q3-1');
    const rows = (current.orders || []).filter(row => row.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.orderId = rows[0].id;
    else if (!rows.length) owned.orderId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: owned.sessionId }), 201, 'cleanup create').id;
    else throw new Error('CLEANUP REQUIRED: ambiguous own order');
  }
  let current = order();
  if (current.table_session_id !== owned.sessionId)
    throw new Error('CLEANUP REQUIRED: order session mismatch');
  if (current.status !== 'CLOSED') {
    if (!current.items?.length) {
      must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2MON005 cleanup' }] }),
      201, 'cleanup add');
      current = order();
    }
    if (current.items.some(item => item.status === 'CREATED'))
      must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
    finishItems();
    if (order().items.some(item => item.status !== 'SERVED'))
      throw new Error('CLEANUP REQUIRED: unserved item');
    if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
      must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
    if (!['PAID', 'CLOSED'].includes(order().status))
      must(post(`/api/v1/orders/${owned.orderId}/pay`, 'admin'), 200, 'cleanup simulated pay');
    if (order().status !== 'CLOSED')
      must(post(`/api/v1/orders/${owned.orderId}/close`, 'admin'), 200, 'cleanup close');
  }
  if (table().status === 'CLEANING')
    must(post(`/api/v1/tables/${owned.tableId}/mark-clean`, 'waiter'), 200, 'mark clean');
  const finalTable = table(), finalOrder = order();
  if (finalTable.status !== 'AVAILABLE' || finalTable.current_session ||
    finalOrder.status !== 'CLOSED' || finalOrder.items.some(item => item.status !== 'SERVED') ||
    queue().length || queue('DONE').length !== finalOrder.items.length)
    throw new Error('CLEANUP REQUIRED: final QA3 order/table/ticket mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2MON005',
  test_ref: 'P2-MON-005', checked_at: new Date().toISOString(), result: 'INCONCLUSIVE',
  scope: 'QA3 isolated WAITER to CASHIER role change: old token denied, fresh payment authorized, protected staff route denied, money/state/audit and owned cleanup; no external log/Sentry access',
  secrets_recorded: false, checks: {} };
let buildBefore, buildAfter, asserted = false, executed = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (buildBefore !== expected) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  for (const path of ['/api/v1/staff', '/api/v1/staff/{staff_id}',
    '/api/v1/orders/{order_id}/payments', '/api/v1/audit-logs']) {
    if (!spec.paths?.[path]) throw new Error(`PENDING_CONTRACT: ${path} absent`);
  }
  for (const [role, username] of [['admin', 'qa3_admin'], ['waiter', 'qa3_waiter'],
    ['kitchen', 'qa3_kitchen']]) {
    const login = must(post('/api/v1/auth/login', null, { username, password: seed }), 200, `${role} login`);
    if (!login.access_token) throw new Error(`PENDING_AUTH: ${role} token absent`);
    tokens[role] = login.access_token;
  }
  const adminMe = must(get('/api/v1/auth/me', 'admin'), 200, 'admin me');
  if (adminMe.role !== 'SUPERVISOR' || !adminMe.outlet_id)
    throw new Error('PENDING_AUTH: QA3 supervisor mismatch');
  owned.outletId = adminMe.outlet_id;
  const matches = must(get('/api/v1/tables', 'waiter'), 200, 'tables')
    .filter(row => row.code === 'Q3-1' && row.status === 'AVAILABLE');
  const menu = must(get('/api/v1/menu?available_only=true', 'admin'), 200, 'menu');
  owned.menuId = menu.find(row => row.is_available && row.station_id && !row.has_modifiers)?.id;
  if (matches.length !== 1 || !owned.menuId)
    throw new Error('PENDING_FIXTURE: Q3-1 AVAILABLE and mapped menu item required');
  owned.tableId = matches[0].id;
  owned.username = `qa_p2mon005_${Date.now()}_${randomBytes(3).toString('hex')}`;
  owned.password = randomBytes(24).toString('hex');
  report.fixture_username = owned.username;
  const staff = must(post('/api/v1/staff', 'admin', { username: owned.username,
    password: owned.password, full_name: 'QA P2MON005 isolated', role: 'WAITER' }), 201, 'create staff');
  owned.staffId = staff.id;
  report.fixture_staff_id = owned.staffId;
  if (!owned.staffId || staff.outlet_id !== owned.outletId)
    throw new Error('CLEANUP REQUIRED: created staff identity mismatch');
  const firstLogin = must(post('/api/v1/auth/login', null,
    { username: owned.username, password: owned.password }), 200, 'old role login');
  tokens.old = firstLogin.access_token;
  const beforeRole = must(get('/api/v1/auth/me', 'old'), 200, 'WAITER me');
  if (!tokens.old || beforeRole.id !== owned.staffId || beforeRole.role !== 'WAITER' ||
    beforeRole.permissions?.includes('PROCESS_PAYMENT'))
    throw new Error('PENDING_AUTH: initial WAITER role/permission mismatch');
  owned.sessionId = must(post(`/api/v1/tables/${owned.tableId}/open-session`, 'waiter',
    { guest_count: 1 }), 201, 'open own session').id;
  owned.orderId = must(post('/api/v1/orders', 'waiter',
    { table_session_id: owned.sessionId }), 201, 'create own order').id;
  const added = must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
    { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2MON005 own' }] }), 201, 'add item');
  if (added.items?.length !== 1) throw new Error('PENDING_FIXTURE: own item absent');
  must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'send to kitchen');
  finishItems();
  must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'request billing');
  const before = order(), due = (Math.round(Number(before.amount_due) * 100) / 100).toFixed(2);
  if (before.status !== 'BILLING' || Number(due) <= 0 || queue('DONE').length !== 1)
    throw new Error('PENDING_FIXTURE: served BILLING order required');
  const payload = { method: 'CASH', amount: due, cash_received: due };
  executed = true;
  const deniedBefore = post(`/api/v1/orders/${owned.orderId}/payments`, 'old', payload);
  const ledgerBefore = ledger();
  const deniedAudit = audit(`action=PAYMENT_RECORDED&entity_id=${owned.orderId}`);
  const deniedNoMutation = deniedBefore.http === 403 && order().status === 'BILLING' &&
    Number(order().amount_due) === Number(due) && table().status === 'BILLING' &&
    ledgerBefore.payments?.length === 0 && deniedAudit.length === 0;
  if (!deniedNoMutation) throw new Error('Initial WAITER payment denial/state mismatch');
  const changed = must(patch(`/api/v1/staff/${owned.staffId}`, 'admin',
    { role: 'CASHIER' }), 200, 'role change');
  if (changed.role !== 'CASHIER') throw new Error('Role change did not persist');
  const oldMe = get('/api/v1/auth/me', 'old');
  const oldPayment = post(`/api/v1/orders/${owned.orderId}/payments`, 'old', payload);
  const revokedNoMutation = oldMe.http === 401 && oldPayment.http === 401 &&
    order().status === 'BILLING' && ledger().payments?.length === 0 && table().status === 'BILLING';
  const secondLogin = must(post('/api/v1/auth/login', null,
    { username: owned.username, password: owned.password }), 200, 'new role login');
  tokens.fresh = secondLogin.access_token;
  const fresh = must(get('/api/v1/auth/me', 'fresh'), 200, 'CASHIER me');
  const roleApplied = !!tokens.fresh && fresh.id === owned.staffId &&
    fresh.outlet_id === owned.outletId && fresh.role === 'CASHIER' &&
    fresh.permissions?.includes('PROCESS_PAYMENT');
  const protectedStaff = get('/api/v1/staff', 'fresh');
  const paid = post(`/api/v1/orders/${owned.orderId}/payments`, 'fresh', payload);
  const paidLedger = ledger(), paidOrder = order(), paidTable = table();
  const staffAudit = audit(`entity_id=${owned.staffId}&entity_type=staff&limit=100`);
  const paymentAudit = audit(`action=PAYMENT_RECORDED&entity_id=${owned.orderId}`);
  const roleRows = staffAudit.filter(row => row.action === 'STAFF_UPDATED' &&
    row.entity_id === owned.staffId);
  const paymentRows = paymentAudit.filter(row => row.action === 'PAYMENT_RECORDED' &&
    row.entity_id === owned.orderId && row.staff_id === owned.staffId &&
    row.payload?.payment_id === paid.data?.payment?.id);
  report.http = { waiter_payment: deniedBefore.http, old_token_me: oldMe.http,
    old_token_payment: oldPayment.http, fresh_staff_list: protectedStaff.http,
    fresh_payment: paid.http };
  report.checks = { distinct_role_and_outlet: roleApplied,
    initial_denial_unchanged: deniedNoMutation,
    old_token_revoked_no_mutation: revokedNoMutation,
    cashier_staff_admin_route_denied: protectedStaff.http === 403,
    fresh_cashier_payment: paid.http === 201 && paid.data?.order_status === 'PAID' &&
      paid.data?.payment?.created_by_staff_id === owned.staffId &&
      paidLedger.payments?.length === 1 &&
      paidLedger.payments[0].id === paid.data?.payment?.id &&
      Math.round(Number(paidLedger.summary?.paid) * 100) === Math.round(Number(due) * 100) &&
      Number(paidLedger.summary?.remaining) === 0 && paidOrder.status === 'PAID' &&
      paidTable.status === 'CLEANING' && !paidTable.current_session,
    role_change_audit_once: roleRows.length === 1 && roleRows[0].staff_id === adminMe.id &&
      Number.isFinite(Date.parse(roleRows[0].created_at)),
    payment_audit_once: paymentRows.length === 1 &&
      Number.isFinite(Date.parse(paymentRows[0].created_at)),
    audit_secrets_absent: ![seed, owned.password, ...Object.values(tokens)].some(secret =>
      secret && (JSON.stringify(staffAudit).includes(secret) || JSON.stringify(paymentAudit).includes(secret))),
  };
  report.order_id = owned.orderId;
  report.payment_id = paid.data?.payment?.id ?? null;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Role-change sensitive API, state or audit assertion failed');
} catch (error) { failure = redact(error.message || error); }
finally {
  let orderClean = false, staffClean = false;
  if (owned.sessionId) try { orderClean = cleanupOrder(); }
  catch (error) { failure = `${failure ? failure + '; ' : ''}${redact(error.message || error)}`; }
  else orderClean = true;
  if (owned.staffId && tokens.admin) try {
    const lock = post(`/api/v1/staff/${owned.staffId}/lock`, 'admin');
    const staff = must(get(`/api/v1/staff/${owned.staffId}`, 'admin'), 200, 'verify staff lock');
    const stale = tokens.fresh ? get('/api/v1/auth/me', 'fresh').http : null;
    const lockRows = audit(`entity_id=${owned.staffId}&entity_type=staff&limit=100`)
      .filter(row => row.action === 'STAFF_LOCKED' && row.entity_id === owned.staffId);
    staffClean = lock.http === 200 && staff.is_active === false &&
      (!tokens.fresh || stale === 401) && lockRows.length === 1;
    report.staff_cleanup = { lock_http: lock.http, locked: staff.is_active === false,
      fresh_token_after_lock_http: stale, lock_audit_once: lockRows.length === 1 };
  } catch (error) { failure = `${failure ? failure + '; ' : ''}${redact(error.message || error)}`; }
  else staffClean = !owned.staffId;
  cleanupPass = orderClean && staffClean;
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null;
  report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass;
  report.order_closed = !!owned.sessionId && orderClean;
  report.table_available = !!owned.sessionId && orderClean;
  report.staff_locked = staffClean;
  report.result = !cleanupPass ? 'INCONCLUSIVE' : !report.build_stable ? 'PENDING' :
    /^PENDING_/.test(failure || '') ? 'PENDING' :
    asserted && report.build_stable ? 'PASSED' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass) report.cleanup_required = { table_code: 'Q3-1', session_id: owned.sessionId,
    order_id: owned.orderId, staff_id: owned.staffId, no_global_reset: true };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  owned.password = undefined;
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
