// Recover only the QA3 table-dialog fixture named on the command line.
// Refuses to write unless the exact session/order/item and QA note still match.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const [output, sessionId, orderId, itemId] = process.argv.slice(2);
if (base !== 'http://160.191.47.17' || !password || !/^[a-f0-9]{40}$/.test(expected || '') ||
    !output || ![sessionId, orderId, itemId].every(x => /^[a-f0-9-]{36}$/.test(x || ''))) {
  console.error('Set P2_QA_SEED_PASSWORD and full POS_EXPECTED_COMMIT; pass OUTPUT session_id order_id item_id. No request sent.');
  process.exit(2);
}

const tokens = {};
const report = { task: 'PF-S4-TABLE-DIALOGS owned cleanup', checked_at: new Date().toISOString(),
  fixture: { table_code: 'Q3-1', session_id: sessionId, order_id: orderId, item_id: itemId },
  secrets_recorded: false, cleanup_pass: false, result: 'INCONCLUSIVE', actions: [] };
async function req(method, path, role, body) {
  const headers = { Accept: 'application/json' };
  if (role) headers.Authorization = `Bearer ${tokens[role]}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
  const response = await fetch(base + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { http: response.status, data };
}
function must(response, expectedHttp, label) {
  if (response.http !== expectedHttp) throw Error(`${label}: HTTP ${response.http}, expected ${expectedHttp}`);
  return response.data;
}
const get = (path, role) => req('GET', path, role);
const post = (path, role, body) => req('POST', path, role, body);
const version = async () => must(await get('/version'), 200, 'version').commit;
let tableId, targetId;
const table = async () => must(await get(`/api/v1/tables/${tableId}`, 'waiter'), 200, 'own table');
const order = async () => must(await get(`/api/v1/orders/${orderId}`, 'cashier'), 200, 'own order');
async function action(path, role, label) {
  must(await post(path, role), 200, label);
  report.actions.push(label);
  console.log(`OWN CLEANUP: ${label} HTTP 200`);
}

let before, after, failure;
try {
  before = await version();
  report.build_before = before;
  if (before !== expected) throw Error('PENDING_BUILD: staging SHA differs; no mutation');
  const staff = {};
  for (const [role, wanted] of [['admin', 'SUPERVISOR'], ['waiter', 'WAITER'],
    ['cashier', 'CASHIER'], ['kitchen', 'KITCHEN']]) {
    const login = must(await post('/api/v1/auth/login', null,
      { username: `qa3_${role}`, password }), 200, `qa3_${role} login`);
    if (!login.access_token || login.staff?.role !== wanted || !login.staff?.outlet_id)
      throw Error(`PENDING_FIXTURE: QA3 ${role} identity mismatch`);
    tokens[role] = login.access_token;
    staff[role] = login.staff;
  }
  if (!['waiter', 'cashier', 'kitchen'].every(role =>
    staff[role].outlet_id === staff.admin.outlet_id))
    throw Error('PENDING_FIXTURE: role outlet mismatch');
  const rows = must(await get('/api/v1/tables', 'waiter'), 200, 'table list');
  const source = rows.find(x => x.code === 'Q3-1');
  const target = rows.find(x => x.code === 'Q3-2');
  if (!source || !target) throw Error('PENDING_FIXTURE: exact QA3 tables missing');
  tableId = source.id;
  targetId = target.id;
  const sourceNow = await table();
  const targetNow = must(await get(`/api/v1/tables/${targetId}`, 'waiter'), 200, 'target table');
  const ownOrder = await order();
  const ownItem = ownOrder.items?.find(x => x.id === itemId);
  if (ownOrder.id !== orderId || ownOrder.table_session_id !== sessionId ||
      ownOrder.table_id !== tableId || ownOrder.table_code !== 'Q3-1' ||
      ownOrder.items?.length !== 1 || ownItem?.note !== 'PF-S4-TABLE-DIALOGS own' ||
      targetNow.status !== 'AVAILABLE' || targetNow.current_session ||
      (sourceNow.current_session?.id !== sessionId &&
       !(sourceNow.status === 'CLEANING' && !sourceNow.current_session &&
         ['PAID', 'CLOSED'].includes(ownOrder.status))))
    throw Error('OWNERSHIP CHECK FAILED: no mutation; inspect exact QA session/order/item');
  report.ownership_verified = true;
  report.initial = { table_status: sourceNow.status, order_status: ownOrder.status,
    item_status: ownItem.status };
  console.log(`OWNERSHIP VERIFIED: Q3-1 session ${sessionId}; order ${orderId}; item ${itemId}`);

  const transitions = { SENT: ['start-cooking', 'kitchen'], PREPARING: ['mark-ready', 'kitchen'],
    READY: ['pickup', 'waiter'], PICKED_UP: ['served', 'waiter'] };
  for (let i = 0; i < 4; i++) {
    const latest = await order();
    const state = latest.items.find(x => x.id === itemId)?.status;
    if (state === 'SERVED') break;
    const next = transitions[state];
    if (!next) throw Error(`CLEANUP REQUIRED: unexpected own item status ${state}`);
    await action(`/api/v1/orders/${orderId}/items/${itemId}/${next[0]}`, next[1], next[0]);
  }
  if ((await order()).items.find(x => x.id === itemId)?.status !== 'SERVED')
    throw Error('CLEANUP REQUIRED: own item not SERVED');
  let current = await order();
  if (['SENT', 'SERVED'].includes(current.status))
    await action(`/api/v1/orders/${orderId}/request-billing`, 'waiter', 'request-billing');
  current = await order();
  if (current.status === 'BILLING')
    await action(`/api/v1/orders/${orderId}/pay`, 'cashier', 'simulated-pay');
  current = await order();
  if (current.status === 'PAID')
    await action(`/api/v1/orders/${orderId}/close`, 'cashier', 'close');
  if ((await order()).status !== 'CLOSED') throw Error('CLEANUP REQUIRED: own order not CLOSED');
  if ((await table()).status === 'CLEANING')
    await action(`/api/v1/tables/${tableId}/mark-clean`, 'waiter', 'mark-clean');
  const finalTable = await table();
  const finalTarget = must(await get(`/api/v1/tables/${targetId}`, 'waiter'), 200, 'target final');
  const done = must(await get('/api/v1/kitchen/queue?status=DONE', 'kitchen'), 200, 'done queue');
  const active = must(await get('/api/v1/kitchen/queue', 'kitchen'), 200, 'active queue');
  report.final = { order_status: (await order()).status, source_status: finalTable.status,
    target_status: finalTarget.status, done_tickets: done.filter(x => x.order_id === orderId).length,
    active_tickets: active.filter(x => x.order_id === orderId).length };
  report.cleanup_pass = finalTable.status === 'AVAILABLE' && !finalTable.current_session &&
    finalTarget.status === 'AVAILABLE' && !finalTarget.current_session &&
    report.final.order_status === 'CLOSED' && report.final.done_tickets === 1 &&
    report.final.active_tickets === 0;
  if (!report.cleanup_pass) throw Error('CLEANUP REQUIRED: final state mismatch');
} catch (error) { failure = String(error?.message || error).replaceAll(password, '<REDACTED>'); }
finally {
  try { after = await version(); } catch {}
  report.build_after = after || null;
  report.build_stable = !!before && before === after;
  report.result = report.cleanup_pass && report.build_stable ? 'PASSED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!report.cleanup_pass)
    report.cleanup_required = `Inspect only Q3-1 session ${sessionId}, order ${orderId}, item ${itemId}`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : 2;
}
