import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('P2-QR-014 | customer QR retry after lost response creates one item',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(150_000);
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
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-P2QR014`,
      test_ref: 'P2-QR-014',
      checked_at: new Date().toISOString(), project: testInfo.project.name,
      scope: 'QA3 DIRECT customer UI loses the first successful POST response after server commit, retries, then reconciles one item, ticket, bill, payment ledger and QR audit; owned cleanup. Browser-only response loss; CONFIRM mode excluded.',
      case_coverage: 'BROWSER_LOST_RESPONSE_RETRY',
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
            note: 'P2 QR 014 owned cleanup' }] });
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
      own.note = `QA P2 QR retry ${randomUUID().slice(0, 8)}`;
      const writes: string[] = [];
      let firstServerStatus: number | undefined;
      let firstServerFinished = false;
      const submitPath = `/api/v1/public/qr/${own.token}/orders`;
      report.network_probe = { route_hits: 0, page_posts: 0,
        page_failed: 0, page_finished: 0, first_server_http: null,
        observed_post_paths: [] as string[], public_qr_responses: [] as string[],
        page_errors: [] as string[], console_errors: [] as string[] };
      const safePath = (url: string) => {
        try {
          return new URL(url).pathname.replace(/\/api\/v1\/public\/qr\/[^/]+/g,
            '/api/v1/public/qr/<TOKEN>');
        } catch { return '<INVALID_URL>'; }
      };
      page.on('pageerror', error => {
        if (report.network_probe.page_errors.length < 5)
          report.network_probe.page_errors.push(redact(error.message)
            .replace(/\/qr\/[^/\s'\"]+/g, '/qr/<TOKEN>').slice(0, 350));
      });
      page.on('console', message => {
        if (message.type() === 'error' &&
            report.network_probe.console_errors.length < 5)
          report.network_probe.console_errors.push(redact(message.text())
            .replace(/\/qr\/[^/\s'\"]+/g, '/qr/<TOKEN>').slice(0, 350));
      });
      page.on('response', response => {
        const path = safePath(response.url());
        if (path.startsWith('/api/v1/public/qr/') &&
            report.network_probe.public_qr_responses.length < 12)
          report.network_probe.public_qr_responses.push(
            response.request().method() + ' ' + path + ' HTTP ' + response.status());
      });
      page.on('request', req => {
        if (req.method() === 'POST' &&
            report.network_probe.observed_post_paths.length < 12)
          report.network_probe.observed_post_paths.push(safePath(req.url()));
        if (req.method() === 'POST' && new URL(req.url()).pathname === submitPath) {
          writes.push(req.headers()['idempotency-key'] || '');
          report.network_probe.page_posts++;
          report.ui_writes.push('POST /api/v1/public/qr/<TOKEN>/orders');
        }
      });
      page.on('requestfailed', req => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === submitPath)
          report.network_probe.page_failed++;
      });
      page.on('requestfinished', req => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === submitPath)
          report.network_probe.page_finished++;
      });
      await page.route(`**${submitPath}`, async route => {
        report.network_probe.route_hits++;
        if (firstServerFinished) return route.continue();
        firstServerFinished = true;
        // The request reaches staging and commits; only its browser response is lost.
        const response = await route.fetch({ timeout: 20_000 });
        firstServerStatus = response.status();
        report.network_probe.first_server_http = firstServerStatus;
        await route.abort('failed');
      });
      await page.goto(base + issued.path, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('qr-table')).toHaveText('Bàn Q3-1');
      const menuRow = page.getByTestId('qr-menu-item').filter({ hasText: item.name });
      await expect(menuRow).toHaveCount(1);
      await menuRow.getByRole('button', { name: `Thêm ${item.name}` }).click();
      await page.getByRole('textbox', { name: `Ghi chú cho ${item.name}` }).fill(own.note);
      await page.getByRole('button', { name: 'Gửi món vào bếp' }).click();
      const confirmTable = page.getByRole('dialog');
      await expect(confirmTable).toContainText('Bạn đang ngồi ở bàn Q3-1?');
      await confirmTable.getByRole('button', {
        name: 'Đúng, bàn Q3-1', exact: true,
      }).click();
      await expect.poll(() => firstServerStatus, {
        timeout: 20_000,
        message: 'First QR request must reach staging and return 201',
      }).toBe(201);
      const committed = await order();
      const firstTable = await table();
      const firstItems = committed.items.filter((row: any) => row.source === 'QR');
      const firstQueue = await checked('GET', '/api/v1/kitchen/queue?status=QUEUED',
        'kitchen', 200) as any[];
      const firstAudit = await audit(`/api/v1/audit-logs?order_id=${own.orderId}&limit=100`);
      const firstLedger = await checked('GET',
        `/api/v1/orders/${own.orderId}/payments`, 'cashier', 200);
      report.checks.first_request_committed = firstItems.length === 1 &&
        committed.status === 'SENT';
      const success = page.getByRole('status').filter({ hasText: 'Đã gửi món vào bếp' });
      // FE may retry automatically. Otherwise, use its visible Retry or Send control.
      if (writes.length === 1) {
        const retry = page.getByRole('button', { name: 'Thử lại', exact: true });
        const send = page.getByRole('button', { name: 'Gửi món vào bếp' });
        await expect.poll(async () =>
          writes.length > 1 || await retry.isVisible() ||
          (await send.isVisible() && await send.isEnabled()),
          { timeout: 10_000 }).toBe(true);
        if (writes.length === 1 && await retry.isVisible()) await retry.click();
        else if (writes.length === 1 && await send.isEnabled()) await send.click();
        const confirmRetry = page.getByRole('dialog').getByRole('button', {
          name: 'Đúng, bàn Q3-1', exact: true,
        });
        if (await confirmRetry.isVisible()) await confirmRetry.click();
      }
      await expect.poll(() => writes.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
      await expect(success).toBeVisible({ timeout: 20_000 });
      const placed = page.getByTestId('qr-placed');
      await expect(placed).toContainText(item.name);
      await expect(placed).toContainText(own.note);
      await expect(placed).toContainText('Đã gửi bếp');
      await expect(placed.locator('li.nova-qr-line')).toHaveCount(1);
      report.checks.one_customer_receipt_line = true;
      await testInfo.attach('P2_QR_014_customer_receipt', {
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
      report.checks.one_qr_line = current.status === 'SENT' &&
        current.items.length === 1 && qrItems.length === 1 &&
        qrItems[0].status === 'SENT' && qrItems[0].quantity === 1 &&
        qrItems[0].note === own.note;
      report.checks.one_station_ticket = tickets.length === 1 &&
        tickets[0].station_id === item.station_id &&
        tickets[0].note === own.note;
      const qrAdds = ownAudit.filter(row => row.action === 'ORDER_ITEMS_ADDED' &&
        row.payload?.source === 'QR');
      const qrSends = ownAudit.filter(row => row.action === 'ORDER_SENT_TO_KITCHEN' &&
        row.payload?.source === 'QR');
      report.checks.qr_audit_once_each = qrAdds.length === 1 && qrSends.length === 1;
      const finalLedger = await checked('GET',
        `/api/v1/orders/${own.orderId}/payments`, 'cashier', 200);
      const finalTable = await table();
      const ownOrders = (rows: any[]) => rows.filter(row =>
        row.table_session_id === own.sessionId);
      report.checks.one_order_same_session =
        ownOrders(firstTable.orders || []).length === 1 &&
        ownOrders(finalTable.orders || []).length === 1 &&
        ownOrders(finalTable.orders || [])[0]?.id === own.orderId;
      report.checks.bill_unchanged = current.subtotal === committed.subtotal &&
        current.current_version === committed.current_version &&
        current.table_session_id === committed.table_session_id;
      report.checks.no_extra_ticket = firstQueue.filter(row => row.order_id === own.orderId)
        .length === tickets.length;
      report.checks.no_extra_audit = JSON.stringify(ownAudit) === JSON.stringify(firstAudit);
      report.checks.ledger_unchanged = JSON.stringify(finalLedger) ===
        JSON.stringify(firstLedger);
      report.checks.retry_reconciled = writes.length >= 2 &&
        firstItems[0]?.id === qrItems[0]?.id &&
        current.items.length === committed.items.length;
      report.order_id = own.orderId; report.qr_item_id = own.itemId;
      report.queue_count_for_item = tickets.length;
      report.qr_add_audit_count = qrAdds.length;
      report.qr_send_audit_count = qrSends.length;
      report.ui_writes = Array.from({ length: writes.length }, () =>
        'POST /api/v1/public/qr/<TOKEN>/orders');
      report.first_server_http = firstServerStatus;
      report.same_idempotency_key = writes.length >= 2 &&
        writes.every(key => !!key && key === writes[0]);
      report.checks.same_idempotency_key = report.same_idempotency_key;
      report.ui_request_count = writes.length;
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('P2-QR-014 retry mismatch: ' +
          JSON.stringify(report.checks));
      report.business_execution = 'EXECUTED';
    } catch (error) {
      failure = error;
      if (report.network_probe?.route_hits === 0) {
        const button = page.getByRole('button', { name: 'Gửi món vào bếp' });
        const safeText = async (locator: any) =>
          (await locator.first().textContent({ timeout: 1_000 }).catch(() => null))
            ?.trim().slice(0, 300) ?? null;
        report.diagnostics = {
          page_path: (() => {
            try { return new URL(page.url()).pathname.replace(/\/qr\/[^/]+/,
              '/qr/<TOKEN>'); } catch { return '<INVALID_URL>'; }
          })(),
          submit_visible: await button.isVisible().catch(() => false),
          submit_enabled: await button.isEnabled().catch(() => false),
          status_text: await safeText(page.getByRole('status')),
          cart_text: await safeText(page.getByTestId('qr-cart')),
          placed_text: await safeText(page.getByTestId('qr-placed')),
          owned_order_items: await order().then((row: any) =>
            row.items?.length ?? null).catch(() => null),
        };
        await testInfo.attach('P2_QR_014_failure_screen', {
          body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
        }).catch(() => {});
      }
    }
    await context.close().catch(() => {});
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ||
        (report.network_probe && report.network_probe.first_server_http !== 201) ?
        'INCONCLUSIVE' : redact(failure).includes('PENDING_FIXTURE') ?
        'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `P2_QR_014_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('P2_QR_014_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[P2-QR-014] Evidence: .\\evidence\\${name}`);
    console.log('[P2-QR-014] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
