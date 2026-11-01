import {randomUUID} from 'node:crypto';
import {expect, test, type BrowserContext, type Page} from '@playwright/test';

// Open an available QA table and create its order through the product UI.
// API reads assert persisted state; only order-close uses API because no UI action exists.
// QA3_REHEARSAL uses only the isolated Q3 tables and seed accounts. It is not user UAT.
const qa3Rehearsal = process.env.QA3_REHEARSAL === 'true';
const tableCode = qa3Rehearsal ? /^Q3-[1-3]$/ : /^B[1-4]$/;
const runId = qa3Rehearsal ? 'QA3-REHEARSAL-01' : 'S2-UI-BIZ-01';
const account = (role: string) => qa3Rehearsal ? `qa3_${role}` : role;

test(`${runId} | open table, order, KDS, serve, pay and clean`, async ({browser, request}, testInfo) => {
  test.setTimeout(180_000);
  const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
  expect(base, 'approved staging only').toBe('http://160.191.47.17');
  const pin = process.env.S2_STAGING_PIN;
  test.skip(!pin, 'Local staging PIN required');

  type Table = {id: string; code: string; status: string; current_session_id?: string};
  type Item = {id: string; name: string; is_available: boolean; station_id: string};
  type Order = {id: string; table_session_id: string; status: string;
    items: Array<{id: string; status: string; menu_item_id: string}>};
  const tokens: Record<string, string> = {};
  const fixture: {table?: Table; sessionId?: string; orderId?: string; itemId?: string; menu?: Item} = {};
  const contexts: BrowserContext[] = [];
  const observations: Record<string, unknown>[] = [];

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
  async function order() {
    return await checked('GET', `/api/v1/orders/${fixture.orderId}`, 'waiter', 200) as Order;
  }
  async function waitForStatus(status: string) {
    await expect.poll(async () => (await order()).items.find(item => item.id === fixture.itemId)?.status,
      {timeout: 20_000, message: `owned item ${fixture.itemId} should be ${status}`}).toBe(status);
    observations.push({step: status, orderId: fixture.orderId, itemId: fixture.itemId});
  }
  async function login(role: string): Promise<Page> {
    const context = await browser.newContext({baseURL: base});
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('/login', {waitUntil: 'domcontentloaded'});
    await page.getByLabel('Mã nhân viên', {exact: true}).fill(account(role));
    await page.getByLabel('Mã PIN', {exact: true}).fill(pin!);
    await page.getByRole('button', {name: 'Đăng nhập', exact: true}).click();
    await expect(page).toHaveURL(new RegExp(role === 'kitchen' ? '/kitchen$' : '/tables$'),
      {timeout: 15_000});
    return page;
  }
  async function cleanup() {
    if (!fixture.sessionId || !fixture.table) return;
    const table = await checked('GET', `/api/v1/tables/${fixture.table.id}`, 'waiter', 200);
    const existing = fixture.orderId ? await order() : undefined;
    if (existing && existing.table_session_id !== fixture.sessionId) {
      throw new Error(`CLEANUP REQUIRED: order ${fixture.orderId} belongs to another session`);
    }
    if (table.status === 'AVAILABLE' && !table.current_session) {
      expect(existing?.status, 'owned order closed when table is available').toBe('CLOSED');
      return;
    }
    const ownOpenSession = table.status === 'OCCUPIED' &&
      table.current_session?.id === fixture.sessionId;
    const ownPaidSession = table.status === 'CLEANING' && !table.current_session &&
      existing && ['PAID', 'CLOSED'].includes(existing.status);
    if (!ownOpenSession && !ownPaidSession) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.table.code} state ${table.status}; ` +
        `session ${table.current_session?.id ?? 'none'}; owned ${fixture.sessionId}; ` +
        `order ${existing?.status ?? 'none'}`);
    }
    if (!fixture.orderId) {
      const created = await checked('POST', '/api/v1/orders', 'waiter', 201,
        {table_session_id: fixture.sessionId});
      fixture.orderId = created.id;
      console.log(`[S2-UI] Recovery: created own order ${fixture.orderId} for session ${fixture.sessionId}`);
    }
    let current = existing ?? await order();
    expect(current.table_session_id, 'cleanup order belongs to own session').toBe(fixture.sessionId);
    if (current.status === 'NEW') {
      if (current.items.length === 0) {
        if (!fixture.menu) throw new Error('CLEANUP REQUIRED: no mapped QA menu item');
        await checked('POST', `/api/v1/orders/${fixture.orderId}/items`, 'waiter', 201,
          {items: [{menu_item_id: fixture.menu.id, quantity: 1, note: `${runId} cleanup`}]});
      }
      await checked('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, 'waiter', 200);
      current = await order();
    }
    if (current.status === 'SENT' || current.status === 'SERVED') {
      await checked('POST', `/api/v1/orders/${fixture.orderId}/request-billing`, 'waiter', 200);
      current = await order();
    }
    if (current.status === 'BILLING') {
      await checked('POST', `/api/v1/orders/${fixture.orderId}/pay`, 'cashier', 200);
      current = await order();
    }
    if (current.status === 'PAID') {
      await checked('POST', `/api/v1/orders/${fixture.orderId}/close`, 'cashier', 200);
    }
    expect((await order()).status, 'owned order closed before cleaning').toBe('CLOSED');
    const cleaned = await checked('POST', `/api/v1/tables/${fixture.table.id}/mark-clean`,
      'waiter', 200);
    expect(cleaned.status, 'own QA table cleaned').toBe('AVAILABLE');
    const final = await checked('GET', `/api/v1/tables/${fixture.table.id}`, 'waiter', 200);
    expect(final.current_session, 'no open session after cleanup').toBeNull();
    console.log(`[S2-UI] CLEANUP: ${fixture.table.code} AVAILABLE; order ${fixture.orderId} CLOSED`);
  }

  try {
    for (const role of (qa3Rehearsal ? ['waiter', 'kitchen', 'cashier', 'admin'] :
      ['waiter', 'kitchen', 'cashier'])) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: {username: account(role), password: pin}, timeout: 20_000});
      expect(response.status(), `${role} login`).toBe(200);
      tokens[role] = (await response.json()).access_token;
      expect(tokens[role], `${role} JWT`).toBeTruthy();
    }
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as Table[];
    const available = tables.filter(t => tableCode.test(t.code) && t.status === 'AVAILABLE');
    console.log(`[S2-UI] Fixture gate: ${tables.filter(t => tableCode.test(t.code))
      .map(t => `${t.code}:${t.status}`).join(', ')}; available ${available.length}`);
    test.skip(!available.length, `PENDING: no AVAILABLE ${qa3Rehearsal ? 'Q3-1..Q3-3' : 'B1-B4'}; no mutation`);
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 'waiter', 200) as Item[];
    fixture.menu = menu.find(item => item.is_available && Boolean(item.station_id));
    test.skip(!fixture.menu, 'PENDING: no available item mapped to Kitchen; no mutation');

    const waiter = await login('waiter');
    for (const table of available) {
      await waiter.goto('/tables', {waitUntil: 'domcontentloaded'});
      await waiter.getByRole('button', {name: new RegExp(`^Bàn ${table.code},`)}).click();
      await expect(waiter).toHaveURL(new RegExp(`/tables/${table.id}/open$`));
      await expect(waiter.locator('#nova-guest-count'), 'default guest count').toHaveValue('1');
      const openedResponse = waiter.waitForResponse(response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/tables/${table.id}/open-session`);
      await waiter.getByRole('button', {name: 'Mở bàn', exact: true}).click();
      const opened = await openedResponse;
      if (opened.status() === 409) continue;
      expect(opened.status(), `${table.code} UI open-session`).toBe(201);
      fixture.table = table;
      fixture.sessionId = (await opened.json()).id;
      expect(fixture.sessionId, 'owned UI table session').toBeTruthy();
      await expect(waiter).toHaveURL(/\/tables$/, {timeout: 15_000});
      break;
    }
    test.skip(!fixture.sessionId, 'PENDING: reservation race; no owned session');
    await waiter.getByRole('button', {name: new RegExp(`^Bàn ${fixture.table!.code},`)}).click();
    await waiter.getByRole('link', {name: `Gọi món cho bàn ${fixture.table!.code}`}).click();
    await expect(waiter).toHaveURL(new RegExp(`/tables/${fixture.table!.id}/order$`));
    const createdResponse = waiter.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/orders');
    await waiter.getByRole('button', {name: `Thêm ${fixture.menu!.name} vào đơn`}).click();
    const created = await createdResponse;
    expect(created.status(), 'UI creates order with first item').toBe(201);
    fixture.orderId = (await created.json()).id;
    console.log(`[S2-UI] UI fixture: ${fixture.table!.code}, session ${fixture.sessionId}, order ${fixture.orderId}`);
    await expect.poll(async () => (await order()).items.length, {timeout: 20_000}).toBe(1);
    let current = await order();
    fixture.itemId = current.items[0].id;
    expect(current.items[0].menu_item_id).toBe(fixture.menu!.id);
    await waitForStatus('CREATED');
    await waiter.getByRole('button', {name: 'Gửi các món mới xuống bếp'}).click();
    await waitForStatus('SENT');
    const queue = await checked('GET', '/api/v1/kitchen/queue?status=QUEUED', 'kitchen', 200);
    expect(queue.filter((entry: any) => entry.order_item_id === fixture.itemId)).toHaveLength(1);

    const kitchen = await login('kitchen');
    const ownCode = `${fixture.table!.code}-${fixture.orderId!.replaceAll('-', '').slice(-4).toUpperCase()}`;
    let card = kitchen.locator('article.nova-kds-ticket').filter({hasText: `#${ownCode}`});
    await expect(card).toHaveCount(1, {timeout: 15_000});
    await card.getByRole('button', {name: `Bắt đầu nấu ${fixture.menu!.name} bàn ${fixture.table!.code}`}).click();
    await waitForStatus('PREPARING');
    await kitchen.getByRole('tab', {name: 'Đang chế biến'}).click();
    card = kitchen.locator('article.nova-kds-ticket').filter({hasText: `#${ownCode}`});
    await expect(card).toHaveCount(1, {timeout: 15_000});
    await card.getByRole('button', {name: `Món xong ${fixture.menu!.name} bàn ${fixture.table!.code}`}).click();
    await waitForStatus('READY');

    await waiter.goto(`/tables/${fixture.table!.id}`, {waitUntil: 'domcontentloaded'});
    await waiter.getByRole('button', {name: `Lấy món ${fixture.menu!.name}`}).click();
    await waitForStatus('PICKED_UP');
    await waiter.getByRole('button', {name: `Đã mang ra ${fixture.menu!.name}`}).click();
    await waitForStatus('SERVED');
    await waiter.goto(`/tables/${fixture.table!.id}/summary`, {waitUntil: 'domcontentloaded'});
    expect((await order()).items.find(item => item.id === fixture.itemId)?.status,
      'owned item is served before requesting payment').toBe('SERVED');
    await waiter.getByRole('button', {name: 'Yêu cầu thanh toán đơn'}).click();
    await waiter.getByRole('dialog', {name: 'Yêu cầu thanh toán?'}).getByRole('button',
      {name: 'Yêu cầu thanh toán'}).click();
    await expect.poll(async () => (await order()).status, {timeout: 20_000}).toBe('BILLING');

    const cashier = await login('cashier');
    await cashier.goto(`/tables/${fixture.table!.id}/summary`, {waitUntil: 'domcontentloaded'});
    await cashier.getByRole('button', {name: 'Xác nhận đơn đã thanh toán'}).click();
    await cashier.getByRole('dialog', {name: 'Xác nhận đã thanh toán?'}).getByRole('button',
      {name: 'Xác nhận đã thanh toán'}).click();
    await expect.poll(async () => (await order()).status, {timeout: 20_000}).toBe('PAID');
    await checked('POST', `/api/v1/orders/${fixture.orderId}/close`, 'cashier', 200);
    await expect.poll(async () => (await checked('GET', `/api/v1/tables/${fixture.table!.id}`,
      'waiter', 200)).status, {timeout: 20_000}).toBe('CLEANING');
    await waiter.goto('/tables', {waitUntil: 'domcontentloaded'});
    const markClean = waiter.getByRole('button', {name: `Dọn xong bàn ${fixture.table!.code}`});
    await expect(markClean).toBeVisible();
    await markClean.click();
    await expect.poll(async () => (await checked('GET', `/api/v1/tables/${fixture.table!.id}`,
      'waiter', 200)).status, {timeout: 20_000}).toBe('AVAILABLE');
    expect((await order()).status).toBe('CLOSED');
    if (qa3Rehearsal) {
      await login('admin');
      const audit = await checked('GET', `/api/v1/audit-logs?order_id=${fixture.orderId}`,
        'admin', 200) as Array<{action: string; staff_username: string}>;
      for (const [action, actor] of [
        ['ORDER_CREATED', 'qa3_waiter'],
        ['ORDER_ITEM_START_COOKING', 'qa3_kitchen'],
        ['ORDER_PAID', 'qa3_cashier'],
        ['ORDER_CLOSED', 'qa3_cashier'],
      ]) {
        expect(audit.some(row => row.action === action && row.staff_username === actor),
          `${action} audited for ${actor}`).toBe(true);
      }
      console.log(`[QA3] Supervisor audit PASS: ${audit.length} rows for own order ${fixture.orderId}`);
    }
    console.log(`[S2-UI] ${qa3Rehearsal ? 'QA REHEARSAL' : 'BUSINESS'} PASS: ` +
      `${fixture.table!.code}; order ${fixture.orderId} CLOSED; item ${fixture.itemId} SERVED; ` +
      'simulated staging payment; table AVAILABLE');
  } finally {
    try {
      await cleanup();
    } catch (error) {
      console.error(`[S2-UI] CLEANUP REQUIRED: ${fixture.table?.code} session ${fixture.sessionId} ` +
        `order ${fixture.orderId}; ${String(error)}`);
      throw error;
    } finally {
      await testInfo.attach(`${runId}_fixture_and_states`, {
        body: JSON.stringify({fixture, observations, scope: qa3Rehearsal ?
          'QA3 rehearsal with API persistence checks; not user UAT' :
          'UI lifecycle with API persistence checks'}, null, 2),
        contentType: 'application/json',
      });
      await Promise.all(contexts.map(context => context.close()));
    }
  }
});
