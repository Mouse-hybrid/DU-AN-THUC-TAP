// PF-P2-PAY-008: split one QA3 bill, pay each child separately and reconcile the ledger.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved staging origin only');
if (!output) { console.error('Usage: node scripts/pf_p2_pay_008_split_payments_isolated.mjs OUTPUT.json'); process.exit(2); }
if (!/^[a-f0-9]{40}$/.test(expected??'')) { console.error('PENDING_BUILD: full POS_EXPECTED_COMMIT missing; no request sent'); process.exit(2); }
if (!password) { console.error('PENDING_FIXTURE: P2_QA_SEED_PASSWORD missing; no request sent'); process.exit(2); }

const roles = {};
const owned = { code: 'Q3-1', tableId: null, sessionId: null, originalId: null,
  splitId: null, menuId: null, sourceItemId: null, movingItemId: null,
  sourceTicketId: null, movingTicketId: null };
function redact(value) {
  let safe = String(value).replaceAll(password, '<REDACTED>');
  for (const jwt of Object.values(roles)) safe = safe.replaceAll(jwt, '<REDACTED>');
  return safe;
}
function call(method, path, role, body) {
  const args = ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', '-X', method];
  if (role) args.push('-H', `Authorization: Bearer ${roles[role]}`);
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  if (method !== 'GET' && method !== 'HEAD') args.push('-H', `Idempotency-Key: ${randomUUID()}`);
  args.push(`${base}${path}`);
  const raw = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 3_000_000,
  });
  const split = raw.lastIndexOf('\n'), http = Number(raw.slice(split + 1)), value = raw.slice(0, split);
  let data;
  try { data = value ? JSON.parse(value) : null; } catch { data = value; }
  return { http, data };
}
function must(response, http, label) {
  if (response.http !== http) throw new Error(`${label} HTTP ${response.http}, expected ${http}`);
  return response.data;
}
const get = (path, role) => call('GET', path, role);
const post = (path, role, body) => call('POST', path, role, body);
const version = () => must(get('/version'), 200, 'version').commit;
const table = () => must(get(`/api/v1/tables/${owned.tableId}`, 'waiter'), 200, 'table');
const order = id => must(get(`/api/v1/orders/${id}`, 'cashier'), 200, 'order');
function queue(status) {
  const rows = must(get(`/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`, 'kitchen'), 200, 'queue');
  if (!Array.isArray(rows)) throw new Error('Kitchen queue is not an array');
  return rows.filter(x => [owned.originalId, owned.splitId].includes(x.order_id));
}
function discoverOrders() {
  const rows = (table().orders || []).filter(x => x.table_session_id === owned.sessionId);
  const ids = [...new Set(rows.map(x => x.id))];
  if (ids.length > 2 || ids.some(id => id !== owned.originalId && owned.splitId && id !== owned.splitId))
    throw new Error('CLEANUP REQUIRED: unexpected order in QA session');
  const extra = ids.find(id => id !== owned.originalId);
  if (extra && !owned.splitId) owned.splitId = extra;
}
function finishOrder(id) {
  let current = order(id);
  if (current.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session mismatch');
  if (current.status === 'CLOSED') return;
  if (!current.items.length) {
    must(post(`/api/v1/orders/${id}/items`, 'waiter',
      { items: [{ menu_item_id: owned.menuId, quantity: 1, note: 'QA P2PAY008 cleanup' }] }), 201, 'cleanup add');
    current = order(id);
  }
  if (current.items.some(x => x.status === 'CREATED'))
    must(post(`/api/v1/orders/${id}/send-to-kitchen`, 'waiter'), 200, 'cleanup send');
  for (const item of order(id).items) {
    for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
      ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter']]) {
      if (order(id).items.find(i => i.id === item.id)?.status === state)
        must(post(`/api/v1/orders/${id}/items/${item.id}/${action}`, role), 200, `cleanup ${action}`);
    }
    if (order(id).items.find(i => i.id === item.id)?.status !== 'SERVED')
      throw new Error(`CLEANUP REQUIRED: item ${item.id} not SERVED`);
  }
  if (!['BILLING', 'PAID', 'CLOSED'].includes(order(id).status))
    must(post(`/api/v1/orders/${id}/request-billing`, 'waiter'), 200, 'cleanup billing');
  if (!['PAID', 'CLOSED'].includes(order(id).status))
    must(post(`/api/v1/orders/${id}/pay`, 'cashier'), 200, 'cleanup simulated pay');
  if (order(id).status !== 'CLOSED')
    must(post(`/api/v1/orders/${id}/close`, 'cashier'), 200, 'cleanup close');
}
function cleanup() {
  if (!owned.sessionId) return false;
  discoverOrders();
  if (!owned.originalId) {
    const rows = (table().orders || []).filter(x => x.table_session_id === owned.sessionId);
    if (rows.length === 1) owned.originalId = rows[0].id;
    else if (!rows.length) owned.originalId = must(post('/api/v1/orders', 'waiter',
      { table_session_id: owned.sessionId }), 201, 'cleanup create').id;
    else throw new Error('CLEANUP REQUIRED: order ownership ambiguous');
  }
  discoverOrders();
  for (const id of [owned.originalId, owned.splitId].filter(Boolean)) finishOrder(id);
  if (table().status === 'CLEANING')
    must(post(`/api/v1/tables/${owned.tableId}/mark-clean`, 'waiter'), 200, 'mark clean');
  const finalTable = table(), orders = [owned.originalId, owned.splitId].filter(Boolean).map(order);
  const expectedTickets = orders.flatMap(x => x.items).length;
  if (finalTable.status !== 'AVAILABLE' || finalTable.current_session ||
    orders.some(x => x.status !== 'CLOSED' || x.items.some(i => i.status !== 'SERVED')) ||
    queue('DONE').length !== expectedTickets || queue().length)
    throw new Error('CLEANUP REQUIRED: final split fixture mismatch');
  return true;
}

