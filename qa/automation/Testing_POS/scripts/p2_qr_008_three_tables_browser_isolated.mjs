// P2-QR-008: three owned QR sessions in QA3/QA2, public API and anonymous browser.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.P2_QA_SEED_PASSWORD || process.env.S2_STAGING_PIN;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw Error('QA staging only');
if (!pin || !/^[a-f0-9]{40}$/.test(expected || '') || !output)
  throw Error('Private QA PIN, full POS_EXPECTED_COMMIT and output path required');

const roles = {};
const fixtures = [
  { code: 'Q3-1', outlet: 'qa3', label: 'A' },
  { code: 'Q3-2', outlet: 'qa3', label: 'B' },
  { code: 'Q2-1', outlet: 'qa2', label: 'C' },
];
const report = {
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2QR008',
  test_ref: 'P2-QR-008', checked_at: new Date().toISOString(),
  scope: 'Three owned QR table sessions (QA3 A/B, QA2 C): public /order and anonymous customer UI expose only the token table, staff cross-outlet GET denied; owned cleanup. No public order-ID route in contract.',
  token_recorded: false, secrets_recorded: false, checks: {}, cleanup_pass: false,
};
const redact = error => {
  let value = String(error);
  for (const secret of [pin, ...Object.values(roles), ...fixtures.map(f => f.token)])
    if (secret) value = value.replaceAll(secret, '<REDACTED>');
  return value;
};
async function req(method, path, role, data) {
  const headers = { Accept: 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + roles[role];
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['Idempotency-Key'] = randomUUID();
  const response = await fetch(base + path, {
    method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(25_000),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { http: response.status, body };
}
async function must(method, path, role, http, data, label) {
  const result = await req(method, path, role, data);
  if (result.http !== http)
    throw Error((label || method) + ': HTTP ' + result.http + ', expected ' + http);
  return result.body;
}
const version = async () => {
  const build = await must('GET', '/version', null, 200);
  if (build.environment !== 'staging') throw Error('Wrong environment');
  return build.commit;
};
const table = f => must('GET', '/api/v1/tables/' + f.tableId, f.outlet + '_admin', 200);
const order = f => must('GET', '/api/v1/orders/' + f.orderId, f.outlet + '_cashier', 200);
async function cleanup(f) {
  if (!f.sessionId) return true;
  const role = f.outlet + '_admin';
  const currentTable = await table(f);
  if (currentTable.current_session?.id !== f.sessionId &&
      !(currentTable.status === 'CLEANING' && !currentTable.current_session && f.orderId))
    throw Error('CLEANUP REQUIRED: ' + f.code + ' session ownership changed');
  if (f.token && currentTable.current_session?.id === f.sessionId) {
    await must('DELETE', '/api/v1/tables/' + f.tableId + '/qr-session', role, 204,
      undefined, 'cleanup QR revoke');
  }
  const ids = [...new Set((currentTable.orders || [])
    .filter(row => row.table_session_id === f.sessionId).map(row => row.id))];
  if (ids.length > 1 || ids.some(id => f.orderId && id !== f.orderId))
    throw Error('CLEANUP REQUIRED: unexpected order for ' + f.code);
  f.orderId ||= ids[0] || (await must('POST', '/api/v1/orders', role, 201,
    { table_session_id: f.sessionId }, 'cleanup create order')).id;
  let current = await order(f);
  if (current.table_session_id !== f.sessionId)
    throw Error('CLEANUP REQUIRED: order/session mismatch');
  if (!current.items.length) {
    await must('POST', '/api/v1/orders/' + f.orderId + '/items', role, 201,
      { items: [{ menu_item_id: f.menuId, quantity: 1, note: 'P2-QR-008 owned cleanup' }] },
      'cleanup item');
    current = await order(f);
  }
  if (current.status === 'NEW')
    await must('POST', '/api/v1/orders/' + f.orderId + '/send-to-kitchen', role, 200,
      undefined, 'cleanup send');
  for (const item of (await order(f)).items) {
    for (const [state, action, actionRole] of [
      ['SENT', 'start-cooking', f.outlet + '_kitchen'],
      ['PREPARING', 'mark-ready', f.outlet + '_kitchen'],
      ['READY', 'pickup', f.outlet + '_waiter'],
      ['PICKED_UP', 'served', f.outlet + '_waiter'],
    ]) {
      if ((await order(f)).items.find(row => row.id === item.id)?.status === state)
        await must('POST', '/api/v1/orders/' + f.orderId + '/items/' + item.id +
          '/' + action, actionRole, 200, undefined, 'cleanup ' + action);
    }
  }
  if ((await order(f)).items.some(item => item.status !== 'SERVED'))
    throw Error('CLEANUP REQUIRED: unserved item on ' + f.code);
  if (!['BILLING', 'PAID', 'CLOSED'].includes((await order(f)).status))
    await must('POST', '/api/v1/orders/' + f.orderId + '/request-billing',
      f.outlet + '_waiter',
      200, undefined, 'cleanup billing');
  if ((await order(f)).status === 'BILLING')
    await must('POST', '/api/v1/orders/' + f.orderId + '/pay', f.outlet + '_cashier',
      200, undefined, 'cleanup pay');
  if ((await order(f)).status === 'PAID')
    await must('POST', '/api/v1/orders/' + f.orderId + '/close', f.outlet + '_cashier',
      200, undefined, 'cleanup close');
  if ((await table(f)).status === 'CLEANING')
    await must('POST', '/api/v1/tables/' + f.tableId + '/mark-clean',
      f.outlet + '_waiter', 200,
      undefined, 'cleanup mark clean');
  const finalTable = await table(f);
  const queue = await must('GET', '/api/v1/kitchen/queue', role, 200);
  return finalTable.status === 'AVAILABLE' && !finalTable.current_session &&
    (await order(f)).status === 'CLOSED' &&
    !queue.some(row => row.order_id === f.orderId);
}

let before, browser, failure, cleanupError;
try {
  before = await version();
  if (before !== expected) throw Error('PENDING_BUILD: staging differs from pinned SHA');
  report.staging_commit = before;
  for (const [name, role] of [
    ['qa3_admin', 'SUPERVISOR'], ['qa3_cashier', 'CASHIER'],
    ['qa3_waiter', 'WAITER'], ['qa3_kitchen', 'KITCHEN'],
    ['qa2_admin', 'SUPERVISOR'], ['qa2_cashier', 'CASHIER'],
    ['qa2_waiter', 'WAITER'], ['qa2_kitchen', 'KITCHEN'],
  ]) {
    const login = await must('POST', '/api/v1/auth/login', null, 200,
      { username: name, password: pin }, name + ' login');
    if (login.staff?.role !== role || !login.access_token)
      throw Error('PENDING_FIXTURE: QA role mismatch ' + name);
    roles[name] = login.access_token;
  }
  const outlets = {};
  for (const outlet of ['qa3', 'qa2']) {
    const me = await must('GET', '/api/v1/auth/me', outlet + '_admin', 200);
    outlets[outlet] = me.outlet_id;
  }
  if (!outlets.qa3 || !outlets.qa2 || outlets.qa3 === outlets.qa2)
    throw Error('PENDING_FIXTURE: distinct outlets required');
  report.outlet_ids = outlets;
  const available = {};
  for (const outlet of ['qa3', 'qa2']) {
    available[outlet] = await must('GET', '/api/v1/tables', outlet + '_admin', 200);
    const menu = await must('GET', '/api/v1/menu?available_only=true',
      outlet + '_admin', 200);
    const item = menu.find(row => row.is_available && row.station_id && !row.has_modifiers);
    if (!item) throw Error('PENDING_FIXTURE: mapped item missing for ' + outlet);
    for (const f of fixtures.filter(row => row.outlet === outlet)) f.menuId = item.id;
  }
  mkdirSync(dirname(output), { recursive: true });
  for (const f of fixtures) {
    const t = available[f.outlet].find(row => row.code === f.code);
    if (!t || t.status !== 'AVAILABLE')
      throw Error('PENDING_FIXTURE: ' + f.code + ' must be AVAILABLE');
    f.tableId = t.id;
  }
  for (const f of fixtures) {
    const role = f.outlet + '_admin';
    f.sessionId = (await must('POST', '/api/v1/tables/' + f.tableId + '/open-session',
      role, 201, { guest_count: 1 }, 'open ' + f.code)).id;
    const issued = await must('POST', '/api/v1/tables/' + f.tableId + '/qr-session',
      role, 201, undefined, 'issue ' + f.code);
    f.token = issued.token;
    if (!f.token || issued.table_session_id !== f.sessionId)
      throw Error('PENDING_FIXTURE: token/session mismatch ' + f.code);
    f.marker = 'QA P2QR008 ' + f.label + ' ' + randomUUID().slice(0, 8);
    const path = '/api/v1/public/qr/' + encodeURIComponent(f.token);
    await must('POST', path + '/orders', null, 201,
      { items: [{ menu_item_id: f.menuId, quantity: 1, note: f.marker }] },
      'public submit ' + f.code);
    const ownOrders = (await table(f)).orders.filter(row =>
      row.table_session_id === f.sessionId);
    if (ownOrders.length !== 1)
      throw Error('CLEANUP REQUIRED: order discovery failed for ' + f.code);
    f.orderId = ownOrders[0].id;
  }
  const reads = [];
  for (const f of fixtures) {
    const path = '/api/v1/public/qr/' + encodeURIComponent(f.token);
    const info = await must('GET', path, null, 200, undefined, 'public info');
    const placed = await must('GET', path + '/order', null, 200, undefined, 'public order');
    reads.push({ code: f.code, matches: info.table_session_id === f.sessionId &&
      placed.items.some(item => item.note === f.marker) &&
      fixtures.filter(other => other !== f).every(other =>
        !placed.items.some(item => item.note === other.marker)) });
  }
  const qa3CannotReadQa2 = await req('GET',
    '/api/v1/orders/' + fixtures[2].orderId, 'qa3_admin');
  const qa2CannotReadQa3 = await req('GET',
    '/api/v1/orders/' + fixtures[0].orderId, 'qa2_admin');
  browser = await chromium.launch({ headless: true });
  const browserChecks = [];
  for (const f of fixtures) {
    const context = await browser.newContext(); // anonymous and isolated
    try {
      const page = await context.newPage();
      await page.goto(base + '/qr/' + encodeURIComponent(f.token),
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const placed = page.getByTestId('qr-placed');
      await expect(placed).toContainText(f.marker, { timeout: 15_000 });
      for (const other of fixtures.filter(row => row !== f))
        await expect(placed).not.toContainText(other.marker);
      await expect(page.getByTestId('qr-table')).toContainText(f.code);
      const imageName = 'P2_QR_008_' + f.label + '_' + report.run_id + '.png';
      await page.screenshot({ path: join(dirname(output), imageName), fullPage: true });
      browserChecks.push({ code: f.code, own_item_only: true, screenshot: imageName });
    } finally { await context.close(); }
  }
  report.browser_checks = browserChecks;
  report.checks = {
    public_api_table_bound: reads.length === 3 && reads.every(row => row.matches),
    anonymous_browser_table_bound: browserChecks.length === 3 &&
      browserChecks.every(row => row.own_item_only),
    staff_cross_outlet_404: qa3CannotReadQa2.http === 404 && qa2CannotReadQa3.http === 404,
    three_owned_orders: fixtures.every(f => !!f.orderId && !!f.sessionId),
  };
  report.http = { qa3_to_qa2_order: qa3CannotReadQa2.http,
    qa2_to_qa3_order: qa2CannotReadQa3.http };
  if (!Object.values(report.checks).every(Boolean))
    throw Error('QR token/table or outlet isolation mismatch');
} catch (error) { failure = redact(error); }
try { await browser?.close(); } catch (error) { failure ||= redact(error); }
const cleanupStates = [];
for (const f of [...fixtures].reverse()) {
  try { cleanupStates.push({ code: f.code, clean: await cleanup(f) }); }
  catch (error) { cleanupStates.push({ code: f.code, clean: false });
    cleanupError = (cleanupError ? cleanupError + '; ' : '') + f.code + ': ' + redact(error); }
}
report.cleanup_state = cleanupStates;
report.cleanup_pass = cleanupStates.every(row => row.clean);
try { report.build_after = await version(); } catch { report.build_after = null; }
report.build_stable = before === report.build_after;
report.result = !failure && !cleanupError && report.cleanup_pass && report.build_stable ?
  'PASSED' : cleanupError || !report.cleanup_pass ? 'INCONCLUSIVE' :
    failure?.startsWith('Error: PENDING_') ? 'PENDING' : 'FAILED';
if (failure) report.error = failure;
if (cleanupError) report.cleanup_required = cleanupError;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('[P2-QR-008] Result: ' + JSON.stringify(report));
if (report.result !== 'PASSED') process.exitCode = 1;
