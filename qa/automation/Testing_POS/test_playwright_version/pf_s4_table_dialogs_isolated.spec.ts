import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('PF-S4-TABLE-DIALOGS | isolated QA3 transfer, merge and split dialogs',
  async ({ page, request }, testInfo) => {
    test.setTimeout(150_000);
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
    expect(expected).toMatch(/^[a-f0-9]{40}$/);

    const version = async () => {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      return (await response.json()).commit as string;
    };
    const build = await version();
    test.skip(build !== expected, `PENDING_BUILD: expected ${expected}, staging ${build}`);

    const tokens: Record<string, string> = {};
    const own: { tableId?: string; tableCode?: string; targetId?: string; sessionId?: string;
      orderId?: string; menuId?: string } = {};
    const uiWrites: string[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login') uiWrites.push(`${req.method()} ${path}`);
    });
    async function call(method: 'GET' | 'POST', path: string, role: string, data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: { Authorization: `Bearer ${tokens[role]}`,
          ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) },
        ...(data ? { data } : {}), timeout: 25_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST', path: string, role: string,
      status: number, data?: object): Promise<any> {
      const response = await call(method, path, role, data);
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
      return response.body;
    }
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`, 'waiter', 200);
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`, 'cashier', 200);

    async function cleanup() {
      if (!own.sessionId || !own.tableId) return;
      let currentTable = await table();
      if (currentTable.current_session?.id !== own.sessionId || currentTable.status !== 'OCCUPIED')
        throw new Error(`CLEANUP REQUIRED: own session ${own.sessionId} no longer at ${own.tableCode}`);
      if (!own.orderId) {
        own.orderId = (await checked('POST', '/api/v1/orders', 'cashier', 201,
          { table_session_id: own.sessionId })).id;
      }
      let current = await order();
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order no longer belongs to own session');
      if (current.status === 'NEW') {
        if (!current.items?.length) {
          if (!own.menuId) throw new Error('CLEANUP REQUIRED: no menu item to finish own order');
          await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'cashier', 201,
            { items: [{ menu_item_id: own.menuId, quantity: 1, note: 'PF-S4-TABLE-DIALOGS cleanup' }] });
        }
        await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter', 200);
      }
      current = await order();
      for (const item of current.items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,
              role, 200);
        }
        expect((await order()).items.find((row: any) => row.id === item.id)?.status).toBe('SERVED');
      }
      current = await order();
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`, 'waiter', 200);
      current = await order();
      if (!['PAID', 'CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${own.orderId}/pay`, 'cashier', 200);
      if ((await order()).status !== 'CLOSED')
        await checked('POST', `/api/v1/orders/${own.orderId}/close`, 'cashier', 200);
      currentTable = await table();
      if (currentTable.status === 'CLEANING')
        await checked('POST', `/api/v1/tables/${own.tableId}/mark-clean`, 'waiter', 200);
      currentTable = await table();
      expect(currentTable.status).toBe('AVAILABLE');
      expect(currentTable.current_session).toBeNull();
      expect((await order()).status).toBe('CLOSED');
      const target = await checked('GET', `/api/v1/tables/${own.targetId}`, 'waiter', 200);
      expect(target.status, 'target table remains unused').toBe('AVAILABLE');
      expect(target.current_session).toBeNull();
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE', 'kitchen', 200);
      const active = await checked('GET', '/api/v1/kitchen/queue', 'kitchen', 200);
      expect(done.filter((row: any) => row.order_id === own.orderId)).toHaveLength(1);
      expect(active.filter((row: any) => row.order_id === own.orderId)).toHaveLength(0);
    }

    let cleanupPass = false;
    try {
      for (const role of ['admin', 'waiter', 'cashier', 'kitchen']) {
        const login = await request.post(base + '/api/v1/auth/login', {
          data: { username: `qa3_${role}`, password: pin }, timeout: 20_000,
        });
        expect(login.status(), `QA3 ${role} login`).toBe(200);
        const data = await login.json();
        expect(data.access_token).toBeTruthy();
        tokens[role] = data.access_token;
      }
      const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as
        Array<{ id: string; code: string; status: string }>;
      const source = tables.find(row => row.code === 'Q3-1');
      const target = tables.find(row => row.code === 'Q3-2');
      test.skip(!source || !target || source.status !== 'AVAILABLE' ||
        target.status !== 'AVAILABLE', 'PENDING_FIXTURE: Q3-1/Q3-2 must be AVAILABLE');
      const menu = await checked('GET', '/api/v1/menu?available_only=true', 'cashier', 200) as
        Array<{ id: string; is_available: boolean; station_id: string; has_modifiers?: boolean }>;
      const starter = menu.find(row => row.is_available && row.station_id && !row.has_modifiers);
      test.skip(!starter, 'PENDING_FIXTURE: mapped QA menu item required');
      own.tableId = source!.id;
      own.tableCode = source!.code;
      own.targetId = target!.id;
      own.menuId = starter!.id;
      own.sessionId = (await checked('POST', `/api/v1/tables/${own.tableId}/open-session`,
        'waiter', 201, { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'cashier', 201,
        { table_session_id: own.sessionId })).id;
      await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'cashier', 201,
        { items: [{ menu_item_id: own.menuId, quantity: 2, note: 'PF-S4-TABLE-DIALOGS own' }] });
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter', 200);

      await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto(`${base}/tables/${own.tableId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Bàn Q3-1' })).toBeVisible();

      await page.getByRole('button', { name: 'Chuyển bàn Q3-1' }).click();
      const transfer = page.getByRole('dialog', { name: 'Chuyển bàn Q3-1 sang bàn khác' });
      await expect(transfer).toBeVisible();
      await expect(transfer.getByText('Bàn Q3-2')).toBeVisible();
      await testInfo.attach('PF_S4_TABLE_transfer_dialog', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png',
      });
      await transfer.getByRole('button', { name: 'Hủy thao tác' }).click();

      await page.getByRole('button', { name: 'Gộp bàn vào bàn Q3-1' }).click();
      const merge = page.getByRole('dialog', { name: 'Gộp bàn vào bàn Q3-1' });
      await expect(merge).toBeVisible();
      await expect(merge.getByText('Bàn Q3-2')).toBeVisible();
      await testInfo.attach('PF_S4_TABLE_merge_dialog', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png',
      });
      await merge.getByRole('button', { name: 'Hủy thao tác' }).click();

      await page.goto(`${base}/tables/${own.tableId}/summary`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Tách bill', exact: true }).click();
      const split = page.getByRole('dialog', { name: 'Tách bill' });
      await expect(split).toBeVisible();
      await expect(split.getByTestId('split-row')).toHaveCount(1);
      await testInfo.attach('PF_S4_TABLE_split_dialog', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png',
      });
      await split.getByRole('button', { name: 'Hủy thao tác' }).click();
      expect(uiWrites, 'opening and dismissing dialogs does not write').toEqual([]);
    } finally {
      try { await cleanup(); cleanupPass = true; }
      catch (error) { console.error(`CLEANUP REQUIRED: ${String(error)}`); throw error; }
      const after = await version();
      expect(after, 'staging build stable').toBe(build);
      await testInfo.attach('PF_S4_TABLE_dialogs_evidence', {
        body: JSON.stringify({ build, scope: 'UI dialog preflight only; no transfer, merge or split submitted',
          tableCode: own.tableCode, orderId: own.orderId, uiWrites, cleanupPass }, null, 2),
        contentType: 'application/json',
      });
    }
  });
