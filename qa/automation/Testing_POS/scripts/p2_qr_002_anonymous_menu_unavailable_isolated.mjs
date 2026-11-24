// P2-QR-002: anonymous customer menu, outlet catalog, unavailable item denial.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.P2_QA_SEED_PASSWORD || process.env.S2_STAGING_PIN;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17' || !pin ||
    !/^[0-9a-f]{40}$/.test(expected || '') || !output)
  throw Error('QA staging, private PIN, full POS_EXPECTED_COMMIT and output required');
const tokens = {}, own = {};
const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2QR002',
  test_ref: 'P2-QR-002', checked_at: new Date().toISOString(),
  scope: 'QA3 anonymous customer browser reads owned QR menu with correct outlet names/categories/prices; unavailable QA item cannot be selected or submitted; order, ledger, audit unchanged; owned cleanup.',
  token_recorded: false, secrets_recorded: false, checks: {}, cleanup_pass: false };
const safe = error => {
  let msg = String(error);
  for (const value of [pin, own.token, ...Object.values(tokens)])
    if (value) msg = msg.replaceAll(value, '<REDACTED>');
  return msg;
};
async function call(method, path, role, data) {
  const headers = { Accept: 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + tokens[role];
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
  const response = await fetch(base + path, { method, headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(25_000) });
  return { http: response.status, body: await response.json().catch(() => null) };
}
async function must(method, path, role, status, data) {
  const r = await call(method, path, role, data);
  if (r.http !== status) throw Error(method + ' ' + path.replace(own.token || '___', '<TOKEN>') +
    ': HTTP ' + r.http + ', expected ' + status);
  return r.body;
}
async function version() {
  const v = await must('GET', '/version', null, 200);
  if (v.environment !== 'staging') throw Error('Wrong environment');
  return v.commit;
}
const table = () => must('GET', '/api/v1/tables/' + own.tableId, 'waiter', 200);
const order = () => must('GET', '/api/v1/orders/' + own.orderId, 'cashier', 200);
const payments = () => must('GET', '/api/v1/orders/' + own.orderId + '/payments', 'cashier', 200);
const audit = () => must('GET', '/api/v1/audit-logs?order_id=' + own.orderId +
  '&limit=100', 'admin', 200);
async function cleanup() {
  const state = { menu_archived: true, order_closed: !own.sessionId,
    table_available: !own.sessionId, no_active_ticket: true };
  if (own.sessionId) {
    const t = await table();
    if (t.current_session?.id !== own.sessionId)
      throw Error('CLEANUP REQUIRED: session ownership changed');
    if (own.token) await must('DELETE', '/api/v1/tables/' + own.tableId +
      '/qr-session', 'admin', 204);
    const ids = [...new Set((t.orders || []).filter(row =>
      row.table_session_id === own.sessionId).map(row => row.id))];
    if (ids.length > 1 || ids.some(id => own.orderId && id !== own.orderId))
      throw Error('CLEANUP REQUIRED: unexpected order');
    own.orderId ||= ids[0] || (await must('POST', '/api/v1/orders', 'waiter',
      201, { table_session_id: own.sessionId })).id;
    let current = await order();
    if (current.table_session_id !== own.sessionId) throw Error('CLEANUP REQUIRED: order ownership');
    if (!current.items.length) {
      await must('POST', '/api/v1/orders/' + own.orderId + '/items', 'waiter', 201,
        { items: [{ menu_item_id: own.availableId, quantity: 1,
          note: 'P2-QR-002 owned cleanup' }] });
      current = await order();
    }
    if (current.status === 'NEW' || current.items.some(row => row.status === 'CREATED'))
      await must('POST', '/api/v1/orders/' + own.orderId + '/send-to-kitchen',
        'waiter', 200);
    for (const item of (await order()).items) {
      for (const [status, action, role] of [
        ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
        ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
        if ((await order()).items.find(row => row.id === item.id)?.status === status)
          await must('POST', '/api/v1/orders/' + own.orderId + '/items/' +
            item.id + '/' + action, role, 200);
      }
    }
    if ((await order()).items.some(row => row.status !== 'SERVED'))
      throw Error('CLEANUP REQUIRED: items not served');
    if (!['BILLING', 'PAID', 'CLOSED'].includes((await order()).status))
      await must('POST', '/api/v1/orders/' + own.orderId + '/request-billing', 'waiter', 200);
    if ((await order()).status === 'BILLING')
      await must('POST', '/api/v1/orders/' + own.orderId + '/pay', 'cashier', 200);
    if ((await order()).status === 'PAID')
      await must('POST', '/api/v1/orders/' + own.orderId + '/close', 'cashier', 200);
    if ((await table()).status === 'CLEANING')
      await must('POST', '/api/v1/tables/' + own.tableId + '/mark-clean', 'waiter', 200);
    const finalTable = await table();
    const queue = await must('GET', '/api/v1/kitchen/queue', 'kitchen', 200);
    state.order_closed = (await order()).status === 'CLOSED';
    state.table_available = finalTable.status === 'AVAILABLE' && !finalTable.current_session;
    state.no_active_ticket = !queue.some(row => row.order_id === own.orderId);
  }
  if (own.inactiveId) {
    const items = await must('GET', '/api/v1/menu?available_only=false', 'admin', 200);
    const item = items.find(row => row.id === own.inactiveId);
    if (!item) throw Error('CLEANUP REQUIRED: unavailable item missing');
    if (item.is_available) await must('PATCH', '/api/v1/menu/' + own.inactiveId,
      'admin', 200, { is_available: false });
    state.menu_archived = (await must('GET', '/api/v1/menu?available_only=false',
      'admin', 200)).some(row => row.id === own.inactiveId && !row.is_available);
  }
  report.cleanup_state = state;
  return Object.values(state).every(Boolean);
}

let before, browser, failure, cleanupError;
try {
  before = await version();
  if (before !== expected) throw Error('PENDING_BUILD: staging SHA differs from pinned value');
  report.staging_commit = before;
  for (const [role, username, expectedRole] of [
    ['admin', 'qa3_admin', 'SUPERVISOR'], ['waiter', 'qa3_waiter', 'WAITER'],
    ['cashier', 'qa3_cashier', 'CASHIER'], ['kitchen', 'qa3_kitchen', 'KITCHEN']]) {
    const login = await must('POST', '/api/v1/auth/login', null, 200,
      { username, password: pin });
    if (login.staff?.role !== expectedRole || !login.access_token)
      throw Error('PENDING_FIXTURE: QA3 ' + role + ' role missing');
    tokens[role] = login.access_token;
  }
  const tables = await must('GET', '/api/v1/tables', 'waiter', 200);
  const t = tables.find(row => row.code === 'Q3-1' && row.status === 'AVAILABLE');
  if (!t) throw Error('PENDING_FIXTURE: Q3-1 unavailable');
  own.tableId = t.id;
  const available = await must('GET', '/api/v1/menu?available_only=true', 'waiter', 200);
  const all = await must('GET', '/api/v1/menu?available_only=false', 'admin', 200);
  const categories = await must('GET', '/api/v1/menu/categories?active_only=true',
    'admin', 200);
  const control = available.find(row => row.is_available && row.station_id &&
    !row.has_modifiers && Number(row.price) > 0);
  if (!control || !categories.length)
    throw Error('PENDING_FIXTURE: mapped available item or category missing');
  own.availableId = control.id;
  const inactive = all.find(row => !row.is_available && /^QA[ _-]/i.test(row.name) &&
    row.station_id &&
    categories.some(category => category.id === row.category_id));
  if (inactive) { own.inactiveId = inactive.id; own.inactiveName = inactive.name; }
  else {
    own.inactiveName = 'QA P2QR002 unavailable ' + randomUUID().slice(0, 8);
    const created = await must('POST', '/api/v1/menu', 'admin', 201,
      { name: own.inactiveName, price: '31700.00', category_id: control.category_id,
        station_id: control.station_id, is_available: false });
    own.inactiveId = created.id;
    if (!own.inactiveId || created.is_available !== false)
      throw Error('CLEANUP REQUIRED: unavailable item fixture incomplete');
    report.menu_fixture_created = true;
  }
  own.sessionId = (await must('POST', '/api/v1/tables/' + own.tableId +
    '/open-session', 'waiter', 201, { guest_count: 1 })).id;
  own.orderId = (await must('POST', '/api/v1/orders', 'waiter', 201,
    { table_session_id: own.sessionId })).id;
  const issued = await must('POST', '/api/v1/tables/' + own.tableId +
    '/qr-session', 'admin', 201);
  own.token = issued.token;
  if (!own.token || issued.table_session_id !== own.sessionId ||
      issued.path !== '/qr/' + own.token)
    throw Error('PENDING_CONTRACT: QR token/session/path mismatch');
  const publicPath = '/api/v1/public/qr/' + encodeURIComponent(own.token);
  const info = await must('GET', publicPath, null, 200);
  const publicMenu = await must('GET', publicPath + '/menu', null, 200);
  if (!Array.isArray(publicMenu.items) || !Array.isArray(publicMenu.categories))
    throw Error('PENDING_CONTRACT: public QR menu shape changed');
  const offered = publicMenu.items.filter(row => row.is_available);
  const mapped = offered.every(row => available.some(server => server.id === row.id &&
    server.name === row.name && Number(server.price) === Number(row.price) &&
    server.category_id === row.category_id));
  const categoriesMapped = publicMenu.categories.every(row =>
    categories.some(server => server.id === row.id && server.name === row.name)) &&
    offered.every(row => publicMenu.categories.some(category =>
      category.id === row.category_id));
  const beforeOrder = await order();
  const beforeLedger = await payments();
  const beforeAudit = await audit();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const observed = { anonymous: true, writes: 0 };
    page.on('request', request => {
      if (!new URL(request.url()).pathname.startsWith('/api/v1/public/qr/')) return;
      if (request.headers().authorization) observed.anonymous = false;
      if (!['GET', 'HEAD'].includes(request.method())) observed.writes++;
    });
    await page.goto(base + issued.path, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await expect(page.getByTestId('qr-table')).toHaveText('Bàn Q3-1');
    for (const item of offered) {
      const row = page.getByTestId('qr-menu-item').filter({
        has: page.getByRole('button', { name: 'Thêm ' + item.name, exact: true }),
      });
      await expect(row).toHaveCount(1);
      await expect(row.locator('.nova-qr-item-text small')).toContainText(
        new Intl.NumberFormat('vi-VN').format(Number(item.price)));
    }
    const disabled = page.getByTestId('qr-menu-item').filter({ hasText: own.inactiveName });
    const addDisabled = disabled.getByRole('button',
      { name: 'Thêm ' + own.inactiveName, exact: true });
    report.checks.unavailable_not_selectable = (await addDisabled.count()) === 0 ||
      !(await addDisabled.isEnabled());
    report.checks.anonymous_menu_ui = observed.anonymous && observed.writes === 0 &&
      offered.length > 0 && mapped && categoriesMapped && info.table_code === 'Q3-1' &&
      (await page.getByTestId('qr-menu-item').count()) === publicMenu.items.length;
    report.ui_writes = observed.writes;
    mkdirSync(dirname(output), { recursive: true });
    const screenshot = 'P2_QR_002_' + report.run_id + '.png';
    await page.screenshot({ path: join(dirname(output), screenshot), fullPage: true });
    report.screenshot = screenshot;
  } finally { await context.close(); }
  const denied = await call('POST', publicPath + '/orders', null,
    { items: [{ menu_item_id: own.inactiveId, quantity: 1 }] });
  const afterOrder = await order();
  const afterLedger = await payments();
  const afterAudit = await audit();
  const businessAudit = rows => rows.filter(row =>
    /^(ORDER|PAYMENT)_/.test(row.action)).map(row => row.id).sort();
  report.unavailable_submit_http = denied.http;
  report.checks.unavailable_submit_denied = [409, 422].includes(denied.http) &&
    afterOrder.current_version === beforeOrder.current_version &&
    JSON.stringify(afterOrder.items) === JSON.stringify(beforeOrder.items) &&
    JSON.stringify(afterLedger) === JSON.stringify(beforeLedger) &&
    JSON.stringify(businessAudit(afterAudit)) ===
      JSON.stringify(businessAudit(beforeAudit)) &&
    (await table()).current_session?.id === own.sessionId;
  if (!Object.values(report.checks).every(Boolean))
    throw Error('QR anonymous menu or unavailable item mismatch: ' +
      JSON.stringify(report.checks));
  report.business_execution = 'EXECUTED';
} catch (error) { failure = safe(error); }
try { await browser?.close(); } catch (error) { failure ||= safe(error); }
try { report.cleanup_pass = await cleanup(); } catch (error) { cleanupError = safe(error); }
if (report.menu_fixture_created) report.menu_record_retained_inactive =
  report.cleanup_state?.menu_archived === true;
try { report.build_after = await version(); } catch { report.build_after = null; }
report.build_stable = before === report.build_after;
report.result = !failure && !cleanupError && report.cleanup_pass && report.build_stable ?
  'PASSED' : cleanupError || !report.cleanup_pass ? 'INCONCLUSIVE' :
    failure?.startsWith('Error: PENDING_') ? 'PENDING' : 'FAILED';
if (failure) report.error = failure;
if (cleanupError) report.cleanup_required = cleanupError;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('[P2-QR-002] Result: ' + JSON.stringify(report));
if (report.result !== 'PASSED') process.exitCode = 1;
