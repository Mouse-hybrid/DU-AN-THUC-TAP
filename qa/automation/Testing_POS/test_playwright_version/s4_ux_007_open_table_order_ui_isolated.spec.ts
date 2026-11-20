import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-007 | waiter opens Q3-1, orders and sends one item in UI',
  async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 Chromium only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX007',
      test_ref: 'S4-UX-007', checked_at: new Date().toISOString(),
      scope: 'QA3 WAITER UI opens Q3-1, creates one order and mapped item, sends to kitchen; server bill/session/ticket and reload unchanged; owned cleanup. No QR or external payment.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], checks: {}, cleanup_pass: false,
    };
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; sessionId?: string; orderId?: string;
      itemId?: string; menuId?: string; menuName?: string; price?: number } = {};
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, ...Object.values(tokens)])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      return value;
    };
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const beforeBuild = await build();
    test.skip(beforeBuild !== expected, 'PENDING_BUILD: staging SHA changed');
    report.staging_commit = beforeBuild;
    for (const [role, expectedRole] of [
      ['waiter','WAITER'], ['cashier','CASHIER'], ['kitchen','KITCHEN'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username: 'qa3_' + role, password: pin }, timeout: 20_000,
      });
      expect(response.status(), 'login ' + role).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
      if (role === 'waiter') report.qa3_outlet_id = body.staff.outlet_id;
      else expect(body.staff?.outlet_id).toBe(report.qa3_outlet_id);
      tokens[role] = body.access_token;
      expect(tokens[role]).toBeTruthy();
    }
    async function call(method: 'GET'|'POST', path: string, role: string,
      data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: { Authorization: 'Bearer ' + tokens[role],
          ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) },
        ...(data === undefined ? {} : { data }), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET'|'POST', path: string, role: string,
      http: number, data?: object) {
      const result = await call(method, path, role, data);
      expect(result.http, method + ' ' + path).toBe(http);
      return result.body;
    }
    const table = () => checked('GET', '/api/v1/tables/' + own.tableId,
      'waiter', 200);
    const order = () => checked('GET', '/api/v1/orders/' + own.orderId,
      'waiter', 200);
    const queued = () => checked('GET', '/api/v1/kitchen/queue?status=QUEUED',
      'kitchen', 200) as Promise<any[]>;
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
    const q31 = tables.find(row => row.code === 'Q3-1');
    const q32 = tables.find(row => row.code === 'Q3-2');
    test.skip(!q31 || !q32 || q31.status !== 'AVAILABLE' ||
      q32.status !== 'AVAILABLE',
      'PENDING_FIXTURE: Q3-1 and Q3-2 must be AVAILABLE');
    own.tableId = q31.id;
    const menu = await checked('GET', '/api/v1/menu?available_only=true',
      'waiter', 200) as any[];
    const starter = menu.find(row => row.is_available && row.station_id &&
      !row.has_modifiers && Number(row.price) > 0);
    test.skip(!starter, 'PENDING_FIXTURE: mapped menu item required');
    own.menuId = starter.id;
    own.menuName = starter.name;
    own.price = Number(starter.price);
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        report.ui_writes.push(req.method() + ' ' + path);
    });
    async function cleanup() {
      if (!own.sessionId) { report.cleanup_pass = true; return; }
      let t = await table();
      if (t.current_session?.id !== own.sessionId &&
          !(t.status === 'CLEANING' && own.orderId &&
            ['PAID','CLOSED'].includes((await order()).status)))
        throw new Error('CLEANUP REQUIRED: owned session changed');
      if (!own.orderId) {
        const rows = (t.orders || []).filter((row: any) =>
          row.table_session_id === own.sessionId);
        if (rows.length > 1) throw new Error('CLEANUP REQUIRED: ambiguous order');
        own.orderId = rows[0]?.id || (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
      }
      let bill = await order();
      if (bill.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (!bill.items.length) {
        await checked('POST', '/api/v1/orders/' + own.orderId + '/items',
          'waiter', 201, { items: [{ menu_item_id: own.menuId, quantity: 1,
            note: 'S4-UX-007 owned cleanup' }] });
        bill = await order();
      }
      if (bill.status === 'NEW' || bill.items.some((row: any) =>
        row.status === 'CREATED'))
        await checked('POST', '/api/v1/orders/' + own.orderId +
          '/send-to-kitchen', 'waiter', 200);
      for (const item of (await order()).items) {
        for (const [state, action, role] of [
          ['SENT','start-cooking','kitchen'],
          ['PREPARING','mark-ready','kitchen'],
          ['READY','pickup','waiter'],
          ['PICKED_UP','served','waiter'],
        ] as const) {
          if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', '/api/v1/orders/' + own.orderId +
              '/items/' + item.id + '/' + action, role, 200);
        }
      }
      if (!['BILLING','PAID','CLOSED'].includes((await order()).status))
        await checked('POST', '/api/v1/orders/' + own.orderId +
          '/request-billing', 'waiter', 200);
      if ((await order()).status === 'BILLING')
        await checked('POST', '/api/v1/orders/' + own.orderId + '/pay',
          'cashier', 200);
      if ((await order()).status === 'PAID')
        await checked('POST', '/api/v1/orders/' + own.orderId + '/close',
          'cashier', 200);
      t = await table();
      if (t.status === 'CLEANING')
        await checked('POST', '/api/v1/tables/' + own.tableId +
          '/mark-clean', 'waiter', 200);
      const [finalTable, finalOrder] = await Promise.all([table(), order()]);
      const active = await checked('GET', '/api/v1/kitchen/queue',
        'kitchen', 200) as any[];
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      report.cleanup_state = {
        table_available: finalTable.status === 'AVAILABLE' &&
          !finalTable.current_session,
        order_closed: finalOrder.status === 'CLOSED',
        items_served: finalOrder.items.every((row: any) => row.status === 'SERVED'),
        ticket_done: done.some(row => row.order_id === own.orderId),
        no_active_ticket: !active.some(row => row.order_id === own.orderId),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final state mismatch');
      report.cleanup_pass = true;
    }
    let failure: unknown;
    let cleanupError: unknown;
    try {
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_waiter');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.getByRole('button', { name: /^Bàn Q3-1,/ }).click();
      await expect(page).toHaveURL(new RegExp('/tables/' + own.tableId + '/open$'));
      await expect(page.locator('#nova-guest-count')).toHaveValue('1');
      const openResponse = page.waitForResponse(response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/tables/' + own.tableId +
          '/open-session', { timeout: 20_000 });
      await page.getByRole('button', { name: 'Mở bàn', exact: true }).click();
      const opened = await openResponse;
      expect(opened.status()).toBe(201);
      own.sessionId = (await opened.json()).id;
      expect(own.sessionId).toBeTruthy();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.getByRole('button', { name: /^Bàn Q3-1,/ }).click();
      await page.getByRole('link', { name: 'Gọi món cho bàn Q3-1' }).click();
      await expect(page).toHaveURL(new RegExp('/tables/' + own.tableId + '/order$'));
      const createdResponse = page.waitForResponse(response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/orders',
      { timeout: 20_000 });
      await page.getByRole('button',
        { name: 'Thêm ' + own.menuName + ' vào đơn' }).click();
      const created = await createdResponse;
      expect(created.status()).toBe(201);
      own.orderId = (await created.json()).id;
      expect(own.orderId).toBeTruthy();
      const beforeSend = await order();
      own.itemId = beforeSend.items[0]?.id;
      report.checks.one_session_order_item =
        (await table()).current_session?.id === own.sessionId &&
        beforeSend.table_session_id === own.sessionId &&
        beforeSend.items.length === 1 &&
        beforeSend.items[0].menu_item_id === own.menuId &&
        beforeSend.items[0].status === 'CREATED';
      const sendResponse = page.waitForResponse(response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/orders/' + own.orderId +
          '/send-to-kitchen', { timeout: 20_000 });
      await page.getByRole('button',
        { name: 'Gửi các món mới xuống bếp' }).click();
      const sent = await sendResponse;
      expect(sent.status()).toBe(200);
      await expect.poll(async () => (await order()).items[0].status,
        { timeout: 15_000 }).toBe('SENT');
      await expect(page.getByText(/Đã gửi bếp|Đã gửi món|Đã gửi xuống bếp/i).first())
        .toBeVisible({ timeout: 8_000 });
      report.checks.ui_sent_feedback = true;
      await testInfo.attach('S4_UX_007_sent', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const sentOrder = await order();
      const ownTicket = (await queued()).filter(row =>
        row.order_id === own.orderId &&
        (row.order_item_id === own.itemId || row.item_id === own.itemId));
      report.checks.amount_and_ticket = Number(sentOrder.subtotal) === own.price &&
        sentOrder.items.length === 1 && ownTicket.length === 1 &&
        ownTicket[0].station_id === starter.station_id;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.goto('/tables/' + own.tableId,
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page.getByRole('heading', { name: 'Bàn Q3-1' }).first())
        .toBeVisible();
      const reloaded = await order();
      report.checks.reload_no_duplicate =
        reloaded.table_session_id === own.sessionId &&
        reloaded.items.length === 1 && reloaded.items[0].id === own.itemId &&
        (await queued()).filter(row => row.order_id === own.orderId).length === 1;
      report.checks.exact_ui_writes = report.ui_writes.filter((x: string) =>
        x.endsWith('/open-session')).length === 1 &&
        report.ui_writes.filter((x: string) => x === 'POST /api/v1/orders').length === 1 &&
        report.ui_writes.filter((x: string) => x.endsWith('/send-to-kitchen')).length === 1 &&
        report.ui_writes.length === 3;
      report.table_code = 'Q3-1';
      report.session_id = own.sessionId;
      report.order_id = own.orderId;
      report.item_id = own.itemId;
      report.ui_http = { open: opened.status(), order: created.status(),
        send: sent.status() };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Open/order/send UI mismatch: ' +
          JSON.stringify(report.checks));
      report.business_execution = 'EXECUTED';
    } catch (error) { failure = error; }
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === beforeBuild;
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_007_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_007_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-007] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-007] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
