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
  type MenuItem = {id: string; name: string; is_available: boolean; station_id: string};
  const fixture: {table?: Table; sessionId?: string; orderId?: string; itemId?: string;
    menu?: MenuItem; note?: string} = {};
  const tokens: Record<string, string> = {};
  const sockets: WebSocket[] = [];
  const events: Array<{type: string; at: number}> = [];
  const queueReads: Array<{at: number; status: number}> = [];
  let holdReconnect = false;
  let releaseReconnect: (() => void) | undefined;

  // Isolate the WebSocket path: the product's 5s/30s fallback polling must not
  // make a missing reconnect refresh appear to pass this test.
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 5_000 || timeout === 30_000) return 0;
      return original(handler, timeout, ...args);
    }) as typeof window.setInterval;
    const NativeWebSocket = window.WebSocket;
    const kitchenSockets: InstanceType<typeof NativeWebSocket>[] = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const parsed = new URL(String(url), window.location.href);
        if (parsed.pathname === '/api/v1/ws' && parsed.searchParams.get('channel') === 'kitchen') {
          kitchenSockets.push(this);
        }
      }
    } as typeof WebSocket;
    (window as typeof window & {__qaCloseKitchenSocket: () => boolean}).__qaCloseKitchenSocket = () => {
      const active = [...kitchenSockets].reverse().find(socket => socket.readyState === WebSocket.OPEN);
      if (!active) return false;
      active.close(4001, 'QA reconnect exercise');
      return true;
    };
  });

  // Forward the real kitchen socket. Hold the next handshake after the page
  // closes its own live socket, until the API changes while disconnected.
  await page.routeWebSocket(/\/api\/v1\/ws(?:\?|$)/, async route => {
    const url = new URL(route.url());
    if (url.searchParams.get('channel') !== 'kitchen') {
      route.connectToServer();
      return;
    }
    if (holdReconnect) {
      await new Promise<void>(resolve => { releaseReconnect = resolve; });
    }
    route.connectToServer();
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
    let current = fixture.orderId
      ? await checked('GET', `/api/v1/orders/${fixture.orderId}`, 'waiter', 200) : undefined;
    if (current && current.table_session_id !== fixture.sessionId) {
      throw new Error(`CLEANUP REQUIRED: order ${fixture.orderId} belongs to another session`);
    }
    if (currentTable.status === 'AVAILABLE' && !currentTable.current_session) {
      expect(current?.status, 'owned order closed when table is available').toBe('CLOSED');
      return;
    }
    const ownOpenSession = currentTable.status === 'OCCUPIED' &&
      currentTable.current_session?.id === fixture.sessionId;
    // Payment closes the table session before the separate order-close and
    // mark-clean calls. Only this verified order may be cleaned up afterward.
    const ownPaidSession = currentTable.status === 'CLEANING' &&
      !currentTable.current_session && current && ['PAID', 'CLOSED'].includes(current.status);
    if (!ownOpenSession && !ownPaidSession) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.table.code} state ${currentTable.status}; ` +
        `session ${currentTable.current_session?.id ?? 'none'}; owned ${fixture.sessionId}; ` +
        `order ${current?.status ?? 'none'}`);
    }
    if (!fixture.orderId) {
      fixture.orderId = (await checked('POST', '/api/v1/orders', 'waiter', 201,
        {table_session_id: fixture.sessionId})).id;
    }
    const order = fixture.orderId;
    current ??= await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
    expect(current.table_session_id, 'cleanup order belongs to own session').toBe(fixture.sessionId);
    if (current.status === 'NEW') {
      if (!current.items?.length) {
        if (!fixture.menu) throw new Error('CLEANUP REQUIRED: no mapped menu item');
        await checked('POST', `/api/v1/orders/${order}/items`, 'waiter', 201,
          {items: [{menu_item_id: fixture.menu.id, quantity: 1, note: 'TC_EXT_017 cleanup'}]});
      }
      await checked('POST', `/api/v1/orders/${order}/send-to-kitchen`, 'waiter', 200);
      current = await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200);
    }
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
    if (current.status === 'PAID') {
      await checked('POST', `/api/v1/orders/${order}/close`, 'cashier', 200);
    }
    expect((await checked('GET', `/api/v1/orders/${order}`, 'waiter', 200)).status,
      'owned order closed before cleaning').toBe('CLOSED');
    const cleaned = await checked('POST', `/api/v1/tables/${fixture.table.id}/mark-clean`,
      'waiter', 200);
    expect(cleaned.status, 'own table available').toBe('AVAILABLE');
    const finalTable = await checked('GET', `/api/v1/tables/${fixture.table.id}`, 'waiter', 200);
    expect(finalTable.status).toBe('AVAILABLE');
    expect(finalTable.current_session).toBeNull();
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
    holdReconnect = true;
    const previousSocket = sockets.at(-1)!;
    const previousSocketCount = sockets.length;
    expect(await page.evaluate(() =>
      (window as typeof window & {__qaCloseKitchenSocket: () => boolean}).__qaCloseKitchenSocket()),
    'closed the active Kitchen WebSocket in the page').toBe(true);
    await expect.poll(() => previousSocket.isClosed(), {timeout: 5_000}).toBe(true);
    await checked('POST', `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}/start-cooking`,
      'kitchen', 200);
    const onlineAt = Date.now();
    holdReconnect = false;
    releaseReconnect?.();
    await expect.poll(() => sockets.length, {timeout: 20_000}).toBeGreaterThan(previousSocketCount);
    await expect.poll(() => queueReads.filter(r => r.at >= onlineAt && r.status === 200).length,
      {timeout: 20_000}).toBeGreaterThan(0);
    await expect(card, 'missed Start Cooking recovered in KDS after reconnect').toHaveCount(1,
      {timeout: 20_000});
    const queue = await checked('GET', '/api/v1/kitchen/queue?status=IN_PROGRESS', 'kitchen', 200);
    expect(queue.filter((entry: {order_id: string; order_item_id: string}) =>
      entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId)).toHaveLength(1);
    const itemStatus = async () => {
      const order = await checked('GET', `/api/v1/orders/${fixture.orderId}`, 'waiter', 200);
      return order.items.find((item: {id: string}) => item.id === fixture.itemId)?.status;
    };
    expect(await itemStatus(), 'own item in Đang chế biến').toBe('PREPARING');

    // Kitchen completes its own item; Ready is the handoff point for Waiter.
    await card.getByRole('button',
      {name: `Món xong ${fixture.menu!.name} bàn ${fixture.table!.code}`}).click();
    await expect.poll(itemStatus, {timeout: 20_000}).toBe('READY');
    await expect(card, 'completed item leaves Đang chế biến').toHaveCount(0);
    await page.getByRole('tab', {name: 'Sẵn sàng'}).click();
    await expect(card, 'completed item appears in Sẵn sàng').toHaveCount(1);
    await testInfo.attach('TC_EXT_017_ready_handoff', {
      body: await card.screenshot(), contentType: 'image/png',
    });

    await page.getByRole('button', {name: 'Đăng xuất'}).click();
    await expect(page).toHaveURL(/\/login$/, {timeout: 15_000});
    await page.getByLabel('Mã nhân viên', {exact: true}).fill('waiter');
    await page.getByLabel('Mã PIN', {exact: true}).fill(pin!);
    await page.getByRole('button', {name: 'Đăng nhập', exact: true}).click();
    await expect(page).toHaveURL(/\/tables$/, {timeout: 15_000});
    await page.goto(`/tables/${fixture.table!.id}`, {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: `Lấy món ${fixture.menu!.name}`}).click();
    await expect.poll(itemStatus, {timeout: 20_000}).toBe('PICKED_UP');
    await page.getByRole('button', {name: `Đã mang ra ${fixture.menu!.name}`}).click();
    await expect.poll(itemStatus, {timeout: 20_000}).toBe('SERVED');
    console.log(`[TC_EXT_017] PASS: reconnect + REST resync; KDS PREPARING -> READY; ` +
      `Waiter PICKED_UP -> SERVED; own order ${fixture.orderId}; WS connections ${sockets.length}`);

    const orderStatus = async () => (await checked('GET',
      `/api/v1/orders/${fixture.orderId}`, 'waiter', 200)).status as string;
    await page.goto(`/tables/${fixture.table!.id}/summary`, {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: 'Yêu cầu thanh toán đơn'}).click();
    await page.getByRole('dialog', {name: 'Yêu cầu thanh toán?'})
      .getByRole('button', {name: 'Yêu cầu thanh toán'}).click();
    await expect.poll(orderStatus, {timeout: 20_000}).toBe('BILLING');

    // The summary replaces the top-right logout with a back link; return to
    // the table map so the role change uses the product's logout button.
    await page.goto('/tables', {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: 'Đăng xuất'}).click();
    await expect(page).toHaveURL(/\/login$/, {timeout: 15_000});
    await page.getByLabel('Mã nhân viên', {exact: true}).fill('cashier');
    await page.getByLabel('Mã PIN', {exact: true}).fill(pin!);
    await page.getByRole('button', {name: 'Đăng nhập', exact: true}).click();
    await expect(page).toHaveURL(/\/tables$/, {timeout: 15_000});
    await page.goto(`/tables/${fixture.table!.id}/summary`, {waitUntil: 'domcontentloaded'});
    const summary = page.locator('.nova-summary-card');
    await expect(summary, 'Cashier sees the billing summary').toBeVisible();
    await testInfo.attach('S2_UI_cashier_billing_summary', {
      body: await summary.screenshot(), contentType: 'image/png',
    });
    await page.getByRole('button', {name: 'Xác nhận đơn đã thanh toán'}).click();
    await page.getByRole('dialog', {name: 'Xác nhận đã thanh toán?'})
      .getByRole('button', {name: 'Xác nhận đã thanh toán'}).click();
    await expect.poll(orderStatus, {timeout: 20_000}).toBe('PAID');
    console.log(`[S2-UI] Payment UI PASS: Waiter requested billing; Cashier confirmed ` +
      `simulated staging payment; order ${fixture.orderId} PAID. ` +
      `Invoice export/print NOT TESTED; needs deployed UI/API contract.`);
  } finally {
    holdReconnect = false;
    releaseReconnect?.();
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
