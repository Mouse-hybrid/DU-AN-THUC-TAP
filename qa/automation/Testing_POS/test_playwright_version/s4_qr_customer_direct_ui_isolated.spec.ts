import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('S4-QR-CUSTOMER-DIRECT-UI | QA3 customer submits a noted item to kitchen',
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
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4QRCUSTOMERDIRECT`,
      test_ref: 'S4-QR-CUSTOMER-DIRECT-UI',
      checked_at: new Date().toISOString(), project: testInfo.project.name,
      scope: 'QA3 public customer browser submits one noted QR item in DIRECT mode; UI confirmation and placed item, POS order, KDS note, audit, owned cleanup. CONFIRM mode not tested.',
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
      if ((await settings()).qr_send_mode !== 'DIRECT')
        throw new Error('PENDING_FIXTURE: QA3 outlet must start in DIRECT; no settings changed');
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
      const issued = await checked('POST',
        `/api/v1/tables/${own.tableId}/qr-session`, 'waiter', 201);
      own.qrIssued = true;
      own.token = issued.token;
      expect(own.token).toBeTruthy();
      expect(issued.table_session_id).toBe(own.sessionId);
      if (issued.path !== `/qr/${own.token}`)
        throw new Error('PENDING_CONTRACT: public customer route differs from issued path');
      const info = await checked('GET', `/api/v1/public/qr/${own.token}`,
        undefined, 200);
      expect(info.send_mode).toBe('DIRECT');
      own.note = `QA S4 QR note ${randomUUID().slice(0, 8)}`;
      const writes: number[] = [];
      page.on('request', req => {
        if (req.method() === 'POST' &&
          new URL(req.url()).pathname === `/api/v1/public/qr/${own.token}/orders`)
          writes.push(1);
      });
      await page.goto(base + issued.path, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('qr-table')).toHaveText('Bàn Q3-1');
      const menuRow = page.getByTestId('qr-menu-item').filter({ hasText: item.name });
      await expect(menuRow).toHaveCount(1);
      await menuRow.getByRole('button', { name: `Thêm ${item.name}` }).click();
      await page.getByRole('textbox', { name: `Ghi chú cho ${item.name}` }).fill(own.note);
      const [submitted] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/v1/public/qr/${own.token}/orders`,
          { timeout: 20_000 }),
        page.getByRole('button', { name: 'Gửi món vào bếp' }).click(),
      ]);
      report.ui_submit_http = submitted.status();
      report.ui_writes = ['POST /api/v1/public/qr/<TOKEN>/orders'];
      report.checks.one_ui_submit = writes.length === 1 && submitted.status() === 201;
      await expect(page.getByRole('status').filter({ hasText: 'Đã gửi món vào bếp' }))
        .toBeVisible();
      const placed = page.getByTestId('qr-placed');
      await expect(placed).toContainText(item.name);
      await expect(placed).toContainText(own.note);
      await expect(placed).toContainText('Đã gửi bếp');
      report.checks.customer_receipt_visible = true;
      await testInfo.attach('S4_QR_CUSTOMER_DIRECT_UI', {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });
      const current = await order();
      const qrItems = current.items.filter((row: any) =>
        row.source === 'QR' && row.menu_item_id === own.menuId);
      own.itemId = qrItems[0]?.id;
      const queued = await checked('GET', '/api/v1/kitchen/queue?status=QUEUED',
        'kitchen', 200) as any[];
      const tickets = queued.filter(row =>
        row.order_id === own.orderId && (row.order_item_id === own.itemId ||
          row.item_id === own.itemId));
      const ownAudit = await audit(`/api/v1/audit-logs?order_id=${own.orderId}&limit=100`);
      report.checks.direct_sent = current.status === 'SENT' && qrItems.length === 1 &&
        qrItems[0].status === 'SENT' && qrItems[0].note === own.note;
      report.checks.one_station_ticket = tickets.length === 1 &&
        tickets[0].station_id === item.station_id &&
        tickets[0].note === own.note;
      report.checks.qr_send_audit_once = ownAudit.filter(row =>
        row.action === 'ORDER_SENT_TO_KITCHEN' &&
        row.payload?.source === 'QR').length === 1;
      report.order_id = own.orderId; report.qr_item_id = own.itemId;
      report.queue_count_for_item = tickets.length;
      console.log(`[S4-QR-CUSTOMER] Own Q3-1 order ${own.orderId}; checking Kitchen UI`);
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_kitchen');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/kitchen$/, { timeout: 15_000 });
      await testInfo.attach('S4_QR_DIRECT_KDS', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      const noteOnTicket = page.locator('.nova-kds-ticket .nova-kds-note')
        .filter({ hasText: own.note! });
      await expect(noteOnTicket).toHaveCount(1, { timeout: 12_000 });
      await expect(noteOnTicket).toBeVisible();
      report.checks.kds_note_visible = true;
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('QR customer DIRECT/KDS mismatch: ' +
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
    const name = `S4_QR_CUSTOMER_DIRECT_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_QR_CUSTOMER_DIRECT_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-QR-CUSTOMER] Evidence: .\\evidence\\${name}`);
    console.log('[S4-QR-CUSTOMER] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
