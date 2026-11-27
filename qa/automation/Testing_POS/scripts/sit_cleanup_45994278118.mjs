import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = 'http://160.191.47.17';
const expectedBuild = 'd6ee04a173c74530653c5df394dd439c92369eaf';
const fixture = {
  order: 'a993733a-2f71-48fc-8b4c-2e565c9b9f1f',
  session: '7a7d156e-a243-4196-985b-6d68e30a8de1',
  customer: 'f1ba2720-9b4e-4ecb-8e8f-25eaa8bf1f48',
  reward: '0929f326-b72a-4446-8748-280b9d0a28e1',
  payment: '83331de2-45b9-40ac-94d9-d46201f36b82',
  marker: '8f4f01e9',
};
const tokens = {};
function assert(ok, message) {
  if (!ok) throw Error(message);
}
async function call(method, path, role, data, expected = 200) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tokens[role] ? { Authorization: 'Bearer ' + tokens[role] } : {}),
      ...(method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(20000),
  });
  assert([expected].flat().includes(response.status), method + ' ' + path + ' HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}
for (const role of ['admin', 'cashier', 'waiter', 'kitchen']) {
  const auth = await call('POST', '/api/v1/auth/login', role, {
    username: 'qa3_' + role, password: process.env.S2_STAGING_PIN,
  });
  tokens[role] = auth.access_token;
}
assert((await call('GET', '/version', 'cashier')).commit === expectedBuild, 'Staging build changed');
let order = await call('GET', '/api/v1/orders/' + fixture.order, 'cashier');
assert(order.table_session_id === fixture.session && order.customer_id === fixture.customer &&
  order.items.some(item => item.note === 'SIT kitchen ' + fixture.marker), 'Owned order mismatch');
const customer = await call('GET', '/api/v1/customers/' + fixture.customer, 'admin');
assert(customer.full_name === 'SIT QA ' + fixture.marker, 'Owned customer mismatch');
const rewards = await call('GET', '/api/v1/rewards', 'admin');
assert(rewards.some(r => r.id === fixture.reward && r.name === 'SIT QA 10 percent ' + fixture.marker) ||
  (order.status === 'CLOSED' && customer.is_active === false),
  'Owned reward mismatch');
const tables = await call('GET', '/api/v1/tables', 'waiter');
const target = tables.find(t => t.code === 'Q3-3');
const secondary = tables.find(t => t.code === 'Q3-2');
assert(target && secondary, 'Owned tables missing');
let targetDetail = await call('GET', '/api/v1/tables/' + target.id, 'waiter');
assert(!targetDetail.current_session || targetDetail.current_session.id === fixture.session,
  'Target session owner changed');
assert(secondary.status !== 'MERGED' || secondary.merged_into_table_id === target.id,
  'Secondary merge owner changed');
await call('DELETE', '/api/v1/tables/' + target.id + '/qr-session', 'waiter', undefined, [204, 404]);
const ledger = await call('GET', '/api/v1/orders/' + fixture.order + '/payments', 'cashier');
for (const payment of ledger.payments.filter(p => ['PENDING', 'UNKNOWN'].includes(p.status))) {
  assert(payment.id === fixture.payment, 'Unexpected pending payment');
  await call('POST', '/api/v1/payments/' + payment.id + '/cancel', 'cashier',
    { reason: 'Owned SIT runner recovery' });
}
for (const item of order.items) {
  for (const [state, action, role] of [
    ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
    ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
  ]) {
    order = await call('GET', '/api/v1/orders/' + fixture.order, 'cashier');
    if (order.items.find(row => row.id === item.id)?.status === state)
      await call('POST', '/api/v1/orders/' + fixture.order + '/items/' + item.id + '/' + action, role);
  }
}
order = await call('GET', '/api/v1/orders/' + fixture.order, 'cashier');
if (order.status === 'BILLING' && Number(order.amount_due) > 0) {
  await call('POST', '/api/v1/orders/' + fixture.order + '/payments', 'cashier',
    { method: 'CASH', amount: order.amount_due, cash_received: order.amount_due }, 201);
}
order = await call('GET', '/api/v1/orders/' + fixture.order, 'cashier');
if (order.status === 'PAID') await call('POST', '/api/v1/orders/' + fixture.order + '/close', 'cashier');
for (const table of [target, secondary]) {
  const detail = await call('GET', '/api/v1/tables/' + table.id, 'waiter');
  assert(!detail.current_session || detail.current_session.id === fixture.session, 'Table owner changed');
  if (detail.status === 'CLEANING') await call('POST', '/api/v1/tables/' + table.id + '/mark-clean', 'waiter');
}
await call('PATCH', '/api/v1/rewards/' + fixture.reward, 'admin', { is_active: false });
await call('PATCH', '/api/v1/customers/' + fixture.customer, 'admin', { is_active: false });
order = await call('GET', '/api/v1/orders/' + fixture.order, 'cashier');
assert(order.status === 'CLOSED', 'Owned order must be CLOSED');
const finalTables = await call('GET', '/api/v1/tables', 'waiter');
assert(finalTables.filter(t => ['Q3-1', 'Q3-2', 'Q3-3'].includes(t.code))
  .every(t => t.status === 'AVAILABLE'), 'QA3 tables must be AVAILABLE');
assert((await call('GET', '/version', 'cashier')).commit === expectedBuild, 'Build changed during cleanup');
const report = { test_ref: 'SIT-OWNED-RECOVERY', source_run: 45994278118,
  checked_at: new Date().toISOString(), fixture, order_closed: true, tables_available: true,
  cleanup_pass: true, staging_commit: expectedBuild, secrets_recorded: false };
mkdirSync('evidence/sit-pos-001', { recursive: true });
writeFileSync('evidence/sit-pos-001/RECOVERY_45994278118.json', JSON.stringify(report, null, 2));
console.log('Owned SIT fixture recovery Passed');
