import {randomUUID} from 'node:crypto';
import {test, expect} from '@playwright/test';

// TSK-QA-010 UI component: one owned ticket, real server time, four SLA bands.
// The test records every band before reporting UI mismatches and always attempts fixture cleanup.
test('TSK-QA-010 | KDS renders four SLA bands for one owned ticket', async ({page, request}, testInfo) => {
  test.setTimeout(20 * 60_000);
  const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
  expect(base, 'approved staging').toBe('http://160.191.47.17');
  const pin = process.env.KDS_STAGING_PIN;
  if (!pin) console.log('[TSK-QA-010] PENDING: KDS_STAGING_PIN missing in Playwright worker');
  test.skip(!pin, 'Local staging PIN required');

  type Fixture = {tableId?: string; tableCode?: string; sessionId?: string;
    orderId?: string; itemId?: string; ticketId?: string; stationId?: string; note?: string};
  const fixture: Fixture = {};
  const tokens: Record<string, string> = {};
  const failures: string[] = [];
  const evidence: Record<string, unknown>[] = [];

  async function call(method: 'GET' | 'POST', path: string, token: string,
    data?: Record<string, unknown>) {
    const response = await request.fetch(base + path, {
      method, headers: {Authorization: `Bearer ${token}`,
        ...(method === 'POST' ? {'Idempotency-Key': randomUUID()} : {})},
      ...(data === undefined ? {} : {data}), timeout: 20_000,
    });
    return {status: response.status(), body: await response.json()};
  }
  async function login(username: string) {
    const response = await request.post(base + '/api/v1/auth/login', {
      data: {username, password: pin}, timeout: 20_000,
    });
    expect(response.status(), `${username} login`).toBe(200);
    const body = await response.json();
    expect(body.access_token, `${username} JWT`).toBeTruthy();
    tokens[username] = body.access_token;
  }
  async function checked(method: 'GET' | 'POST', path: string, role: string,
    expected: number, data?: Record<string, unknown>) {
    const result = await call(method, path, tokens[role], data);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(expected);
    return result.body;
  }
  async function ownTicket() {
    const queue = await checked('GET', '/api/v1/kitchen/queue?status=IN_PROGRESS', 'kitchen', 200);
    const matches = queue.filter((entry: {order_id: string; order_item_id: string}) =>
      entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId);
    expect(matches, 'one own cooking ticket').toHaveLength(1);
    expect(matches[0].id, 'ticket identity').toBe(fixture.ticketId);
    return matches[0] as {id: string; elapsed_minutes: number; sla_status: string; started_at: string};
  }
  async function cleanup() {
    if (!fixture.sessionId) return;
    if (!fixture.orderId || !fixture.tableId) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session ${fixture.sessionId}`);
    }
    const order = fixture.orderId;
    let table = await checked('GET', `/api/v1/tables/${fixture.tableId}`, 'waiter', 200);
    let current = await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
    expect(current.table_session_id, 'owned order session').toBe(fixture.sessionId);
    if (table.status === 'AVAILABLE' && !table.current_session && current.status === 'CLOSED') return;
    if (table.current_session?.id !== fixture.sessionId) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session changed; owned ${fixture.sessionId}`);
    }
    if (current.status !== 'CLOSED') {
      // Complete the owned cooking item before billing, as in the BE demo flow.
      // The SLA assertion intentionally leaves it IN_PROGRESS for 15 minutes.
      for (const item of current.items ?? []) {
        const path = `/api/v1/orders/${order}/items/${item.id}`;
        if (item.status === 'SENT') await checked('POST', `${path}/start-cooking`, 'kitchen', 200);
        if (item.status === 'SENT' || item.status === 'PREPARING') {
          await checked('POST', `${path}/mark-ready`, 'kitchen', 200);
        }
        if (['SENT', 'PREPARING', 'READY'].includes(item.status)) {
          await checked('POST', `${path}/pickup`, 'waiter', 200);
        }
        if (['SENT', 'PREPARING', 'READY', 'PICKED_UP'].includes(item.status)) {
          await checked('POST', `${path}/served`, 'waiter', 200);
        }
      }
      current = await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
      if (current.status === 'SENT' || current.status === 'SERVED') {
        expect(current.items.every((item: {status: string}) => item.status === 'SERVED'),
          'owned items served before billing').toBe(true);
        await checked('POST', `/api/v1/orders/${order}/request-billing`, 'waiter', 200);
        current = await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
      }
      if (current.status === 'BILLING') {
        await checked('POST', `/api/v1/orders/${order}/pay`, 'cashier', 200);
        current = await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
      }
      if (current.status === 'PAID') await checked('POST', `/api/v1/orders/${order}/close`, 'cashier', 200);
    }
    current = await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
    expect(current.status, 'own order closed before cleaning').toBe('CLOSED');
    table = await checked('GET', `/api/v1/tables/${fixture.tableId}`, 'waiter', 200);
    if (table.status === 'CLEANING') {
      await checked('POST', `/api/v1/tables/${fixture.tableId}/mark-clean`, 'waiter', 200);
    }
    table = await checked('GET', `/api/v1/tables/${fixture.tableId}`, 'waiter', 200);
    expect(table.status, 'cleaned table').toBe('AVAILABLE');
    expect(table.current_session, 'no open session after cleanup').toBeNull();
    console.log(`[TSK-QA-010] Cleanup: ${fixture.tableCode} AVAILABLE; order ${order} CLOSED`);
  }

  try {
    await Promise.all(['waiter', 'kitchen', 'cashier'].map(login));
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200);
    const available = tables.filter((table: {code: string; status: string}) =>
      /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
    console.log(`[TSK-QA-010] Fixture gate: B1-B4 statuses ` +
      tables.filter((table: {code: string}) => /^B[1-4]$/.test(table.code))
        .map((table: {code: string; status: string}) => `${table.code}:${table.status}`).join(', ') +
      `; available ${available.length}`);
    if (!available.length) console.log('[TSK-QA-010] PENDING: no AVAILABLE B1-B4 table; no mutation');
    test.skip(!available.length, 'No available isolated B1-B4 table');
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 'waiter', 200);
    const mapped = menu.find((item: {is_available: boolean; station_id: string}) =>
      item.is_available && item.station_id);
    console.log(`[TSK-QA-010] Fixture gate: ${menu.length} available menu items; ` +
      `${menu.filter((item: {is_available: boolean; station_id: string}) =>
        item.is_available && item.station_id).length} mapped to a station`);
    if (!mapped) console.log('[TSK-QA-010] PENDING: no available mapped menu item; no mutation');
    test.skip(!mapped, 'No mapped available menu item');
    fixture.stationId = mapped.station_id;
    fixture.note = `TSK-QA-010-SLA-${randomUUID()}`;

    for (const table of available) {
      const opened = await call('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter,
        {guest_count: 2});
      if (opened.status === 409) {
        console.log(`[TSK-QA-010] Reservation collision: ${table.code} HTTP 409; trying next QA table`);
        continue;
      }
      expect(opened.status, `open ${table.code}`).toBe(201);
      fixture.tableId = table.id;
      fixture.tableCode = table.code;
      fixture.sessionId = opened.body.id;
      break;
    }
    if (!fixture.sessionId) console.log('[TSK-QA-010] PENDING: all available QA tables were taken during reservation; no mutation');
    test.skip(!fixture.sessionId, 'B1-B4 reservation lost; no fixture mutation');

    const order = await checked('POST', '/api/v1/orders', 'waiter', 201,
      {table_session_id: fixture.sessionId});
    fixture.orderId = order.id;
    const added = await checked('POST', `/api/v1/orders/${fixture.orderId}/items`, 'waiter', 201,
      {items: [{menu_item_id: mapped.id, quantity: 1, note: fixture.note}]});
    fixture.itemId = added.items?.[0]?.id;
    expect(fixture.itemId, 'owned order item').toBeTruthy();
    await checked('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, 'waiter', 200);

    await page.goto('/login', {waitUntil: 'domcontentloaded'});
    await page.getByLabel('Mã nhân viên', {exact: true}).fill('kitchen');
    await page.getByLabel('Mã PIN', {exact: true}).fill(pin!);
    await page.getByRole('button', {name: 'Đăng nhập', exact: true}).click();
    await expect(page).toHaveURL(/\/kitchen$/, {timeout: 15_000});
    await page.getByLabel('Trạm bếp').selectOption(fixture.stationId!);
    await checked('POST',
      `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}/start-cooking`, 'kitchen', 200);
    const first = await checked('GET', '/api/v1/kitchen/queue?status=IN_PROGRESS', 'kitchen', 200);
    const own = first.filter((entry: {order_id: string; order_item_id: string}) =>
      entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId);
    expect(own, 'owned ticket after Start Cooking').toHaveLength(1);
    fixture.ticketId = own[0].id;
    console.log(`[TSK-QA-010] Fixture: ${fixture.tableCode}; order ${fixture.orderId}; ` +
      `item ${fixture.itemId}; ticket ${fixture.ticketId}; started_at ${own[0].started_at}`);
    await page.getByRole('tab', {name: 'Đang chế biến'}).click();

    const bands = [
      {name: 'NORMAL', from: 0, until: 8, css: 'normal'},
      {name: 'WARNING', from: 8, until: 12, css: 'warning'},
      {name: 'DELAYED', from: 12, until: 15, css: 'delayed'},
      {name: 'CRITICAL', from: 15, until: Infinity, css: 'critical'},
    ];
    let nextHeartbeat = 0;
    for (const band of bands) {
      let ticket = await ownTicket();
      while (ticket.elapsed_minutes < band.from ||
          (ticket.sla_status !== band.name && ticket.elapsed_minutes < band.from + 0.15)) {
        const now = Date.now();
        if (now >= nextHeartbeat) {
          console.log(`[TSK-QA-010] Waiting ${band.name}: ${ticket.elapsed_minutes.toFixed(1)} minutes; ` +
            `API ${ticket.sla_status}; next check within 30 seconds`);
          nextHeartbeat = now + 60_000;
        }
        await new Promise(resolve => setTimeout(resolve, 30_000));
        ticket = await ownTicket();
      }
      expect(ticket.elapsed_minutes, `${band.name} upper boundary`).toBeLessThan(band.until);
      expect(ticket.sla_status, `${band.name} API band`).toBe(band.name);

      await expect.poll(async () => {
        const card = page.locator('article.nova-kds-ticket').filter({hasText: fixture.note!});
        return card.count();
      }, {timeout: 15_000, message: `own ${band.name} ticket visible`}).toBe(1);
      const card = page.locator('article.nova-kds-ticket').filter({hasText: fixture.note!});
      const badge = card.locator('.nova-status-badge');
      await expect.poll(async () => {
        const css = await badge.getAttribute('class');
        const text = (await badge.innerText()).trim();
        return css?.includes(`nova-status--${band.css}`) || text === band.name;
      }, {timeout: 15_000, message: `KDS refreshed ${band.name} ticket`}).toBe(true);
      const className = await badge.getAttribute('class');
      const label = (await badge.innerText()).trim();
      const color = await badge.evaluate(element => getComputedStyle(element).color);
      const background = await badge.evaluate(element => getComputedStyle(element).backgroundColor);
      const record = {band: band.name, elapsed_minutes: ticket.elapsed_minutes,
        api: ticket.sla_status, className, label, color, background,
        ticketId: ticket.id, orderId: fixture.orderId};
      evidence.push(record);
      await testInfo.attach(`TSK_QA_010_${band.name}`, {
        body: await card.screenshot(), contentType: 'image/png',
      });
      if (!className?.includes(`nova-status--${band.css}`)) {
        failures.push(`${band.name}: expected nova-status--${band.css}; rendered ${className} (${label})`);
      }
      console.log(`[TSK-QA-010] ${band.name}: API ${ticket.sla_status} at ${ticket.elapsed_minutes}m; ` +
        `KDS badge ${label}, ${className}, color ${color}, background ${background}`);
    }
    await testInfo.attach('TSK_QA_010_four_band_diagnostics', {
      body: JSON.stringify({fixture, evidence, failures}, null, 2), contentType: 'application/json',
    });
    expect(failures, 'KDS SLA UI band mismatches').toEqual([]);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      console.error(`[TSK-QA-010] CLEANUP REQUIRED: ${fixture.tableCode} session ${fixture.sessionId}; ` +
        `order ${fixture.orderId}; ${String(error)}`);
      throw error;
    }
  }
});
