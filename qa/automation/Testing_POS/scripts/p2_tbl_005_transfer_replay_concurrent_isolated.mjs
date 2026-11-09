// P2-TBL-005: QA3 transfer replay and concurrent attempts retain one session/order/ticket.
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_005_transfer_replay_concurrent_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = { source: null, target: null, sessionId: null, orderId: null, menuId: null };
const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL005',
  test_ref: 'P2-TBL-005', checked_at: new Date().toISOString(),
  scope: 'QA3 API transfer same-key replay and simultaneous distinct-key attempts; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE', scenarios: [] };
function redact(value) {
  let safe = String(value).replaceAll(password, '<REDACTED>');
  for (const jwt of Object.values(roles)) safe = safe.replaceAll(jwt, '<REDACTED>');
  return safe;
}
function argsFor(method, path, role, body, key) {
  const args = ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', '-X', method];
  if (role) args.push('-H', `Authorization: Bearer ${roles[role]}`);
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (method !== 'GET' && method !== 'HEAD') args.push('-H', `Idempotency-Key: ${key || randomUUID()}`);
  args.push(`${base}${path}`);
  return args;
}
function decode(raw) {
  const split = raw.lastIndexOf('\n'), http = Number(raw.slice(split + 1)), text = raw.slice(0, split);
  if (split < 0 || !Number.isFinite(http)) throw new Error('Invalid HTTP response');
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { http, data };
}
function call(method, path, role, body, key) {
  const raw = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl',
    argsFor(method, path, role, body, key), {
      encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 3_000_000,
    });
  return decode(raw);
}
function callAsync(method, path, role, body, key) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl',
      argsFor(method, path, role, body, key), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`HTTP client exit ${code}: ${redact(stderr)}`));
      try { resolve(decode(stdout)); } catch (error) { reject(error); }
    });
    if (body !== undefined) child.stdin.end(JSON.stringify(body));
    else child.stdin.end();
  });
}
function must(response, http, label) {
  if (response.http !== http) throw new Error(`${label} HTTP ${response.http}, expected ${http}`);
  return response.data;
}
const get = (path, role) => call('GET', path, role);
const post = (path, role, body, key) => call('POST', path, role, body, key);
const version = () => must(get('/version'), 200, 'version').commit;
const table = id => must(get(`/api/v1/tables/${id}`, 'waiter'), 200, 'own table');
const order = () => must(get(`/api/v1/orders/${owned.orderId}`, 'cashier'), 200, 'own order');
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => x.order_id === owned.orderId);
}
function cleanup() {
  if (!owned.sessionId) return true;
  let source = table(owned.source.id), target = table(owned.target.id);
  const holder = source.current_session?.id === owned.sessionId ? source :
    target.current_session?.id === owned.sessionId ? target : null;
  if (!holder || (source.current_session?.id === owned.sessionId && target.current_session?.id === owned.sessionId))
    throw new Error('CLEANUP REQUIRED: session holder ambiguous');
  if (!owned.orderId) {
    const rows = (holder.orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.orderId = rows[0].id;
    else if (!rows.length) owned.orderId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: owned.sessionId }), 201, 'cleanup create order').id;
  }
  if (!owned.orderId) throw new Error('CLEANUP REQUIRED: own order not uniquely identified');
  let o = order();
  if (o.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session changed');
  if (o.status === 'NEW') {
    if (!o.items?.length) {
      if (!owned.menuId) throw new Error('CLEANUP REQUIRED: mapped menu unavailable');
      must(post(`/api/v1/orders/${owned.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL005 cleanup' }] }), 201, 'cleanup add');
    }
    must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  }
  o = order();
  for (const item of o.items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order().items.find(x => x.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${owned.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order().items.find(x => x.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order().status))
    must(post(`/api/v1/orders/${owned.orderId}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order().status !== 'CLOSED')
    must(post(`/api/v1/orders/${owned.orderId}/close`, 'cashier'), 200, 'cleanup close');
  for (const id of [owned.source.id, owned.target.id]) {
    const t = table(id);
    if (t.status === 'CLEANING') must(post(`/api/v1/tables/${id}/mark-clean`, 'waiter'), 200, 'cleanup table');
  }
  source = table(owned.source.id); target = table(owned.target.id);
  const final = order();
  if (final.status !== 'CLOSED' || final.table_session_id !== owned.sessionId ||
    source.status !== 'AVAILABLE' || target.status !== 'AVAILABLE' ||
    source.current_session || target.current_session ||
    final.items.some(x => x.status !== 'SERVED') ||
    queue('DONE').length !== final.items.length || queue().length)
    throw new Error('CLEANUP REQUIRED: final state mismatch');
  return true;
}
function setup(mode) {
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const source = tables.filter(x => x.code === 'Q3-1' && x.status === 'AVAILABLE');
  const target = tables.filter(x => x.code === 'Q3-2' && x.status === 'AVAILABLE');
  if (source.length !== 1 || target.length !== 1)
    throw new Error('PENDING_FIXTURE: both QA3 tables must be AVAILABLE');
  owned.source = source[0]; owned.target = target[0];
  owned.sessionId = must(post(`/api/v1/tables/${owned.source.id}/open-session`, 'waiter',
    { guest_count: 1 }), 201, 'open QA source').id;
  owned.orderId = must(post('/api/v1/orders', 'cashier',
    { table_session_id: owned.sessionId }), 201, 'create own order').id;
  must(post(`/api/v1/orders/${owned.orderId}/items`, 'cashier',
    { items: [{ menu_item_id: owned.menuId, quantity: 1, note: `QA P2TBL005 ${mode}` }] }), 201, 'add own item');
  must(post(`/api/v1/orders/${owned.orderId}/send-to-kitchen`, 'waiter'), 200, 'send ticket');
  const before = order(), tickets = queue();
  if (before.table_session_id !== owned.sessionId || before.items.length !== 1 || tickets.length !== 1 ||
    table(owned.source.id).current_session?.id !== owned.sessionId ||
    table(owned.target.id).status !== 'AVAILABLE')
    throw new Error('PENDING_FIXTURE: own single-order/ticket source not established');
  return { before, ticket: tickets[0] };
}
function verify(before, ticket) {
  const source = table(owned.source.id), target = table(owned.target.id), after = order(), tickets = queue();
  return {
    one_session_on_target: !source.current_session && target.current_session?.id === owned.sessionId &&
      source.status === 'CLEANING' && target.status === 'OCCUPIED',
    one_unchanged_order: after.id === before.id && after.table_session_id === before.table_session_id &&
      after.items.length === 1 && after.items[0].id === before.items[0].id && after.subtotal === before.subtotal,
    one_unchanged_ticket: tickets.length === 1 && tickets[0].id === ticket.id &&
      tickets[0].order_id === owned.orderId && tickets[0].table_code === owned.target.code,
  };
}

let buildBefore, buildAfter, executed = false, failure, cleanupPass = true;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/transfer']?.post)
    throw new Error('PENDING_CONTRACT: transfer absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'], ['qa3_kitchen', 'KITCHEN']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  owned.menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  if (!owned.menuId) throw new Error('PENDING_FIXTURE: mapped starter item unavailable');
  for (const mode of ['replay', 'concurrent']) {
    let scenarioError, cleaned = false, details;
    try {
      const { before, ticket } = setup(mode);
      const path = `/api/v1/tables/${owned.source.id}/transfer`;
      const body = { target_table_id: owned.target.id };
      executed = true;
      if (mode === 'replay') {
        const key = randomUUID();
        const first = post(path, 'waiter', body, key);
        const repeated = post(path, 'waiter', body, key);
        const checks = verify(before, ticket);
        details = { mode, http: [first.http, repeated.http], checks: {
          same_key_replay: first.http === 200 && repeated.http === 200 &&
            JSON.stringify(first.data) === JSON.stringify(repeated.data), ...checks } };
      } else {
        const responses = await Promise.allSettled([
          callAsync('POST', path, 'waiter', body, randomUUID()),
          callAsync('POST', path, 'waiter', body, randomUUID()),
        ]);
        if (responses.some(x => x.status === 'rejected'))
          throw new Error(`Concurrent HTTP client error: ${responses.filter(x => x.status === 'rejected')
            .map(x => redact(x.reason?.message || x.reason)).join('; ')}`);
        const [first, second] = responses.map(x => x.value);
        const checks = verify(before, ticket);
        details = { mode, http: [first.http, second.http], checks: {
          one_success_one_conflict: [first.http, second.http].sort((a, b) => a - b).join(',') === '200,409',
          ...checks } };
      }
      if (!Object.values(details.checks).every(Boolean))
        throw new Error(`${mode} transfer replay/concurrency invariant failed`);
    } catch (error) { scenarioError = redact(error.message || error); }
    finally {
      try { cleaned = cleanup(); } catch (error) {
        scenarioError = `${scenarioError ? `${scenarioError}; ` : ''}${redact(error.message || error)}`;
      }
      cleanupPass &&= cleaned;
      report.scenarios.push({ ...(details || { mode }), result: scenarioError ? 'INCONCLUSIVE' : 'PASSED',
        cleanup_pass: cleaned, ...(scenarioError ? { error: scenarioError } : {}) });
      if (scenarioError) {
        failure = scenarioError;
        if (!cleaned && owned.sessionId)
          report.cleanup_required = `Inspect ${owned.source?.code}/${owned.target?.code}, session ${owned.sessionId}, order ${owned.orderId}; no global reset`;
      }
      owned.source = null; owned.target = null; owned.sessionId = null; owned.orderId = null;
    }
    if (scenarioError) break;
  }
} catch (error) { failure = redact(error.message || error); }
finally {
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = report.scenarios.length > 0 && cleanupPass && report.scenarios.every(x => x.cleanup_pass);
  report.orders_closed = report.cleanup_pass; report.tables_available = report.cleanup_pass;
  report.result = report.scenarios.length === 2 && report.scenarios.every(x => x.result === 'PASSED') &&
    report.cleanup_pass && report.build_stable ? 'PASSED' :
    !executed && /^PENDING_/.test(failure || '') &&
      report.scenarios.every(x => x.cleanup_pass) ? 'PENDING' :
      !report.cleanup_pass ? 'INCONCLUSIVE' :
      executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
