// P2-TBL-009: same-key replay and concurrent distinct-key merge on isolated QA3 fixtures.
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/p2_tbl_009_merge_replay_concurrent_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!expected) { console.error('PENDING_BUILD: POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = {
  primary: { code: 'Q3-1', tableId: null, sessionId: null, orderId: null, itemId: null, ticketId: null },
  secondary: { code: 'Q3-2', tableId: null, sessionId: null, orderId: null, itemId: null, ticketId: null },
  menuId: null,
};
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
  const raw = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', argsFor(method, path, role, body, key), {
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
const table = x => must(get(`/api/v1/tables/${x.tableId}`, 'waiter'), 200, `${x.code} table`);
const order = x => must(get(`/api/v1/orders/${x.orderId}`, 'cashier'), 200, `${x.code} order`);
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => [owned.primary.orderId, owned.secondary.orderId].includes(x.order_id));
}
function finishOrder(x) {
  if (!x.sessionId) return;
  if (!x.orderId) {
    const t = table(x);
    if (t.current_session?.id !== x.sessionId) throw new Error(`CLEANUP REQUIRED: ${x.code} session moved`);
    const rows = (t.orders || []).filter(o => o.table_session_id === x.sessionId);
    if (rows.length === 1) x.orderId = rows[0].id;
    else if (!rows.length) x.orderId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: x.sessionId }), 201, `${x.code} cleanup create`).id;
  }
  if (!x.orderId) throw new Error(`CLEANUP REQUIRED: ${x.code} order not uniquely identified`);
  let o = order(x);
  if (o.table_session_id !== x.sessionId) throw new Error(`CLEANUP REQUIRED: ${x.code} order session changed`);
  if (o.status === 'NEW') {
    if (!o.items?.length) {
      if (!owned.menuId) throw new Error('CLEANUP REQUIRED: mapped menu unavailable');
      must(post(`/api/v1/orders/${x.orderId}/items`, 'waiter',
        { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2TBL007 cleanup' }] }), 201, 'cleanup add');
    }
    must(post(`/api/v1/orders/${x.orderId}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  }
  o = order(x);
  for (const item of o.items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order(x).items.find(i => i.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${x.orderId}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order(x).items.find(i => i.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: ${x.code} item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order(x).status))
    must(post(`/api/v1/orders/${x.orderId}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order(x).status))
    must(post(`/api/v1/orders/${x.orderId}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order(x).status !== 'CLOSED')
    must(post(`/api/v1/orders/${x.orderId}/close`, 'cashier'), 200, 'cleanup close');
}
function cleanup() {
  if (!owned.primary.sessionId && !owned.secondary.sessionId) return false;
  const primary = table(owned.primary), secondary = table(owned.secondary);
  const merged = secondary.status === 'MERGED' && secondary.merged_into_table_id === owned.primary.tableId;
  if (merged) {
    if (primary.current_session?.id !== owned.primary.sessionId || secondary.current_session ||
      !owned.primary.orderId || !owned.secondary.orderId)
      throw new Error('CLEANUP REQUIRED: merged session/order ownership ambiguous');
    const sourceOrder = order(owned.secondary);
    if (sourceOrder.status !== 'CLOSED' || sourceOrder.items?.length)
      throw new Error('CLEANUP REQUIRED: secondary order not empty/closed after merge');
    const master = order(owned.primary);
    if (master.table_session_id !== owned.primary.sessionId ||
      !master.items.some(i => i.id === owned.secondary.itemId))
      throw new Error('CLEANUP REQUIRED: secondary item not in master order');
    finishOrder(owned.primary);
  } else {
    for (const x of [owned.primary, owned.secondary]) {
      if (!x.sessionId) continue;
      if (table(x).current_session?.id !== x.sessionId)
        throw new Error(`CLEANUP REQUIRED: ${x.code} session moved unexpectedly`);
      finishOrder(x);
    }
  }
  for (const x of [owned.primary, owned.secondary]) {
    const t = table(x);
    if (t.status === 'CLEANING') must(post(`/api/v1/tables/${x.tableId}/mark-clean`, 'waiter'), 200, `clean ${x.code}`);
  }
  const endPrimary = table(owned.primary), endSecondary = table(owned.secondary);
  const master = owned.primary.orderId ? order(owned.primary) : null;
  const secondaryOrder = owned.secondary.orderId ? order(owned.secondary) : null;
  const expectedDone = (master?.items.length || 0) + (secondaryOrder?.items.length || 0);
  if (endPrimary.status !== 'AVAILABLE' || endSecondary.status !== 'AVAILABLE' ||
    endPrimary.current_session || endSecondary.current_session || endSecondary.merged_into_table_id ||
    (master && master.status !== 'CLOSED') || (secondaryOrder && secondaryOrder.status !== 'CLOSED') ||
    (master?.items || []).some(i => i.status !== 'SERVED') ||
    (secondaryOrder?.items || []).some(i => i.status !== 'SERVED') ||
    queue('DONE').length !== expectedDone || queue().length)
    throw new Error('CLEANUP REQUIRED: final merged fixture mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2TBL009',
  test_ref: 'P2-TBL-009', checked_at: new Date().toISOString(),
  scope: 'QA3 API same-key merge replay and simultaneous distinct-key merge; UI not tested',
  secrets_recorded: false, result: 'INCONCLUSIVE', scenarios: [] };
let buildBefore, buildAfter, executed = false, failure, cleanupPass = true;
function resetOwned() {
  for (const x of [owned.primary, owned.secondary]) {
    x.tableId = null; x.sessionId = null; x.orderId = null; x.itemId = null; x.ticketId = null;
  }
}
function setup(mode) {
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  for (const x of [owned.primary, owned.secondary]) {
    const matches = tables.filter(t => t.code === x.code && t.status === 'AVAILABLE');
    if (matches.length !== 1) throw new Error('PENDING_FIXTURE: Q3-1/Q3-2 both AVAILABLE');
    x.tableId = matches[0].id;
  }
  for (const x of [owned.primary, owned.secondary]) {
    x.sessionId = must(post(`/api/v1/tables/${x.tableId}/open-session`, 'waiter',
      { guest_count: 1 }), 201, `open ${x.code}`).id;
    x.orderId = must(post('/api/v1/orders', 'cashier',
      { table_session_id: x.sessionId }), 201, `create ${x.code} order`).id;
    const added = must(post(`/api/v1/orders/${x.orderId}/items`, 'cashier',
      { items: [{ menu_item_id: owned.menuId, quantity: 1, note: `QA P2TBL009 ${mode} ${x.code}` }] }), 201, `add ${x.code} item`);
    x.itemId = added.items?.find(i => i.menu_item_id === owned.menuId)?.id;
    if (!x.itemId) throw new Error(`CLEANUP REQUIRED: ${x.code} item id unavailable`);
    must(post(`/api/v1/orders/${x.orderId}/send-to-kitchen`, 'waiter'), 200, `send ${x.code} ticket`);
    const tickets = queue().filter(t => t.order_id === x.orderId);
    if (tickets.length !== 1) throw new Error(`PENDING_FIXTURE: ${x.code} ticket unavailable`);
    x.ticketId = tickets[0].id;
  }
  const before = [owned.primary, owned.secondary].map(x => order(x));
  if (queue().length !== 2 || before.some((o, n) => o.table_session_id !==
      [owned.primary, owned.secondary][n].sessionId || o.items?.length !== 1))
    throw new Error('PENDING_FIXTURE: independent orders/tickets unavailable');
  return { expectedSubtotal: before.reduce((n, o) => n + Math.round(Number(o.subtotal) * 100), 0) };
}
function verify(expectedSubtotal) {
  const masterTable = table(owned.primary), mergedTable = table(owned.secondary);
  const master = order(owned.primary), sourceOrder = order(owned.secondary), tickets = queue();
  const audit = must(get(`/api/v1/audit-logs?action=TABLE_MERGED&entity_id=${owned.primary.sessionId}`,
    'admin'), 200, 'merge audit');
  const sourceAudit = must(get(`/api/v1/audit-logs?action=ORDER_MERGED&entity_id=${owned.secondary.orderId}`,
    'admin'), 200, 'source order audit');
  return {
    one_master_session: masterTable.current_session?.id === owned.primary.sessionId &&
      masterTable.current_session?.guest_count === 2 && !mergedTable.current_session &&
      mergedTable.status === 'MERGED' && mergedTable.merged_into_table_id === owned.primary.tableId,
    one_master_order: master.items.length === 2 &&
      [owned.primary.itemId, owned.secondary.itemId].every(id => master.items.some(i => i.id === id)) &&
      Math.round(Number(master.subtotal) * 100) === expectedSubtotal &&
      sourceOrder.status === 'CLOSED' && sourceOrder.items.length === 0,
    two_original_tickets: tickets.length === 2 &&
      [owned.primary.ticketId, owned.secondary.ticketId].every(id => tickets.some(t => t.id === id)) &&
      tickets.every(t => t.order_id === owned.primary.orderId && t.table_code === owned.primary.code),
    audit_once: audit.filter(a => a.action === 'TABLE_MERGED' &&
      a.entity_id === owned.primary.sessionId && a.staff_role === 'WAITER').length === 1 &&
      sourceAudit.filter(a => a.action === 'ORDER_MERGED' &&
        a.entity_id === owned.secondary.orderId && a.payload?.into_order_id === owned.primary.orderId).length === 1,
  };
}
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (!buildBefore.startsWith(expected)) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/tables/{table_id}/merge']?.post)
    throw new Error('PENDING_CONTRACT: table merge absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  owned.menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  if (!owned.menuId) throw new Error('PENDING_FIXTURE: mapped starter item unavailable');
  for (const mode of ['replay', 'concurrent']) {
    let details, scenarioError, cleaned = false;
    try {
      const { expectedSubtotal } = setup(mode);
      const path = `/api/v1/tables/${owned.primary.tableId}/merge`;
      const body = { table_ids: [owned.secondary.tableId] };
      executed = true;
      if (mode === 'replay') {
        const key = randomUUID();
        const first = post(path, 'waiter', body, key);
        const repeated = post(path, 'waiter', body, key);
        const checks = verify(expectedSubtotal);
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
        const checks = verify(expectedSubtotal);
        details = { mode, http: [first.http, second.http], checks: {
          one_success_one_conflict: [first.http, second.http].sort((a, b) => a - b).join(',') === '200,409',
          ...checks } };
      }
      if (!Object.values(details.checks).every(Boolean))
        throw new Error(`${mode} merge replay/concurrency invariant failed`);
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
        if (!cleaned && (owned.primary.sessionId || owned.secondary.sessionId))
          report.cleanup_required = `Inspect QA3 sessions ${owned.primary.sessionId}/${owned.secondary.sessionId}, orders ${owned.primary.orderId}/${owned.secondary.orderId}; no global reset`;
      }
      resetOwned();
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
    !executed && /^PENDING_/.test(failure || '') && report.scenarios.every(x => x.cleanup_pass) ? 'PENDING' :
      !report.cleanup_pass ? 'INCONCLUSIVE' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