const report = { run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2PAY008',
  test_ref: 'PF-P2-PAY-008', checked_at: new Date().toISOString(),
  scope: 'QA3 API split two item bills, pay child then source in CASH, verify ledger and table lifecycle; UI not tested',
  case_coverage: 'TWO_CASH_BILLS_NO_DISCOUNT_FEE',
  business_case: 'P2-PAY-008 NOT_EXECUTED: tax/discount/fee allocation and sandbox policy not covered.',
  secrets_recorded: false, result: 'INCONCLUSIVE' };
let buildBefore, buildAfter, executed = false, asserted = false, cleanupPass = false, failure;
try {
  buildBefore = version(); report.staging_commit = buildBefore;
  if (buildBefore !== expected) throw new Error('PENDING_BUILD: staging SHA changed');
  const spec = must(get('/openapi.json'), 200, 'OpenAPI');
  if (!spec.paths?.['/api/v1/orders/{order_id}/split']?.post ||
      !spec.paths?.['/api/v1/orders/{order_id}/payments']?.post ||
      !spec.paths?.['/api/v1/orders/{order_id}/payments']?.get)
    throw new Error('PENDING_CONTRACT: split or Payment v2 absent');
  for (const [name, role] of [['qa3_waiter', 'WAITER'], ['qa3_cashier', 'CASHIER'],
    ['qa3_kitchen', 'KITCHEN'], ['qa3_admin', 'SUPERVISOR']]) {
    const login = must(post('/api/v1/auth/login', null, { username: name, password }), 200, `${name} login`);
    if (login.staff?.role !== role || !login.access_token) throw new Error('PENDING_FIXTURE: QA3 role mismatch');
    roles[name.slice(4)] = login.access_token;
  }
  const tables = must(get('/api/v1/tables', 'waiter'), 200, 'tables');
  const matches = tables.filter(x => x.code === owned.code && x.status === 'AVAILABLE');
  const menu = must(get('/api/v1/menu?available_only=true', 'cashier'), 200, 'menu');
  owned.menuId = menu.find(x => x.is_available && x.station_id && !x.has_modifiers)?.id;
  if (matches.length !== 1 || !owned.menuId)
    throw new Error('PENDING_FIXTURE: Q3-1 AVAILABLE and mapped menu item required');
  owned.tableId = matches[0].id;
  owned.sessionId = must(post(`/api/v1/tables/${owned.tableId}/open-session`, 'waiter',
    { guest_count: 2 }), 201, 'open QA3 table').id;
  owned.originalId = must(post('/api/v1/orders', 'cashier',
    { table_session_id: owned.sessionId }), 201, 'create order').id;
  const added = must(post(`/api/v1/orders/${owned.originalId}/items`, 'cashier',
    { items: [
      { menu_item_id: owned.menuId, quantity: 1, note: 'QA P2PAY008 keep' },
      { menu_item_id: owned.menuId, quantity: 1, note: 'QA P2PAY008 move' },
    ] }), 201, 'add two independent lines');
  owned.sourceItemId = added.items?.find(x => x.note === 'QA P2PAY008 keep')?.id;
  owned.movingItemId = added.items?.find(x => x.note === 'QA P2PAY008 move')?.id;
  if (!owned.sourceItemId || !owned.movingItemId || owned.sourceItemId === owned.movingItemId)
    throw new Error('PENDING_FIXTURE: two distinct POS lines required');
  must(post(`/api/v1/orders/${owned.originalId}/send-to-kitchen`, 'waiter'), 200, 'send both lines');
  const before = order(owned.originalId), beforeTickets = queue();
  if (before.items.length !== 2 || beforeTickets.length !== 2 ||
    beforeTickets.some(x => x.order_id !== owned.originalId))
    throw new Error('PENDING_FIXTURE: order/tickets not established');
  owned.sourceTicketId = beforeTickets.find(x => x.order_item_id === owned.sourceItemId)?.id;
  owned.movingTicketId = beforeTickets.find(x => x.order_item_id === owned.movingItemId)?.id;
  if (!owned.sourceTicketId || !owned.movingTicketId)
    throw new Error('PENDING_FIXTURE: ticket ownership missing');
  const subtotal = Math.round(Number(before.subtotal) * 100);
  executed = true;
  const split = must(post(`/api/v1/orders/${owned.originalId}/split`, 'waiter',
    { items: [{ order_item_id: owned.movingItemId, quantity: 1 }] }), 201, 'split order');
  owned.splitId = split.new_order?.id;
  if (!owned.splitId) throw new Error('CLEANUP REQUIRED: split order id missing');
  const source = order(owned.originalId), target = order(owned.splitId);
  const afterTickets = queue();
  const audit = must(get(`/api/v1/audit-logs?action=ORDER_SPLIT&entity_id=${owned.originalId}`,
    'admin'), 200, 'split audit');
  const tableOrders = (table().orders || []).filter(x => x.table_session_id === owned.sessionId);
  for (const id of [owned.originalId, owned.splitId]) {
    for (const item of order(id).items) {
      for (const [state, action, role] of [['SENT', 'start-cooking', 'kitchen'],
        ['PREPARING', 'mark-ready', 'kitchen'], ['READY', 'pickup', 'waiter'],
        ['PICKED_UP', 'served', 'waiter']]) {
        if (order(id).items.find(i => i.id === item.id)?.status === state)
          must(post(`/api/v1/orders/${id}/items/${item.id}/${action}`, role), 200, `serve ${action}`);
      }
    }
    if (order(id).items.some(i => i.status !== 'SERVED'))
      throw new Error('PENDING_FIXTURE: split bill items not served');
  }
  for (const id of [owned.originalId, owned.splitId])
    must(post(`/api/v1/orders/${id}/request-billing`, 'waiter'), 200, 'request billing');
  const cents=value=>Math.round(Number(value)*100);
  const originalDue=cents(order(owned.originalId).amount_due);
  const childDue=cents(order(owned.splitId).amount_due);
  if (originalDue <= 0 || childDue <= 0 || originalDue+childDue !== subtotal)
    throw new Error('PENDING_FIXTURE: split due amounts differ from original subtotal');
  const amount=value=>(value/100).toFixed(2);
  const paidChild=must(post(`/api/v1/orders/${owned.splitId}/payments`, 'cashier',
    {method:'CASH',amount:amount(childDue),cash_received:amount(childDue)}), 201, 'pay child');
  const childAfter=order(owned.splitId), sourceUnpaid=order(owned.originalId);
  const childLedger=must(get(`/api/v1/orders/${owned.splitId}/payments`, 'cashier'), 200, 'child ledger');
  const tableAfterFirst=table();
  const paidSource=must(post(`/api/v1/orders/${owned.originalId}/payments`, 'cashier',
    {method:'CASH',amount:amount(originalDue),cash_received:amount(originalDue)}), 201, 'pay source');
  const sourceAfter=order(owned.originalId), childFinal=order(owned.splitId);
  const sourceLedger=must(get(`/api/v1/orders/${owned.originalId}/payments`, 'cashier'), 200, 'source ledger');
  const tableAfterBoth=table();
  report.http={split:201,child_payment:201,source_payment:201};
  report.payment_ids=[paidChild.payment?.id,paidSource.payment?.id].filter(Boolean);
  report.amounts={original_subtotal:before.subtotal,child:amount(childDue),source:amount(originalDue)};
  report.checks={
    two_bills_same_session:source.table_session_id===owned.sessionId &&
      target.table_session_id===owned.sessionId && tableOrders.length===2,
    original_total_preserved:cents(source.subtotal)+cents(target.subtotal)===subtotal &&
      originalDue+childDue===subtotal,
    items_partitioned:source.items.length===1&&target.items.length===1 &&
      source.items[0].id===owned.sourceItemId&&target.items[0].id===owned.movingItemId,
    tickets_follow_items:afterTickets.length===2 &&
      afterTickets.some(x=>x.id===owned.sourceTicketId&&x.order_id===owned.originalId) &&
      afterTickets.some(x=>x.id===owned.movingTicketId&&x.order_id===owned.splitId),
    split_audit_once:audit.filter(x=>x.action==='ORDER_SPLIT'&&
      x.entity_id===owned.originalId&&x.payload?.new_order_id===owned.splitId).length===1,
    first_payment_only_child:childAfter.status==='PAID'&&sourceUnpaid.status==='BILLING'&&
      cents(sourceUnpaid.amount_due)===originalDue&&
      childLedger.payments?.length===1&&childLedger.payments[0].id===paidChild.payment?.id&&
      cents(childLedger.summary?.remaining)===0,
    table_not_released_while_unpaid:tableAfterFirst.current_session?.id===owned.sessionId&&
      tableAfterFirst.status!=='AVAILABLE'&&tableAfterFirst.status!=='CLEANING',
    both_bills_paid:sourceAfter.status==='PAID'&&childFinal.status==='PAID'&&
      cents(sourceAfter.amount_due)===0&&cents(childFinal.amount_due)===0,
    two_exact_cash_ledger_entries:sourceLedger.payments?.length===1&&
      childLedger.payments?.length===1&&
      sourceLedger.payments[0].id===paidSource.payment?.id&&
      sourceLedger.payments[0].method==='CASH'&&childLedger.payments[0].method==='CASH'&&
      cents(sourceLedger.payments[0].amount)===originalDue&&
      cents(childLedger.payments[0].amount)===childDue&&
      cents(sourceLedger.summary?.remaining)===0,
    table_cleaning_after_both:tableAfterBoth.status==='CLEANING'
  };
  report.table_code = owned.code;
  report.original_order_id = owned.originalId; report.split_order_id = owned.splitId;
  report.original_subtotal = before.subtotal;
  asserted = Object.values(report.checks).every(Boolean);
  if (!asserted) throw new Error('Split payment ledger or table lifecycle mismatch');
} catch (error) { failure = redact(error.message || error); }
finally {
  if (owned.sessionId) try { cleanupPass = cleanup(); }
    catch (error) { failure = `${failure ? `${failure}; ` : ''}${redact(error.message || error)}`; }
  try { buildAfter = version(); } catch {}
  report.build_after = buildAfter || null; report.build_stable = !!buildBefore && buildBefore === buildAfter;
  report.business_execution = executed ? 'EXECUTED' : 'NOT_EXECUTED';
  report.cleanup_pass = cleanupPass; report.orders_closed = cleanupPass; report.table_available = cleanupPass;
  report.result = asserted && cleanupPass && report.build_stable ? 'PASSED' :
    owned.sessionId && !cleanupPass ? 'INCONCLUSIVE' :
    /^PENDING_/.test(failure || '') ? 'PENDING' : executed ? 'FAILED' : 'INCONCLUSIVE';
  if (failure) report.error = failure;
  if (!cleanupPass && owned.sessionId)
    report.cleanup_required = `Inspect QA3 session ${owned.sessionId}, orders ${owned.originalId}/${owned.splitId}; no global reset`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.result === 'PASSED' ? 0 : report.result === 'FAILED' ? 1 : 2;
}
