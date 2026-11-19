import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Recover only the timed-out S4-UX-014 run. No table-wide reset or inferred ownership.
const fixture = Object.freeze({
  source_run_id: 'RUN-20261119022136751-S4UX014',
  table_code: 'Q3-1',
  table_id: '57badca1-710d-4fd0-9abe-8dfe8a8e490b',
  session_id: '7311f128-18dd-4d7d-a213-ea75b5ba80f5',
  order_id: '390ab2b1-32f2-41f7-b68b-c20ce44f5fc8',
  notes: ['S4-UX-014 keep', 'S4-UX-014 move'],
});
const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.S2_STAGING_PIN;
const expected = process.env.POS_EXPECTED_COMMIT;
if (base !== 'http://160.191.47.17' || !pin ||
    !/^[a-f0-9]{40}$/.test(expected || ''))
  throw Error('Set QA3 PIN and full pinned staging SHA; no request sent');
const tokens = {};
const report = {
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX014RECOVERY',
  test_ref: 'S4-UX-014-OWNED-CLEANUP',
  source_run_id: fixture.source_run_id,
  checked_at: new Date().toISOString(),
  fixture: { table_code: fixture.table_code, table_id: fixture.table_id,
    session_id: fixture.session_id, order_id: fixture.order_id },
  secrets_recorded: false, actions: [], cleanup_pass: false,
};
let step = 'preflight';
async function call(method, path, role, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(role ? { Authorization: 'Bearer ' + tokens[role] } : {}),
      ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  let data = null;
  try { data = await response.json(); } catch { /* empty response */ }
  return { http: response.status, data };
}
async function checked(method, path, role, expectedHttp, body) {
  step = method + ' ' + path;
  const response = await call(method, path, role, body);
  if (response.http !== expectedHttp)
    throw Error(step + ': HTTP ' + response.http + ', expected ' + expectedHttp);
  if (method !== 'GET') report.actions.push({ step, http: response.http });
  return response.data;
}
const table = () => checked('GET', '/api/v1/tables/' + fixture.table_id,
  'waiter', 200);
const order = () => checked('GET', '/api/v1/orders/' + fixture.order_id,
  'cashier', 200);
const queue = status => checked('GET', '/api/v1/kitchen/queue' +
  (status ? '?status=' + status : ''), 'kitchen', 200);
