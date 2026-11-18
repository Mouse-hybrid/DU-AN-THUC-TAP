import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Recovery is pinned to the interrupted run. Never infer ownership from Q3-1 alone.
const fixture = Object.freeze({
  table_code: 'Q3-1',
  table_id: '57badca1-710d-4fd0-9abe-8dfe8a8e490b',
  session_id: 'aeccbe65-62e2-4927-903f-38c719e02fab',
  opened_at: '2026-11-18T03:00:46.449030Z',
  order_id: '31341127-68ef-4b74-a5cc-0c3eac0e0caf',
  created_at: '2026-11-18T03:00:46.556205Z',
});
const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.S2_STAGING_PIN;
const expected = process.env.POS_EXPECTED_COMMIT;
if (base !== 'http://160.191.47.17' || !pin || !/^[a-f0-9]{40}$/.test(expected || ''))
  throw new Error('Set QA3 PIN and full pinned staging SHA; staging base only');

const report = {
  run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX022RECOVERY`,
  test_ref: 'S4-UX-022-OWNED-CLEANUP',
  source_run_id: 'RUN-20261118030041957-S4UX022',
  fixture, secrets_recorded: false, cleanup_pass: false, actions: [],
};
const token = {};
let step = 'build preflight';
async function call(method, path, role, data) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(role ? { Authorization: `Bearer ${token[role]}` } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(20_000),
  });
  let body = null;
  if (response.status !== 204) {
    try { body = await response.json(); } catch { /* Empty error body. */ }
  }
  return { http: response.status, body };
}
async function must(method, path, role, expectedHttp, data) {
  step = `${method} ${path}`;
  const result = await call(method, path, role, data);
  if (result.http !== expectedHttp)
    throw new Error(`${step}: HTTP ${result.http}, expected ${expectedHttp}`);
  if (method !== 'GET') report.actions.push({ step, http: result.http });
  return result.body;
}
function check(condition, message) {
  if (!condition) throw new Error(`OWNERSHIP GATE: ${message}`);
}
const table = () => must('GET', `/api/v1/tables/${fixture.table_id}`, 'waiter', 200);
const order = () => must('GET', `/api/v1/orders/${fixture.order_id}`, 'cashier', 200);
async function ownership() {
  const t = await table();
  const o = await order();
  check(t.code === fixture.table_code && t.status === 'OCCUPIED',
    'table code/status changed');
  check(t.current_session?.id === fixture.session_id &&
    t.current_session?.opened_at === fixture.opened_at,
    'session ID/time changed');
  const sessionOrders = (t.orders || []).filter(row =>
    row.table_session_id === fixture.session_id);
  check(sessionOrders.length === 1 && sessionOrders[0].id === fixture.order_id,
    'session order ownership changed');
  check(o.id === fixture.order_id && o.table_session_id === fixture.session_id &&
    o.created_at === fixture.created_at && o.status === 'NEW' &&
    Array.isArray(o.items) && o.items.length === 0,
    'order ID/time/state/items changed');
  return { table_status: t.status, order_status: o.status,
    item_count: o.items.length, session_id: t.current_session.id };
}
try {
  const version = await must('GET', '/version', undefined, 200);
  check(version.environment === 'staging' && version.commit === expected,
    'staging build differs from pinned SHA');
  report.build_before = version.commit;
  const outletId = [];
  for (const [role, username, expectedRole] of [
    ['admin', 'qa3_admin', 'SUPERVISOR'],
    ['waiter', 'qa3_waiter', 'WAITER'],
    ['cashier', 'qa3_cashier', 'CASHIER'],
    ['kitchen', 'qa3_kitchen', 'KITCHEN'],
  ]) {
    step = `${role} login`;
    const response = await fetch(base + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: pin }),
      signal: AbortSignal.timeout(20_000),
    });
    check(response.status === 200, `${role} login HTTP ${response.status}`);
    const body = await response.json();
    check(body.staff?.role === expectedRole && body.access_token,
      `${role} role/token mismatch`);
    outletId.push(body.staff.outlet_id);
    token[role] = body.access_token;
  }
  check(outletId.every(id => id && id === outletId[0]),
    'QA3 roles do not share outlet');
  step = 'strict ownership check';
  report.initial = await ownership();
  const menu = await must('GET', '/api/v1/menu?available_only=true', 'waiter', 200);
  const item = menu.find(row => row.is_available && row.station_id &&
    !row.has_modifiers && Number(row.price) > 0);
  check(item, 'no mapped menu item available');
  // The interrupted run issued exactly one QR; revoke without printing the token.
  await must('DELETE', `/api/v1/tables/${fixture.table_id}/qr-session`,
    'waiter', 204);
  const note = 'S4-UX-022 owned recovery';
  const added = await must('POST', `/api/v1/orders/${fixture.order_id}/items`,
    'waiter', 201, { items: [{ menu_item_id: item.id, quantity: 1, note }] });
  const ownItem = added.items?.find(row =>
    row.menu_item_id === item.id && row.note === note);
  check(ownItem?.id, 'recovery item absent');
  report.recovery_item_id = ownItem.id;
  await must('POST', `/api/v1/orders/${fixture.order_id}/send-to-kitchen`,
    'waiter', 200);
  for (const [action, role] of [
    ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
    ['pickup', 'waiter'], ['served', 'waiter'],
  ]) await must('POST',
    `/api/v1/orders/${fixture.order_id}/items/${ownItem.id}/${action}`,
    role, 200);
  await must('POST', `/api/v1/orders/${fixture.order_id}/request-billing`,
    'waiter', 200);
  await must('POST', `/api/v1/orders/${fixture.order_id}/pay`, 'cashier', 200);
  await must('POST', `/api/v1/orders/${fixture.order_id}/close`, 'cashier', 200);
  await must('POST', `/api/v1/tables/${fixture.table_id}/mark-clean`,
    'waiter', 200);
  const finalTable = await table(), finalOrder = await order();
  const done = await must('GET', '/api/v1/kitchen/queue?status=DONE', 'kitchen', 200);
  const active = await must('GET', '/api/v1/kitchen/queue', 'kitchen', 200);
  report.final = {
    table_status: finalTable.status, order_status: finalOrder.status,
    item_status: finalOrder.items.find(row => row.id === ownItem.id)?.status,
    ticket_done: done.some(row => row.order_id === fixture.order_id),
    active_tickets: active.filter(row => row.order_id === fixture.order_id).length,
    no_open_session: !finalTable.current_session,
  };
  check(report.final.table_status === 'AVAILABLE' &&
    report.final.order_status === 'CLOSED' &&
    report.final.item_status === 'SERVED' && report.final.ticket_done &&
    report.final.active_tickets === 0 && report.final.no_open_session,
    'final cleanup verification failed');
  report.cleanup_pass = true;
} catch (error) {
  report.error = `${step}: ${error instanceof Error ? error.message : String(error)}`;
  process.exitCode = 1;
} finally {
  try {
    const after = await call('GET', '/version');
    report.build_after = after.http === 200 ? after.body?.commit : null;
  } catch { report.build_after = null; }
  report.build_stable = report.build_before === report.build_after;
  report.result = report.cleanup_pass && report.build_stable ? 'PASSED' :
    report.actions.length ? 'INCONCLUSIVE' : 'BLOCKED';
  if (report.result !== 'PASSED') process.exitCode = 1;
  mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
  const filename = `S4_UX_022_RECOVERY_${report.run_id}.json`;
  writeFileSync(join(process.cwd(), 'evidence', filename),
    JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ evidence: `.\\evidence\\${filename}`, ...report }, null, 2));
}
