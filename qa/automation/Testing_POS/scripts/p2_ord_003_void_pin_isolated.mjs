// P2-ORD-003: owned PREPARING item requires a Supervisor PIN for void.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.P2_QA_SEED_PASSWORD || process.env.S2_STAGING_PIN;
const supervisorPin = process.env.P2_SUPERVISOR_VOID_PIN || pin;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17' || !pin ||
    !/^[0-9a-f]{40}$/.test(expected || '') || !output)
  throw Error('QA staging, private PIN, full POS_EXPECTED_COMMIT and output required');
const roles = {}, own = {};
const report = { test_ref: 'P2-ORD-003',
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2ORD003',
  checked_at: new Date().toISOString(),
  scope: 'QA3 owned PREPARING item: missing/wrong Supervisor PIN denied without order/ticket changes; correct PIN voids once, audit actor/time and owned cleanup. PIN contract checked before writes.',
  secrets_recorded: false, token_recorded: false, checks: {}, cleanup_pass: false };
const safe = error => {
  let value = String(error);
  for (const secret of [pin, supervisorPin, ...Object.values(roles)])
    if (secret) value = value.replaceAll(secret, '<REDACTED>');
  return value;
};
async function call(method, path, role, data) {
  const headers = { Accept: 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + roles[role];
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
  const response = await fetch(base + path, { method, headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(25_000) });
  return { http: response.status, body: await response.json().catch(() => null) };
}
async function must(method, path, role, http, data) {
  const r = await call(method, path, role, data);
  if (r.http !== http) throw Error(method + ' ' + path + ': HTTP ' + r.http +
    ', expected ' + http);
  return r.body;
}
async function version() {
  const v = await must('GET', '/version', null, 200);
  if (v.environment !== 'staging') throw Error('Wrong environment');
  return v.commit;
}
const table = () => must('GET', '/api/v1/tables/' + own.tableId, 'waiter', 200);
const order = () => must('GET', '/api/v1/orders/' + own.orderId, 'cashier', 200);
const queue = () => must('GET', '/api/v1/kitchen/queue', 'kitchen', 200);
const audit = () => must('GET', '/api/v1/audit-logs?order_id=' + own.orderId +
  '&limit=100', 'admin', 200);
function properties(schema, components, seen = new Set()) {
  if (!schema) return {};
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {};
    seen.add(schema.$ref);
    return properties(components[schema.$ref.split('/').at(-1)], components, seen);
  }
  const nested = ['allOf', 'oneOf', 'anyOf'].flatMap(key => schema[key] || []);
  return Object.assign({}, ...nested.map(item => properties(item, components, seen)),
    schema.properties || {});
}
async function cleanup() {
  if (!own.sessionId) return true;
  const t = await table();
  if (t.current_session?.id !== own.sessionId)
    throw Error('CLEANUP REQUIRED: QA3 session ownership changed');
  const ids = [...new Set((t.orders || []).filter(row =>
    row.table_session_id === own.sessionId).map(row => row.id))];
  if (ids.length > 1 || ids.some(id => own.orderId && id !== own.orderId))
    throw Error('CLEANUP REQUIRED: unexpected owned order');
  own.orderId ||= ids[0] || (await must('POST', '/api/v1/orders', 'waiter', 201,
    { table_session_id: own.sessionId })).id;
  let current = await order();
  if (current.table_session_id !== own.sessionId)
    throw Error('CLEANUP REQUIRED: order/session mismatch');
  if (!current.items.length) {
    await must('POST', '/api/v1/orders/' + own.orderId + '/items', 'waiter', 201,
      { items: [{ menu_item_id: own.menuId, quantity: 1,
        note: 'P2-ORD-003 owned cleanup' }] });
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
        await must('POST', '/api/v1/orders/' + own.orderId + '/items/' + item.id +
          '/' + action, role, 200);
    }
  }
  if ((await order()).items.some(row => !['SERVED', 'VOIDED'].includes(row.status)))
    throw Error('CLEANUP REQUIRED: active order item');
  if (!['BILLING', 'PAID', 'CLOSED'].includes((await order()).status))
    await must('POST', '/api/v1/orders/' + own.orderId + '/request-billing',
      'waiter', 200);
  if ((await order()).status === 'BILLING')
    await must('POST', '/api/v1/orders/' + own.orderId + '/pay', 'cashier', 200);
  if ((await order()).status === 'PAID')
    await must('POST', '/api/v1/orders/' + own.orderId + '/close', 'cashier', 200);
  if ((await table()).status === 'CLEANING')
    await must('POST', '/api/v1/tables/' + own.tableId + '/mark-clean', 'waiter', 200);
  const finalTable = await table();
  const active = await queue();
  report.cleanup_state = { order_closed: (await order()).status === 'CLOSED',
    table_available: finalTable.status === 'AVAILABLE' && !finalTable.current_session,
    no_active_ticket: !active.some(row => row.order_id === own.orderId) };
  return Object.values(report.cleanup_state).every(Boolean);
}