function verify(condition, message) {
  if (!condition) throw Error('OWNERSHIP CHECK FAILED: ' + message);
}
try {
  const version = await checked('GET', '/version', undefined, 200);
  report.build_before = version.commit;
  verify(version.environment === 'staging' && version.commit === expected,
    'staging build differs; no mutation');
  const outlets = [];
  for (const [role, roleName] of [
    ['waiter', 'WAITER'], ['cashier', 'CASHIER'], ['kitchen', 'KITCHEN'],
  ]) {
    const auth = await checked('POST', '/api/v1/auth/login', undefined, 200,
      { username: 'qa3_' + role, password: pin });
    verify(auth.staff?.role === roleName && auth.staff?.outlet_id &&
      auth.access_token, 'QA3 ' + role + ' identity mismatch');
    tokens[role] = auth.access_token;
    outlets.push(auth.staff.outlet_id);
  }
  verify(outlets.every(id => id === outlets[0]), 'outlet mismatch');
  const t = await table(), o = await order();
  const ownedOrders = (t.orders || []).filter(row =>
    row.table_session_id === fixture.session_id);
  const notes = (o.items || []).map(item => item.note).sort();
  const wanted = [...fixture.notes].sort();
  verify(t.id === fixture.table_id && t.code === fixture.table_code &&
    o.id === fixture.order_id && o.table_session_id === fixture.session_id &&
    o.table_id === fixture.table_id && o.table_code === fixture.table_code &&
    ownedOrders.length === 1 && ownedOrders[0].id === fixture.order_id &&
    o.items?.length === 2 && JSON.stringify(notes) === JSON.stringify(wanted) &&
    o.items.every(item => item.status === 'SERVED'),
    'table/session/order/two original served items mismatch');
  const doneBefore = (await queue('DONE')).filter(row =>
    row.order_id === fixture.order_id);
  const activeBefore = (await queue()).filter(row =>
    row.order_id === fixture.order_id);
  verify(doneBefore.length === 2 && activeBefore.length === 0 &&
    o.items.every(item => doneBefore.some(ticket =>
      ticket.order_item_id === item.id)),
    'ticket ownership/status mismatch');
  verify((t.status === 'OCCUPIED' &&
    t.current_session?.id === fixture.session_id &&
    ['SENT', 'SERVED'].includes(o.status)) ||
    (t.status === 'BILLING' &&
      t.current_session?.id === fixture.session_id && o.status === 'BILLING') ||
    (t.status === 'CLEANING' && !t.current_session &&
      ['PAID', 'CLOSED'].includes(o.status)) ||
    (t.status === 'AVAILABLE' && !t.current_session && o.status === 'CLOSED'),
    'unexpected table/order lifecycle; no mutation');
  report.ownership_verified = true;
  report.initial = { table_status: t.status, order_status: o.status,
    items_served: 2, tickets_done: 2 };
  if (['SENT', 'SERVED'].includes((await order()).status))
    await checked('POST', '/api/v1/orders/' + fixture.order_id +
      '/request-billing', 'waiter', 200);
  if ((await order()).status === 'BILLING')
    await checked('POST', '/api/v1/orders/' + fixture.order_id +
      '/pay', 'cashier', 200);
  if ((await order()).status === 'PAID')
    await checked('POST', '/api/v1/orders/' + fixture.order_id +
      '/close', 'cashier', 200);
  if ((await table()).status === 'CLEANING')
    await checked('POST', '/api/v1/tables/' + fixture.table_id +
      '/mark-clean', 'waiter', 200);
  const finalTable = await table(), finalOrder = await order();
  const finalDone = (await queue('DONE')).filter(row =>
    row.order_id === fixture.order_id);
  const finalActive = (await queue()).filter(row =>
    row.order_id === fixture.order_id);
  report.final = {
    table_status: finalTable.status, no_open_session: !finalTable.current_session,
    order_status: finalOrder.status, items_served: finalOrder.items.every(
      item => item.status === 'SERVED'),
    done_tickets: finalDone.length, active_tickets: finalActive.length,
  };
  report.cleanup_pass = report.final.table_status === 'AVAILABLE' &&
    report.final.no_open_session && report.final.order_status === 'CLOSED' &&
    report.final.items_served && report.final.done_tickets === 2 &&
    report.final.active_tickets === 0;
  verify(report.cleanup_pass, 'final state mismatch');
} catch (error) {
  report.error = step + ': ' + String(error?.message || error)
    .replaceAll(pin, '<REDACTED>');
  process.exitCode = 1;
} finally {
  try {
    const after = await call('GET', '/version');
    report.build_after = after.http === 200 ? after.data?.commit : null;
  } catch { report.build_after = null; }
  report.build_stable = !!report.build_before &&
    report.build_before === report.build_after;
  report.result = report.cleanup_pass && report.build_stable ? 'PASSED' :
    report.actions.length ? 'INCONCLUSIVE' : 'BLOCKED';
  if (report.result !== 'PASSED') {
    report.cleanup_required = 'Inspect only Q3-1 session ' + fixture.session_id +
      ', order ' + fixture.order_id + '; do not reset other fixtures';
    process.exitCode = 1;
  }
  mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
  const name = 'S4_UX_014_RECOVERY_' + report.run_id + '.json';
  writeFileSync(join(process.cwd(), 'evidence', name),
    JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ evidence: '.\\evidence\\' + name, ...report },
    null, 2));
}
