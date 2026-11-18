import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('S4-UX-020 | waiter picks up and serves own ready item in UI',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'Pin and full pinned staging SHA required');
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; sessionId?: string; orderId?: string;
      itemId?: string; menuId?: string; token?: string; note?: string;
      qrIssued?: boolean } = {};
    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX020`,
      test_ref: 'S4-UX-020',
      checked_at: new Date().toISOString(), project: testInfo.project.name,
      scope: 'QA3 owned READY item: WAITER UI picks up then serves it; item, bill, ticket DONE and owned cleanup verified.',
      token_recorded: false, secrets_recorded: false, checks: {}, ui_writes: [],
      cleanup_pass: false,
    };
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, ...Object.values(tokens), own.token])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      return value.replace(/\/api\/v1\/public\/qr\/[^\s/'"]+/g,
        '/api/v1/public/qr/<REDACTED>');
    };
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const before = await build();
    test.skip(before !== expected, 'PENDING_BUILD: staging SHA changed');
    report.staging_commit = before;
    const specResponse = await request.get(base + '/openapi.json');
    expect(specResponse.status()).toBe(200);
    const spec = await specResponse.json();
    for (const [path, method] of [
      ['/api/v1/outlet/settings', 'get'],
      ['/api/v1/outlet/settings', 'patch'],
      ['/api/v1/public/qr/{token}/orders', 'post'],
      ['/api/v1/tables/{table_id}/qr-session', 'post'],
    ] as const) expect(spec.paths?.[path]?.[method], `${method} ${path}`).toBeTruthy();
    for (const [role, username, expectedRole] of [
      ['admin', 'qa3_admin', 'SUPERVISOR'],
      ['waiter', 'qa3_waiter', 'WAITER'],
      ['cashier', 'qa3_cashier', 'CASHIER'],
      ['kitchen', 'qa3_kitchen', 'KITCHEN'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status(), `${role} login`).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
      if (role === 'admin') report.qa3_outlet_id = body.staff?.outlet_id;
      else expect(body.staff?.outlet_id).toBe(report.qa3_outlet_id);
      tokens[role] = body.access_token;
    }
    async function call(method: 'GET'|'POST'|'PATCH'|'DELETE',
      path: string, role?: string, data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: {
          ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
          ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}),
        },
        ...(data === undefined ? {} : { data }), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET'|'POST'|'PATCH'|'DELETE',
      path: string, role: string|undefined, http: number, data?: object) {
      const result = await call(method, path, role, data);
      expect(result.http, `${method} ${path.replace(own.token || '____', '<TOKEN>')}`)
        .toBe(http);
      return result.body;
    }
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`, 'cashier', 200);
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`, 'waiter', 200);
    async function cleanup() {
      if (!own.sessionId) { report.cleanup_pass = true; return; }
      const observed = await table();
      if (observed.current_session?.id !== own.sessionId &&
          !(observed.status === 'CLEANING' && own.orderId &&
            ['PAID','CLOSED'].includes((await order()).status)))
        throw new Error('CLEANUP REQUIRED: QA3 session ownership changed');
      if (own.qrIssued && observed.current_session?.id === own.sessionId) {
        await checked('DELETE', `/api/v1/tables/${own.tableId}/qr-session`,
          'waiter', 204);
        own.qrIssued = false;
      }
      if (!own.orderId) {
        const found = (observed.orders || []).filter((row: any) =>
          row.table_session_id === own.sessionId);
        if (found.length > 1) throw new Error('CLEANUP REQUIRED: ambiguous order');
        own.orderId = found[0]?.id || (await checked('POST',
          '/api/v1/orders', 'waiter', 201,
          { table_session_id: own.sessionId })).id;
      }
      let current = await order();
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (!current.items.length) {
        await checked('POST', `/api/v1/orders/${own.orderId}/items`,
          'waiter', 201, { items: [{ menu_item_id: own.menuId, quantity: 1,
            note: 'S4 QR owned cleanup' }] });
        current = await order();
      }
      if (current.status === 'NEW' || current.items.some((row: any) => row.status === 'CREATED'))
        await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
          'waiter', 200);
      for (const item of (await order()).items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'],
          ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'],
          ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,
              role, 200);
        }
      }
      current = await order();
      if (!['BILLING','PAID','CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
          'waiter', 200);
      if ((await order()).status === 'BILLING')
        await checked('POST', `/api/v1/orders/${own.orderId}/pay`, 'cashier', 200);
      if ((await order()).status === 'PAID')
        await checked('POST', `/api/v1/orders/${own.orderId}/close`, 'cashier', 200);
      if ((await table()).status === 'CLEANING')
        await checked('POST', `/api/v1/tables/${own.tableId}/mark-clean`, 'waiter', 200);
      const finalOrder = await order(), finalTable = await table();
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      const active = await checked('GET', '/api/v1/kitchen/queue',
        'kitchen', 200) as any[];
      report.cleanup_state = {
        order_closed: finalOrder.status === 'CLOSED',
        table_available: finalTable.status === 'AVAILABLE' && !finalTable.current_session,
        items_served: finalOrder.items.every((row: any) => row.status === 'SERVED'),
        ticket_done: done.some((row: any) => row.order_id === own.orderId),
        no_active_ticket: !active.some((row: any) => row.order_id === own.orderId),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final order/table/ticket state mismatch');
      report.cleanup_pass = true;
    }

    let failure: unknown, cleanupError: unknown;
    const context = await browser.newContext({ baseURL: base });
    const page = await context.newPage();
    try {
      const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
      const candidate = tables.find(row => row.code === 'Q3-1' &&
        row.status === 'AVAILABLE');
      if (!candidate) throw new Error('PENDING_FIXTURE: Q3-1 unavailable');
      own.tableId = candidate.id;
      const menu = await checked('GET', '/api/v1/menu?available_only=true',
        'waiter', 200) as any[];
      const item = menu.find(row => row.is_available && row.station_id &&
        !row.has_modifiers && Number(row.price) > 0);
      if (!item) throw new Error('PENDING_FIXTURE: mapped menu item unavailable');
      own.menuId = item.id;
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${own.tableId}/open-session`, 'waiter', 201,
        { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders',
        'waiter', 201, { table_session_id: own.sessionId })).id;
      report.session_id = own.sessionId;
      report.order_id = own.orderId;
      console.log(`[S4-UX-020] Own Q3-1 session ${own.sessionId}, order ${own.orderId}`);
      own.note = `S4-UX-020 KDS ${randomUUID().slice(0, 8)}`;
      const added = await checked('POST', `/api/v1/orders/${own.orderId}/items`,
        'waiter', 201, { items: [{ menu_item_id: item.id, quantity: 1,
          note: own.note }] });
      own.itemId = added.items.find((row: any) =>
        row.menu_item_id === item.id)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
        'waiter', 200);
      const readyItemPath = `/api/v1/orders/${own.orderId}/items/${own.itemId}`;
      await checked('POST', readyItemPath + '/start-cooking', 'kitchen', 200);
      await checked('POST', readyItemPath + '/mark-ready', 'kitchen', 200);
      const readyBill = await order();
      const readyTickets = await checked('GET',
        '/api/v1/kitchen/queue?item_status=READY', 'kitchen', 200) as any[];
      report.checks.ready_fixture = readyBill.items.some((row: any) =>
        row.id === own.itemId && row.status === 'READY') &&
        readyTickets.some(row => row.order_id === own.orderId &&
          (row.order_item_id === own.itemId || row.item_id === own.itemId));
      const mutations: string[] = [];
      page.on('request', req => {
        const path = new URL(req.url()).pathname;
        if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
            path !== '/api/v1/auth/login') mutations.push(`${req.method()} ${path}`);
      });
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_waiter');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto(base + `/tables/${own.tableId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Bàn Q3-1' })).toBeVisible();
      const pickupPath = readyItemPath + '/pickup';
      const pickup = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' &&
          new URL(response.url()).pathname === pickupPath, { timeout: 20_000 }),
        page.getByRole('button', { name: `Lấy món ${item.name}`, exact: true }).click(),
      ]).then(([response]) => response);
      report.pickup_http = pickup.status();
      await expect.poll(async () => (await order()).items.find((row: any) =>
        row.id === own.itemId)?.status).toBe('PICKED_UP');
      await testInfo.attach('S4_UX_020_picked_up', {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });
      const servedPath = readyItemPath + '/served';
      const served = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' &&
          new URL(response.url()).pathname === servedPath, { timeout: 20_000 }),
        page.getByRole('button', { name: `Đã mang ra ${item.name}`, exact: true }).click(),
      ]).then(([response]) => response);
      report.served_http = served.status();
      await expect.poll(async () => (await order()).items.find((row: any) =>
        row.id === own.itemId)?.status).toBe('SERVED');
      const finalBill = await order();
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      const active = await checked('GET', '/api/v1/kitchen/queue',
        'kitchen', 200) as any[];
      report.checks.pickup_once = pickup.status() === 200;
      report.checks.served_once = served.status() === 200;
      report.checks.item_and_bill = finalBill.items.some((row: any) =>
        row.id === own.itemId && row.status === 'SERVED' &&
        Number(row.unit_price) === Number(item.price)) &&
        Number(finalBill.subtotal) === Number(item.price);
      report.checks.ticket_done = done.some((row: any) => row.order_id === own.orderId &&
        (row.order_item_id === own.itemId || row.item_id === own.itemId));
      report.checks.no_active_ticket = !active.some((row: any) =>
        row.order_id === own.orderId);
      report.checks.exact_ui_writes = mutations.length === 2 &&
        mutations.filter(value => value === `POST ${pickupPath}`).length === 1 &&
        mutations.filter(value => value === `POST ${servedPath}`).length === 1;
      report.ui_writes = mutations;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Bàn Q3-1' })).toBeVisible();
      report.checks.reload_consistent = (await order()).items.some((row: any) =>
        row.id === own.itemId && row.status === 'SERVED');
      await testInfo.attach('S4_UX_020_served', {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('S4-UX-020 pickup/served mismatch: ' +
          JSON.stringify(report.checks));
      report.business_execution = 'EXECUTED';
    } catch (error) { failure = error; }
    await context.close().catch(() => {});
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ?
        'INCONCLUSIVE' : redact(failure).includes('PENDING_FIXTURE') ?
        'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `S4_UX_020_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_020_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-020] Evidence: .\\evidence\\${name}`);
    console.log('[S4-UX-020] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
