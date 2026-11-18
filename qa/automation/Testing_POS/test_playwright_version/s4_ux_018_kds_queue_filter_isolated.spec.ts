import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('S4-UX-018 | KDS queue tabs and station filter match server',
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
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX018`,
      test_ref: 'S4-UX-018',
      checked_at: new Date().toISOString(), project: testInfo.project.name,
      scope: 'QA3 isolated item SENT by WAITER API fixture; KITCHEN UI reads new/preparing/ready tabs, station filter and server queue; no KDS UI business write; owned cleanup.',
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
    const settings = () => checked('GET', '/api/v1/outlet/settings', 'admin', 200);
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`, 'cashier', 200);
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`, 'waiter', 200);
    const audit = (path: string) => checked('GET', path, 'admin', 200) as Promise<any[]>;
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
      console.log(`[S4-UX-018] Own Q3-1 session ${own.sessionId}, order ${own.orderId}`);
      own.note = `S4-UX-018 KDS ${randomUUID().slice(0, 8)}`;
      const added = await checked('POST', `/api/v1/orders/${own.orderId}/items`,
        'waiter', 201, { items: [{ menu_item_id: item.id, quantity: 1,
          note: own.note }] });
      own.itemId = added.items.find((row: any) =>
        row.menu_item_id === item.id)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
        'waiter', 200);
      const queued = await checked('GET', '/api/v1/kitchen/queue?status=QUEUED',
        'kitchen', 200) as any[];
      const ticket = queued.find(row => row.order_id === own.orderId &&
        (row.order_item_id === own.itemId || row.item_id === own.itemId));
      report.checks.own_ticket_on_station = !!ticket &&
        ticket.station_id === item.station_id && ticket.note === own.note;
      const mutations: string[] = [];
      page.on('request', req => {
        const path = new URL(req.url()).pathname;
        if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
            path !== '/api/v1/auth/login') mutations.push(`${req.method()} ${path}`);
      });
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_kitchen');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/kitchen$/, { timeout: 15_000 });
      await expect(page.getByRole('tab', { name: 'Món mới' }))
        .toHaveAttribute('aria-selected', 'true');
      await testInfo.attach('S4_UX_018_new_queue', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      const noteOnTicket = page.locator('.nova-kds-ticket .nova-kds-note')
        .filter({ hasText: own.note! });
      await expect(noteOnTicket).toHaveCount(1, { timeout: 12_000 });
      await expect(noteOnTicket).toBeVisible();
      report.checks.own_ticket_visible = true;
      const stations = await checked('GET', '/api/v1/kitchen/stations',
        'kitchen', 200) as any[];
      report.checks.stations_loaded = stations.some(row =>
        row.id === item.station_id && row.is_active !== false);
      const filterResponse = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/v1/kitchen/queue' &&
        new URL(response.url()).searchParams.get('station_id') === item.station_id);
      await page.getByLabel('Trạm bếp').selectOption(item.station_id);
      const filtered = await filterResponse;
      const stationQueue = await filtered.json();
      report.checks.station_filter = filtered.status() === 200 &&
        stationQueue.every((row: any) => row.station_id === item.station_id) &&
        stationQueue.some((row: any) => row.order_id === own.orderId);
      const preparingResponse = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/v1/kitchen/queue' &&
        new URL(response.url()).searchParams.get('status') === 'IN_PROGRESS');
      await page.getByRole('tab', { name: 'Đang chế biến' }).click();
      const preparing = await preparingResponse;
      report.checks.preparing_tab = preparing.status() === 200 &&
        Array.isArray(await preparing.json());
      await expect(page.getByRole('tab', { name: 'Đang chế biến' }))
        .toHaveAttribute('aria-selected', 'true');
      const readyResponse = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/v1/kitchen/queue' &&
        (new URL(response.url()).searchParams.get('item_status') || '')
          .includes('READY'));
      await page.getByRole('tab', { name: 'Sẵn sàng' }).click();
      const ready = await readyResponse;
      report.checks.ready_tab = ready.status() === 200 &&
        Array.isArray(await ready.json());
      await expect(page.getByRole('tab', { name: 'Sẵn sàng' }))
        .toHaveAttribute('aria-selected', 'true');
      const emptyQueuePath = /\/api\/v1\/kitchen\/queue(?:\?|$)/;
      await page.route(emptyQueuePath, async route => {
        if (route.request().method() === 'GET')
          await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        else await route.continue();
      });
      try {
        await page.getByRole('tab', { name: 'Món mới' }).click();
        await expect(page.getByRole('heading', { name: 'Chưa có món' }))
          .toBeVisible({ timeout: 10_000 });
        report.checks.empty_queue_message = true;
      } finally { await page.unroute(emptyQueuePath); }
      report.checks.no_kds_ui_write = mutations.length === 0;
      report.station_id = item.station_id;
      report.ui_writes = mutations;
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('S4-UX-018 KDS queue/filter mismatch: ' +
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
    const name = `S4_UX_018_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_018_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-018] Evidence: .\\evidence\\${name}`);
    console.log('[S4-UX-018] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