let before, failure, cleanupError;
try {
  before = await version();
  if (before !== expected) throw Error('PENDING_BUILD: pinned SHA mismatch');
  report.staging_commit = before;
  const spec = await must('GET', '/openapi.json', null, 200);
  const route = '/api/v1/orders/{order_id}/items/{item_id}/void';
  const operation = spec.paths?.[route]?.post;
  if (!operation) throw Error('PENDING_CONTRACT: void operation missing');
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  const props = properties(schema, spec.components?.schemas || {});
  const pinField = Object.keys(props).find(key => /pin/i.test(key));
  report.void_body_fields = Object.keys(props);
  report.pin_field_present = !!pinField;
  if (!pinField) throw Error('PENDING_CONTRACT: void request has no PIN field');
  for (const [role, username, actualRole] of [
    ['admin', 'qa3_admin', 'SUPERVISOR'], ['waiter', 'qa3_waiter', 'WAITER'],
    ['kitchen', 'qa3_kitchen', 'KITCHEN'], ['cashier', 'qa3_cashier', 'CASHIER']]) {
    const login = await must('POST', '/api/v1/auth/login', null, 200,
      { username, password: pin });
    if (login.staff?.role !== actualRole || !login.access_token)
      throw Error('PENDING_FIXTURE: QA3 ' + role + ' role mismatch');
    roles[role] = login.access_token;
  }
  const admin = await must('GET', '/api/v1/auth/me', 'admin', 200);
  const tables = await must('GET', '/api/v1/tables', 'waiter', 200);
  const source = tables.find(row => row.code === 'Q3-1' && row.status === 'AVAILABLE');
  const menu = await must('GET', '/api/v1/menu?available_only=true', 'waiter', 200);
  const item = menu.find(row => row.is_available && row.station_id &&
    !row.has_modifiers && Number(row.price) > 0);
  if (!source || !item) throw Error('PENDING_FIXTURE: Q3-1/mapped menu unavailable');
  own.tableId = source.id; own.menuId = item.id;
  own.sessionId = (await must('POST', '/api/v1/tables/' + own.tableId +
    '/open-session', 'waiter', 201, { guest_count: 1 })).id;
  own.orderId = (await must('POST', '/api/v1/orders', 'waiter', 201,
    { table_session_id: own.sessionId })).id;
  const firstNote = 'QA P2ORD003 void ' + randomUUID().slice(0, 8);
  const secondNote = 'QA P2ORD003 keep ' + randomUUID().slice(0, 8);
  await must('POST', '/api/v1/orders/' + own.orderId + '/items', 'waiter', 201,
    { items: [{ menu_item_id: own.menuId, quantity: 1, note: firstNote },
      { menu_item_id: own.menuId, quantity: 1, note: secondNote }] });
  const lines = (await order()).items;
  own.itemId = lines.find(row => row.note === firstNote)?.id;
  if (lines.length !== 2 || !own.itemId ||
      !lines.find(row => row.note === secondNote)?.id)
    throw Error('CLEANUP REQUIRED: two distinct owned lines missing');
  await must('POST', '/api/v1/orders/' + own.orderId + '/send-to-kitchen',
    'waiter', 200);
  await must('POST', '/api/v1/orders/' + own.orderId + '/items/' + own.itemId +
    '/start-cooking', 'kitchen', 200);
  const beforeOrder = await order();
  const beforeQueue = (await queue()).filter(row => row.order_id === own.orderId);
  const path = '/api/v1/orders/' + own.orderId + '/items/' + own.itemId + '/void';
  const reason = 'QA P2ORD003 PIN policy isolated';
  const noPin = await call('POST', path, 'admin', { reason });
  const afterMissing = await order();
  const wrong = await call('POST', path, 'admin',
    { reason, [pinField]: 'invalid-' + randomUUID() });
  const afterWrong = await order();
  const queueAfterWrong = (await queue()).filter(row => row.order_id === own.orderId);
  const valid = await call('POST', path, 'admin',
    { reason, [pinField]: supervisorPin });
  const afterValid = await order();
  const rows = await audit();
  const voidEvents = rows.filter(row => row.action === 'ORDER_ITEM_VOIDED' &&
    (row.entity_id === own.itemId || row.payload?.item_id === own.itemId ||
      row.payload?.order_item_id === own.itemId));
  const sameItems = row => JSON.stringify(row.items.map(item => ({
    id: item.id, status: item.status, note: item.note }))) + ':' + row.current_version;
  const sameQueue = rows => JSON.stringify(rows.map(row => ({
    id: row.id, status: row.status, order_item_id: row.order_item_id })).sort(
      (a, b) => a.id.localeCompare(b.id)));
  report.http = { missing_pin: noPin.http, wrong_pin: wrong.http,
    correct_pin: valid.http };
  report.order_id = own.orderId; report.item_id = own.itemId;
  report.checks = {
    missing_pin_denied: [400, 401, 403, 422].includes(noPin.http) &&
      sameItems(afterMissing) === sameItems(beforeOrder),
    wrong_pin_denied: [400, 401, 403, 422].includes(wrong.http) &&
      sameItems(afterWrong) === sameItems(beforeOrder) &&
      sameQueue(queueAfterWrong) === sameQueue(beforeQueue),
    correct_pin_voids_once: valid.http === 200 &&
      afterValid.items.find(row => row.id === own.itemId)?.status === 'VOIDED' &&
      afterValid.items.find(row => row.note === secondNote)?.status === 'SENT',
    audit_actor_time_once: voidEvents.length === 1 &&
      voidEvents[0].staff_id === admin.id && !!voidEvents[0].created_at,
  };
  if (!Object.values(report.checks).every(Boolean))
    throw Error('Supervisor PIN/void or audit mismatch: ' +
      JSON.stringify(report.checks));
  report.business_execution = 'EXECUTED';
} catch (error) { failure = safe(error); }
try { report.cleanup_pass = await cleanup(); } catch (error) { cleanupError = safe(error); }
try { report.build_after = await version(); } catch { report.build_after = null; }
report.build_stable = before === report.build_after;
report.result = !failure && !cleanupError && report.cleanup_pass && report.build_stable ?
  'PASSED' : cleanupError || !report.cleanup_pass ? 'INCONCLUSIVE' :
    failure?.startsWith('Error: PENDING_') ? 'PENDING' : 'FAILED';
if (failure) report.error = failure;
if (cleanupError) report.cleanup_required = cleanupError;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('[P2-ORD-003] Result: ' + JSON.stringify(report));
if (report.result !== 'PASSED') process.exitCode = 1;
