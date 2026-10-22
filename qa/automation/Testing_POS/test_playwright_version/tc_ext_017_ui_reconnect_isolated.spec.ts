import {randomUUID} from 'node:crypto';
import {test, expect, type WebSocket} from '@playwright/test';

// Product UI acceptance for PR #42. The API component reconnect check is separate.
test('TC_EXT_017 | KDS event delivery and reconnect REST resync', async ({page, request}, testInfo) => {
  test.setTimeout(120_000);
  const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
  expect(base, 'approved staging').toBe('http://160.191.47.17');
  const pin = process.env.TC_EXT_017_STAGING_PIN;
  test.skip(!pin, 'Local staging PIN required');

  type Table = {id: string; code: string; status: string};
  type MenuItem = {id: string; is_available: boolean; station_id: string};
  const fixture: {table?: Table; sessionId?: string; orderId?: string; itemId?: string;
    menu?: MenuItem; note?: string} = {};
  const tokens: Record<string, string> = {};
  const sockets: WebSocket[] = [];
  const events: Array<{type: string; at: number}> = [];
  const queueReads: Array<{at: number; status: number}> = [];

  // Isolate the WebSocket path: the product's 5s/30s fallback polling must not
  // make a missing reconnect refresh appear to pass this test.
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 5_000 || timeout === 30_000) return 0;
      return original(handler, timeout, ...args);
    }) as typeof window.setInterval;
  });

  page.on('websocket', ws => {
    const url = new URL(ws.url());
    if (url.pathname !== '/api/v1/ws' || url.searchParams.get('channel') !== 'kitchen') return;
    sockets.push(ws);
    ws.on('framereceived', frame => {
      try {
        const event = JSON.parse(frame.payload.toString());
        if (event.type !== 'pong') events.push({type: event.type, at: Date.now()});
      } catch { /* Non-JSON heartbeat */ }
    });
  });
  page.on('response', response => {
    if (response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/kitchen/queue') {
      queueReads.push({at: Date.now(), status: response.status()});
    }
  });

  async function call(method: 'GET' | 'POST', path: string, role: string, data?: object) {
    const response = await request.fetch(base + path, {
      method, headers: {Authorization: `Bearer ${tokens[role]}`,
        ...(method === 'POST' ? {'Idempotency-Key': randomUUID()} : {})},
      ...(data ? {data} : {}), timeout: 20_000,
    });
    let body: any;
    try { body = await response.json(); } catch { body = null; }
    return {status: response.status(), body};
  }
  async function checked(method: 'GET' | 'POST', path: string, role: string,
    expected: number, data?: object) {
    const result = await call(method, path, role, data);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(expected);
    return result.body;
  }
  async function cleanup() {
    if (!fixture.sessionId) return;
    if (!fixture.table) throw new Error(`CLEANUP REQUIRED: session ${fixture.sessionId}; no table`);
    const currentTable = await checked('GET', `/api/v1/tables/${fixture.table.id}`, 'waiter', 200);
    if (currentTable.status === 'AVAILABLE' && !currentTable.current_session) return;
    if (currentTable.current_session?.id !== fixture.sessionId) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.table.code} session changed; owned ${fixture.sessionId}`);
    }
    if (!fixture.orderId) {
      fixture.orderId = (await checked('POST', '/api/v1/orders', 'waiter', 201,
        {table_session_id: fixture.sessionId})).id;
    }
    const order = fixture.orderId;
    const current = await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
    if (current.status === 'NEW') {
      if (!current.items?.length) {
        if (!fixture.menu) throw new Error('CLEANUP REQUIRED: no mapped menu item');
        await checked('POST', `/api/v1/orders/${order}/items`, 'waiter', 201,
          {items: [{menu_item_id: fixture.menu.id, quantity: 1, note: 'TC_EXT_017 cleanup'}]});
      }
      await checked('POST', `/api/v1/orders/${order}/send-to-kitchen`, 'waiter', 200);
    }
    await checked('POST', `/api/v1/orders/${order}/request-billing`, 'waiter', 200);
    await checked('POST', `/api/v1/orders/${order}/pay`, 'cashier', 200);
    await checked('POST', `/api/v1/orders/${order}/close`, 'cashier', 200);
    const cleaned = await checked('POST', `/api/v1/tables/${fixture.table.id}/mark-clean`,
      'waiter', 200);
    expect(cleaned.status, 'own table available').toBe('AVAILABLE');
    console.log(`[TC_EXT_017] Cleanup: ${fixture.table.code} AVAILABLE; order ${order} CLOSED`);
  }

  try {
    for (const role of ['waiter', 'kitchen', 'cashier']) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: {username: role, password: pin}, timeout: 20_000});
      expect(response.status(), `${role} login`).toBe(200);
      tokens[role] = (await response.json()).access_token;
      expect(tokens[role], `${role} JWT`).toBeTruthy();
    }

    await page.goto('/login', {waitUntil: 'domcontentloaded'});
    await page.getByLabel('Mã nhân viên', {exact: true}).fill('kitchen');
    await page.getByLabel('Mã PIN', {exact: true}).fill(pin!);
    await page.getByRole('button', {name: 'Đăng nhập', exact: true}).click();
    await expect(page).toHaveURL(/\/kitchen$/, {timeout: 15_000});
    try {
      await expect.poll(() => sockets.length, {timeout: 5_000}).toBeGreaterThan(0);
    } catch {
      if (process.env.TC_EXT_017_EXPECT_UI_WS === 'true') {
        throw new Error('Expected PR #42 Kitchen WebSocket is absent on this staging build');
      }
      console.log('[TC_EXT_017] PENDING: product Kitchen WebSocket absent; no fixture created');
      test.skip(true, 'PR #42 not deployed to staging');
    }
    expect(sockets[0].isClosed(), 'Kitchen WebSocket remains connected').toBe(false);

    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as Table[];
    const available = tables.filter(t => /^B[1-4]$/.test(t.code) && t.status === 'AVAILABLE');
    console.log(`[TC_EXT_017] Fixture gate: ${tables.filter(t => /^B[1-4]$/.test(t.code))
      .map(t => `${t.code}:${t.status}`).join(', ')}; available ${available.length}`);
    test.skip(!available.length, 'No AVAILABLE B1-B4; no mutation');
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 'waiter', 200) as MenuItem[];
    fixture.menu = menu.find(item => item.is_available && Boolean(item.station_id));
    test.skip(!fixture.menu, 'No available mapped menu item; no mutation');
    await page.getByLabel('Trạm bếp').selectOption(fixture.menu!.station_id);
    fixture.note = `TC_EXT_017_UI_${randomUUID()}`;

    for (const table of available) {
      const opened = await call('POST', `/api/v1/tables/${table.id}/open-session`, 'waiter',
        {guest_count: 1});
      if (opened.status === 409) continue;
      expect(opened.status, `open ${table.code}`).toBe(201);
      fixture.table = table;
      fixture.sessionId = opened.body.id;
      break;
    }
    test.skip(!fixture.sessionId, 'All QA tables taken during reservation; no mutation');
    const created = await checked('POST', '/api/v1/orders', 'waiter', 201,
      {table_session_id: fixture.sessionId});
    fixture.orderId = created.id;
    const added = await checked('POST', `/api/v1/orders/${fixture.orderId}/items`, 'waiter', 201,
      {items: [{menu_item_id: fixture.menu!.id, quantity: 1, note: fixture.note}]});
    fixture.itemId = added.items?.[0]?.id;
    expect(fixture.itemId, 'owned item').toBeTruthy();

    const sentAt = Date.now();
    await checked('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, 'waiter', 200);
    await expect.poll(() => events.filter(e => e.type === 'KITCHEN_QUEUE_UPDATED' &&
      e.at >= sentAt).length, {timeout: 2_000}).toBeGreaterThan(0);
    const card = page.locator('article.nova-kds-ticket').filter({hasText: fixture.note!});
    await expect(card, 'own QUEUED item arrives in KDS within 2s').toHaveCount(1,
      {timeout: 2_000});
    expect(Date.now() - sentAt, 'end-to-end kitchen event delivery within 2s').toBeLessThan(2_000);
    console.log(`[TC_EXT_017] Event and own KDS card: ${Date.now() - sentAt}ms; ` +
      `order ${fixture.orderId}; item ${fixture.itemId}`);

    await page.getByRole('tab', {name: 'Đang chế biến'}).click();
    await expect(card).toHaveCount(0);
    await page.context().setOffline(true);
    await expect.poll(() => sockets[0].isClosed(), {timeout: 5_000}).toBe(true);
    await checked('POST', `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}/start-cooking`,
      'kitchen', 200);
    const onlineAt = Date.now();
    await page.context().setOffline(false);
    await expect.poll(() => sockets.length, {timeout: 20_000}).toBeGreaterThan(1);
    await expect.poll(() => queueReads.filter(r => r.at >= onlineAt && r.status === 200).length,
      {timeout: 20_000}).toBeGreaterThan(0);
    await expect(card, 'missed Start Cooking recovered in KDS after reconnect').toHaveCount(1,
      {timeout: 20_000});
    const queue = await checked('GET', '/api/v1/kitchen/queue?status=IN_PROGRESS', 'kitchen', 200);
    expect(queue.filter((entry: {order_id: string; order_item_id: string}) =>
      entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId)).toHaveLength(1);
    console.log(`[TC_EXT_017] PASS: reconnect + REST resync shows same own PREPARING item; ` +
      `WS connections ${sockets.length}`);
  } finally {
    await page.context().setOffline(false);
    try { await cleanup(); }
    catch (error) {
      console.error(`[TC_EXT_017] CLEANUP REQUIRED: ${fixture.table?.code} session ${fixture.sessionId}; ` +
        `order ${fixture.orderId}; ${String(error)}`);
      throw error;
    } finally {
      await testInfo.attach('TC_EXT_017_UI_reconnect_diagnostics', {
        body: JSON.stringify({fixture, events, queueReads, socketCount: sockets.length}, null, 2),
        contentType: 'application/json',
      });
    }
  }
});
