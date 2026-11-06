// P2-RWD-003/010: read-only verification against a PASSED owned P2-RWD-006 run.
// No customer/order mutation. The input JSON supplies the paid order and expected ledger.
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const base = 'http://160.191.47.17';
const input = process.argv[2], output = process.argv[3];
let seed = process.env.P2_QA_SEED_PASSWORD;
if (!input || !output || !seed) {
  console.error('Usage: set P2_QA_SEED_PASSWORD privately; node scripts/p2_rwd_003_010_historical_readonly.mjs P2_RWD_006.json OUTPUT.json');
  process.exit(2);
}
const report = {
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2RWD003010',
  test_refs: ['P2-RWD-003', 'P2-RWD-010'], checked_at: new Date().toISOString(),
  result: 'INCONCLUSIVE', scope: 'Read-only QA3 historical EARN/REDEEM ledger and QA2/WAITER isolation.',
  secrets_recorded: false, phone_recorded: false, mutations: 0,
};
const tokens = {};
let phone, before, after, error;
const req = async (method, path, role, body) => {
  const headers = {Accept: 'application/json'};
  if (role) headers.Authorization = `Bearer ${tokens[role]}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {method, headers,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000)});
  return {http: response.status, data: await response.json().catch(() => null)};
};
const must = (r, code, step) => {
  if (r.http !== code) throw Error(`${step} HTTP ${r.http}, expected ${code}`);
  return r.data;
};
const normalized = rows => rows.map(({id, entry_type, points, balance_after, order_id, rule_version}) =>
  ({id, entry_type, points, balance_after, order_id, rule_version}))
  .sort((a, b) => a.id.localeCompare(b.id));
const read = async (path, role) => must(await req('GET', path, role), 200, 'GET');
const redacted = e => {
  let message = String(e?.message || e);
  for (const secret of [seed, phone, ...Object.values(tokens)])
    if (secret) message = message.replaceAll(secret, '<REDACTED>');
  return message;
};
try {
  const source = JSON.parse(readFileSync(input, 'utf8'));
  if (source.test_ref !== 'P2-RWD-006' || source.result !== 'PASSED' ||
      source.cleanup_pass !== true || source.build_stable !== true || !Array.isArray(source.ledger))
    throw Error('PENDING_SOURCE: input must be a PASSED P2-RWD-006 JSON with cleanup and ledger');
  const paid = source.concurrent?.filter(x => x.http === 200);
  if (paid?.length !== 1 || !/^[a-f0-9-]{36}$/.test(paid[0].order_id || ''))
    throw Error('PENDING_SOURCE: exactly one paid order required');
  before = must(await req('GET', '/version'), 200, 'version')?.commit;
  report.staging_commit = before; report.source_run_id = source.run_id;
  const expected = process.env.POS_EXPECTED_COMMIT;
  if (!/^[a-f0-9]{40}$/.test(before || '') || !/^[a-f0-9]{40}$/.test(expected || '') ||
      before !== expected || source.staging_commit !== before)
    throw Error('PENDING_BUILD: source and live SHA must match full expected staging SHA');
  const spec = await read('/openapi.json');
  if (!spec.paths?.['/api/v1/customers/{customer_id}/points']?.get ||
      !spec.paths?.['/api/v1/audit-logs']?.get)
    throw Error('PENDING_CONTRACT: customer points/audit GET absent');
  for (const [key, username, role] of [['admin3', 'qa3_admin', 'SUPERVISOR'],
    ['cashier3', 'qa3_cashier', 'CASHIER'], ['waiter3', 'qa3_waiter', 'WAITER'],
    ['admin2', 'qa2_admin', 'SUPERVISOR']]) {
    const login = must(await req('POST', '/api/v1/auth/login', null,
      {username, password: seed}), 200, username + ' login');
    tokens[key] = login.access_token;
    const me = await read('/api/v1/auth/me', key);
    if (!tokens[key] || me.username !== username || me.role !== role || !me.outlet_id)
      throw Error('QA role/outlet mismatch');
    report[key + '_outlet_id'] = me.outlet_id;
  }
  if (new Set(['admin3', 'cashier3', 'waiter3'].map(x => report[x + '_outlet_id'])).size !== 1 ||
      report.admin2_outlet_id === report.admin3_outlet_id)
    throw Error('QA2/QA3 outlet isolation fixture mismatch');
  const order = await req('GET', `/api/v1/orders/${paid[0].order_id}`, 'cashier3');
  if (order.http === 404) throw Error('PENDING_FIXTURE: historical paid order no longer exists');
  must(order, 200, 'paid order');
  if (!order.data?.customer_id || order.data?.status !== 'CLOSED')
    throw Error('PENDING_FIXTURE: paid order has no attached customer or is not CLOSED');
  const id = order.data.customer_id;
  const customer = await read(`/api/v1/customers/${id}`, 'cashier3');
  phone = customer.phone;
  const ownAdmin = await read(`/api/v1/customers/${id}`, 'admin3');
  const ledger = await read(`/api/v1/customers/${id}/points?limit=200`, 'cashier3');
  const usage = await read(`/api/v1/customers/${id}/reward-usage?limit=200`, 'cashier3');
  const audit = await read(`/api/v1/audit-logs?order_id=${paid[0].order_id}&limit=500`, 'admin3');
  const waiterCustomer = await req('GET', `/api/v1/customers/${id}`, 'waiter3');
  const waiterPoints = await req('GET', `/api/v1/customers/${id}/points`, 'waiter3');
  const foreignCustomer = await req('GET', `/api/v1/customers/${id}`, 'admin2');
  const foreignPoints = await req('GET', `/api/v1/customers/${id}/points`, 'admin2');
  const foreignLookup = await req('GET', `/api/v1/customers?phone=${encodeURIComponent(phone)}`, 'admin2');
  const forbiddenBodies = [waiterCustomer.data, waiterPoints.data, foreignCustomer.data,
    foreignPoints.data, foreignLookup.data].map(x => JSON.stringify(x ?? ''));
  const noPii = forbiddenBodies.every(x => !x.includes(phone) && !x.includes(customer.full_name || '<<<missing>>>'));
  report.checks = {
    rwd_003_balance_and_history: customer.points_balance === source.balance_after &&
      ownAdmin.id === id && JSON.stringify(normalized(ledger)) === JSON.stringify(normalized(source.ledger)) &&
      ledger.filter(x => x.entry_type === 'REDEEM').length === 1 &&
      ledger.filter(x => x.entry_type === 'EARN').length === 1 &&
      usage.filter(x => x.status === 'COMMITTED' && x.order_id === paid[0].order_id).length === 1 &&
      audit.filter(x => x.action === 'ORDER_PAID').length === 1,
    rwd_010_isolation: waiterCustomer.http === 403 && waiterPoints.http === 403 &&
      foreignCustomer.http === 404 && foreignPoints.http === 404 &&
      foreignLookup.http === 200 && Array.isArray(foreignLookup.data) &&
      foreignLookup.data.length === 0 && noPii,
  };
  report.paid_order_id = paid[0].order_id; report.customer_id = id;
  report.balance = customer.points_balance; report.ledger_count = ledger.length;
  report.http = {waiter_customer: waiterCustomer.http, waiter_points: waiterPoints.http,
    qa2_customer: foreignCustomer.http, qa2_points: foreignPoints.http,
    qa2_phone_lookup: foreignLookup.http};
} catch (e) { error = redacted(e); }
finally {
  try { after = must(await req('GET', '/version'), 200, 'version')?.commit; } catch {}
  report.build_after = after || null; report.build_stable = !!before && before === after;
  report.case_results = Object.fromEntries(['P2-RWD-003', 'P2-RWD-010'].map((id, index) =>
    [id, report.checks && report.build_stable
      ? (Object.values(report.checks)[index] ? 'PASSED' : 'FAILED') : 'PENDING']));
  report.result = Object.values(report.case_results).every(x => x === 'PASSED') ? 'PASSED' :
    Object.values(report.case_results).includes('FAILED') ? 'FAILED' :
    /^PENDING_/.test(error || '') ? 'PENDING' : 'INCONCLUSIVE';
  if (error) report.error = error;
  mkdirSync(dirname(output), {recursive: true});
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  seed = undefined; phone = undefined;
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
