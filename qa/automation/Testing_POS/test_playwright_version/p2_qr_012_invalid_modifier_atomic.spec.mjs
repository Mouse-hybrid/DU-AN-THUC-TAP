import {randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {expect, test} from '@playwright/test';

// Phase 2 P2-QR-012: a valid line followed by a foreign modifier must fail
// atomically. Own QA3 session/order only; never reset staging or edit seed menu.
test.use({trace: 'off'}); // A QR bearer token appears in request URLs.
test.describe.configure({retries: 0}); // An interrupted write test must be inspected before rerun.
test('P2-QR-012 | invalid QR modifier creates no partial order or ticket', async ({request}, testInfo) => {
  test.setTimeout(120_000);
  const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
  expect(base).toBe('http://160.191.47.17');
  const password = process.env.P2_QA_SEED_PASSWORD;
  test.skip(!password, 'PENDING_FIXTURE: QA3 password missing; no request sent');
  const expectedBuild = process.env.POS_EXPECTED_COMMIT;
  test.skip(!expectedBuild, 'PENDING_BUILD: POS_EXPECTED_COMMIT required before mutation');
  const output = process.env.P2_QR_012_EVIDENCE;
  const runId = `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-P2QR012`;
  const tokens = {};
  const owned = {};
  let buildBefore;
  let buildAfter;
  let cleanupPass = false;
  let assertionsPassed = false;
  let expectedHttp;
  let actualHttp;
  let noPartialOrder = false;
  let noPartialTicket = false;
  let failure;

  async function call(method, path, role, data) {
    const response = await request.fetch(`${base}${path}`, {
      method,
      headers: {
        ...(role ? {Authorization: `Bearer ${tokens[role]}`} : {}),
        ...(method !== 'GET' ? {'Idempotency-Key': randomUUID()} : {}),
      },
      ...(data !== undefined ? {data} : {}),
      timeout: 20_000,
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    return {http: response.status(), body};
  }
  async function checked(method, path, http, role, data) {
    const response = await call(method, path, role, data);
    expect(response.http, `${method} ${path.replace(/\/public\/qr\/[^/]+/, '/public/qr/<token>')}`)
      .toBe(http);
    return response.body;
  }
  async function version() {
    return (await checked('GET', '/version', 200)).commit;
  }
  async function ownOrder() {
    return await checked('GET', `/api/v1/orders/${owned.orderId}`, 200, 'waiter');
  }
  async function ownTable() {
    return await checked('GET', `/api/v1/tables/${owned.tableId}`, 200, 'waiter');
  }
  async function ownQueue() {
    const queue = await checked('GET', '/api/v1/kitchen/queue', 200, 'kitchen');
    return queue.filter(ticket => ticket.order_id === owned.orderId);
  }
  async function cleanup() {
    if (!owned.sessionId || !owned.tableId) return false;
    const table = await ownTable();
    let order = owned.orderId ? await ownOrder() : null;
    if (order && order.table_session_id !== owned.sessionId) throw new Error('CLEANUP REQUIRED: order session changed');
    if (table.id !== owned.tableId ||
      (table.current_session?.id && table.current_session.id !== owned.sessionId)) {
      throw new Error('CLEANUP REQUIRED: table/session identity changed');
    }
    if (owned.qrIssued) {
      await checked('DELETE', `/api/v1/tables/${owned.tableId}/qr-session`, 204, 'waiter');
      owned.qrIssued = false;
    }
    if (!order && table.status === 'OCCUPIED') {
      order = await checked('POST', '/api/v1/orders', 201, 'waiter',
        {table_session_id: owned.sessionId});
      owned.orderId = order.id;
    }
    if (!order) throw new Error('CLEANUP REQUIRED: no own order');
    if (order.status === 'NEW') {
      if (!order.items?.length) {
        if (!owned.starterMenuId) throw new Error('CLEANUP REQUIRED: no starter menu item');
        await checked('POST', `/api/v1/orders/${owned.orderId}/items`, 201, 'waiter',
          {items: [{menu_item_id: owned.starterMenuId, quantity: 1, note: 'P2-QR-012 cleanup'}]});
      }
      await checked('POST', `/api/v1/orders/${owned.orderId}/send-to-kitchen`, 200, 'waiter');
      order = await ownOrder();
    }
    if (['SENT', 'SERVED'].includes(order.status)) {
      await checked('POST', `/api/v1/orders/${owned.orderId}/request-billing`, 200, 'waiter');
      order = await ownOrder();
    }
    if (order.status === 'BILLING') {
      await checked('POST', `/api/v1/orders/${owned.orderId}/pay`, 200, 'cashier');
      order = await ownOrder();
    }
    if (order.status === 'PAID') await checked('POST', `/api/v1/orders/${owned.orderId}/close`, 200, 'cashier');
    if ((await ownTable()).status === 'CLEANING') {
      await checked('POST', `/api/v1/tables/${owned.tableId}/mark-clean`, 200, 'waiter');
    }
    const finalOrder = await ownOrder();
    const finalTable = await ownTable();
    expect(finalOrder.status).toBe('CLOSED');
    expect(finalTable.status).toBe('AVAILABLE');
    expect(finalTable.current_session).toBeNull();
    return true;
  }
  try {
    buildBefore = await version();
    if (expectedBuild) expect(buildBefore).toBe(expectedBuild);
    const spec = await checked('GET', '/openapi.json', 200);
    expect(spec.paths['/api/v1/public/qr/{token}/orders']?.post).toBeTruthy();
    for (const [role, name] of [['waiter', 'qa3_waiter'], ['cashier', 'qa3_cashier'],
      ['kitchen', 'qa3_kitchen']]) {
      const login = await checked('POST', '/api/v1/auth/login', 200, undefined,
        {username: name, password});
      expect(login.staff?.role).toBe(role.toUpperCase());
      tokens[role] = login.access_token;
    }
    const tables = await checked('GET', '/api/v1/tables', 200, 'waiter');
    const candidates = tables.filter(t => /^Q3-[12]$/.test(t.code) && t.status === 'AVAILABLE');
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 200, 'waiter');
    const mapped = menu.filter(item => item.is_available && item.station_id);
    const starter = mapped.find(item => !item.has_modifiers);
    const modifierItem = mapped.find(item => item.has_modifiers);
    test.skip(!candidates.length || !starter || !modifierItem,
      'PENDING_FIXTURE: available QA3 table and distinct starter/modifier items required; no mutation');
    owned.starterMenuId = starter.id;
    for (const candidate of candidates) {
      const opened = await call('POST', `/api/v1/tables/${candidate.id}/open-session`, 'waiter', {guest_count: 1});
      if (opened.http === 409) continue;
      expect(opened.http).toBe(201);
      owned.tableId = candidate.id;
      owned.tableCode = candidate.code;
      owned.sessionId = opened.body.id;
      break;
    }
    test.skip(!owned.sessionId, 'PENDING_FIXTURE: QA3 tables occupied during acquisition; no mutation');
    const created = await checked('POST', '/api/v1/orders', 201, 'waiter',
      {table_session_id: owned.sessionId});
    owned.orderId = created.id;
    const added = await checked('POST', `/api/v1/orders/${owned.orderId}/items`, 201, 'waiter',
      {items: [{menu_item_id: starter.id, quantity: 1, note: 'P2-QR-012 starter'}]});
    owned.starterId = added.items.find((item) => item.menu_item_id === starter.id)?.id;
    expect(owned.starterId).toBeTruthy();
    const issued = await checked('POST', `/api/v1/tables/${owned.tableId}/qr-session`, 201, 'waiter');
    owned.qrIssued = true;
    owned.qrToken = issued.token;
    expect(issued.table_session_id).toBe(owned.sessionId);
    const qrMenu = await checked('GET', `/api/v1/public/qr/${owned.qrToken}/menu`, 200);
    expect(qrMenu.items.some((item) => item.id === modifierItem.id && item.modifier_groups?.length))
      .toBe(true);
    const before = await ownOrder();
    const queueBefore = await ownQueue();
    const publicBefore = await checked('GET', `/api/v1/public/qr/${owned.qrToken}/order`, 200);
    const invalid = await call('POST', `/api/v1/public/qr/${owned.qrToken}/orders`, undefined,
      {items: [
        {menu_item_id: starter.id, quantity: 1},
        {menu_item_id: modifierItem.id, quantity: 1, modifier_option_ids: [randomUUID()]},
      ]});
    expectedHttp = 422;
    actualHttp = invalid.http;
    expect(actualHttp, 'foreign modifier must be rejected').toBe(expectedHttp);
    const after = await ownOrder();
    const publicAfter = await checked('GET', `/api/v1/public/qr/${owned.qrToken}/order`, 200);
    const queueAfter = await ownQueue();
    noPartialOrder = after.current_version === before.current_version &&
      JSON.stringify(after.items) === JSON.stringify(before.items) &&
      JSON.stringify(publicAfter) === JSON.stringify(publicBefore);
    noPartialTicket = JSON.stringify(queueAfter) === JSON.stringify(queueBefore);
    expect(noPartialOrder, 'no POS/public line or version added by rejected QR request').toBe(true);
    expect(noPartialTicket, 'no Kitchen ticket added by rejected QR request').toBe(true);
    assertionsPassed = true;
    console.log(`[P2-QR-012] atomic reject PASS: ${owned.tableCode}; order ${owned.orderId}; HTTP 422; no partial line/ticket`);
  } catch (error) {
    failure = String(error).replaceAll(password, '<redacted>')
      .replace(/\/public\/qr\/[^/\s]+/g, '/public/qr/<redacted>');
    throw new Error(failure);
  } finally {
    try { cleanupPass = await cleanup(); }
    catch (error) {
      failure = `${failure || 'Runner error'}; CLEANUP REQUIRED: ${String(error)}`;
      throw new Error(failure.replaceAll(password, '<redacted>').replace(/\/public\/qr\/[^/\s]+/g, '/public/qr/<redacted>'));
    } finally {
      try { buildAfter = await version(); } catch { /* keep original failure */ }
      const result = {
        run_id: runId, test_ref: 'P2-QR-012', checked_at: new Date().toISOString(),
        result: assertionsPassed && cleanupPass && buildBefore === buildAfter ? 'PASSED' : 'NOT_PASSED',
        scope: 'Playwright API: invalid foreign modifier, atomic POS/public order and Kitchen queue; no Customer UI',
        build_before: buildBefore, build_after: buildAfter, build_stable: buildBefore === buildAfter,
        table_code: owned.tableCode, order_id: owned.orderId,
        expected_http: expectedHttp, actual_http: actualHttp,
        no_partial_order: noPartialOrder, no_partial_ticket: noPartialTicket,
        cleanup_pass: cleanupPass, order_closed: cleanupPass, table_available: cleanupPass,
        token_recorded: false, secrets_recorded: false, error: failure,
      };
      if (output) { mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }
      await testInfo.attach('P2-QR-012 evidence', {body: JSON.stringify(result, null, 2), contentType: 'application/json'});
      console.log(`[P2-QR-012] ${result.result}; cleanup ${cleanupPass}; build stable ${result.build_stable}`);
      if (assertionsPassed && !result.build_stable) throw new Error('Build changed during P2-QR-012');
    }
  }
});
