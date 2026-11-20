import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test('S4-UX-041 | payment panel recovers from one failed read without duplicate write',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(150_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base, 'QA3 staging only').toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and the full pinned POS_EXPECTED_COMMIT are required');

    const tokens: Record<string, string> = {};
    const own: { tableId?: string; sessionId?: string; orderId?: string;
      itemId?: string; menuId?: string } = {};
    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX041`,
      test_ref: 'S4-UX-041', checked_at: new Date().toISOString(),
      scope: 'QA3 CASHIER payment panel: first GET held, both automatic attempts fail, loading and error appear, one manual Retry GET recovers the owned unpaid bill; no UI POST, false PAID, or ledger change; owned cleanup. KDS and other screens excluded.',
      project: testInfo.project.name, secrets_recorded: false,
      checks: {}, ui_writes: [], cleanup_pass: false,
    };
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, ...Object.values(tokens)])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      return value;
    };
    async function call(method: 'GET' | 'POST', path: string, role: string,
      data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: {
          Authorization: `Bearer ${tokens[role]}`,
          ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
        }, ...(data !== undefined ? { data } : {}), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST', path: string, role: string,
      http: number, data?: object): Promise<any> {
      const result = await call(method, path, role, data);
      expect(result.http, `${method} ${path} HTTP`).toBe(http);
      return result.body;
    }
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`,
      'cashier', 200);
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`,
      'waiter', 200);
    const ledger = () => checked('GET', `/api/v1/orders/${own.orderId}/payments`,
      'cashier', 200);
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const before = await build();
    test.skip(before !== expected,
      `PENDING_BUILD: staging ${before} differs from pinned ${expected}`);
    report.staging_commit = before;
    const contract = await request.get(base + '/openapi.json', { timeout: 20_000 });
    expect(contract.status()).toBe(200);
    const spec = await contract.json();
    expect(spec.paths?.['/api/v1/orders/{order_id}/payments']?.get).toBeTruthy();
    for (const [role, expectedRole] of [
      ['waiter', 'WAITER'], ['cashier', 'CASHIER'], ['kitchen', 'KITCHEN'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username: `qa3_${role}`, password: pin }, timeout: 20_000,
      });
      expect(response.status(), `QA3 ${role} login`).toBe(200);
      const body = await response.json();
      expect(body.staff?.role, `QA3 ${role} role`).toBe(expectedRole);
      tokens[role] = body.access_token;
      expect(tokens[role]).toBeTruthy();
    }
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
    const source = tables.find(row => row.code === 'Q3-1');
    test.skip(!source || source.status !== 'AVAILABLE',
      'PENDING_FIXTURE: Q3-1 must be AVAILABLE before any write');
    own.tableId = source.id;
    const menu = await checked('GET', '/api/v1/menu?available_only=true',
      'waiter', 200) as any[];
    const starter = menu.find(row => row.is_available && row.station_id &&
      !row.has_modifiers && Number(row.price) === 50_000);
    test.skip(!starter, 'PENDING_FIXTURE: mapped 50,000 VND item required');
    own.menuId = starter.id;

    async function cleanup() {
      if (!own.sessionId) return;
      const t = await table();
      if (t.current_session?.id !== own.sessionId)
        throw new Error(`CLEANUP REQUIRED: Q3-1 session changed from ${own.sessionId}`);
      if (!own.orderId) {
        const matches = (t.orders || []).filter((row: any) =>
          row.table_session_id === own.sessionId);
        if (matches.length > 1) throw new Error('CLEANUP REQUIRED: ambiguous owned order');
        own.orderId = matches[0]?.id || (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
      }
      let current = await order();
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (!current.items.length) {
        await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'waiter', 201,
          { items: [{ menu_item_id: own.menuId, quantity: 1,
            note: 'S4-UX-041 owned cleanup' }] });
        current = await order();
      }
      if (current.status === 'NEW')
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
            await checked('POST',
              `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`, role, 200);
        }
      }
      current = await order();
      if (current.items.some((item: any) => item.status !== 'SERVED'))
        throw new Error('CLEANUP REQUIRED: owned item not served');
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
          'waiter', 200);
      if ((await order()).status === 'BILLING')
        await checked('POST', `/api/v1/orders/${own.orderId}/pay`, 'cashier', 200);
      if ((await order()).status === 'PAID')
        await checked('POST', `/api/v1/orders/${own.orderId}/close`, 'cashier', 200);
      if ((await table()).status === 'CLEANING')
        await checked('POST', `/api/v1/tables/${own.tableId}/mark-clean`,
          'waiter', 200);
      const finalTable = await table();
      const finalOrder = await order();
      report.cleanup_state = {
        table_available: finalTable.status === 'AVAILABLE' && !finalTable.current_session,
        order_closed: finalOrder.status === 'CLOSED',
        items_served: finalOrder.items.every((item: any) => item.status === 'SERVED'),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final QA3 table/order mismatch');
      report.cleanup_pass = true;
    }

    const contexts = [] as Array<Awaited<ReturnType<typeof browser.newContext>>>;
    async function login(role: 'waiter' | 'cashier') {
      const context = await browser.newContext({ baseURL: base });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill(`qa3_${role}`);
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      return page;
    }
    const uiWrites: string[] = report.ui_writes;
    function watch(page: Page) {
      page.on('request', req => {
        const path = new URL(req.url()).pathname;
        if (path.startsWith('/api/v1/') &&
            !['GET', 'HEAD'].includes(req.method()) &&
            path !== '/api/v1/auth/login')
          uiWrites.push(`${req.method()} ${path}`);
      });
    }

    let failure: unknown, cleanupError: unknown, uiObserved = false;
    let releaseFirstRead: () => void = () => {};
    try {
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${own.tableId}/open-session`, 'waiter', 201,
        { guest_count: 1 })).id;
      expect(own.sessionId).toBeTruthy();
      own.orderId = (await checked('POST', '/api/v1/orders', 'waiter', 201,
        { table_session_id: own.sessionId })).id;
      const added = await checked('POST', `/api/v1/orders/${own.orderId}/items`,
        'waiter', 201, { items: [{ menu_item_id: own.menuId, quantity: 1,
          note: 'S4-UX-041 own' }] });
      own.itemId = added.items.find((item: any) => item.menu_item_id === own.menuId)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
        'waiter', 200);
      for (const [action, role] of [
        ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
        ['pickup', 'waiter'], ['served', 'waiter'],
      ] as const)
        await checked('POST',
          `/api/v1/orders/${own.orderId}/items/${own.itemId}/${action}`, role, 200);
      await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
        'waiter', 200);
      const billBefore = await order();
      const ledgerBefore = await ledger();
      expect(billBefore.status).toBe('BILLING');
      expect(Number(billBefore.amount_due)).toBe(50_000);
      expect(ledgerBefore.payments).toHaveLength(0);
      report.order_id = own.orderId;
      report.table_code = 'Q3-1';
      console.log(`[S4-UX-041] Own fixture: Q3-1 order ${own.orderId}`);
      uiObserved = true;

      const cashier = await login('cashier');
      watch(cashier);
      const paymentPath = `/api/v1/orders/${own.orderId}/payments`;
      const gate = new Promise<void>(resolve => { releaseFirstRead = resolve; });
      const browserReads: string[] = [];
      await cashier.route(`**${paymentPath}`, async route => {
        if (new URL(route.request().url()).pathname !== paymentPath ||
            route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        browserReads.push('GET ' + paymentPath);
        if (browserReads.length <= 2) {
          if (browserReads.length === 1) await gate;
          await route.abort('failed');
        } else await route.continue();
      });
      await cashier.goto(`/tables/${own.tableId}/summary`,
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect.poll(() => browserReads.length, { timeout: 15_000 }).toBe(1);
      await expect(cashier.getByText('Đang tải thanh toán', { exact: true }))
        .toBeVisible({ timeout: 10_000 });
      report.checks.loading_visible = true;
      await testInfo.attach('S4_UX_041_loading', {
        body: await cashier.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      releaseFirstRead();
      await expect.poll(() => browserReads.length, { timeout: 10_000 }).toBe(2);
      report.automatic_get_attempts = browserReads.length;
      await expect(cashier.getByText('Không thể tải thanh toán', { exact: true }))
        .toBeVisible({ timeout: 10_000 });
      const retry = cashier.getByRole('button', { name: 'Thử lại', exact: true });
      await expect(retry).toBeVisible();
      report.checks.error_with_retry = true;
      await testInfo.attach('S4_UX_041_error', {
        body: await cashier.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const [retried] = await Promise.all([
        cashier.waitForResponse(response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === paymentPath,
        { timeout: 15_000 }),
        retry.click(),
      ]);
      await expect(cashier.getByText('Không thể tải thanh toán', { exact: true }))
        .toHaveCount(0, { timeout: 10_000 });
      await expect(cashier.getByRole('button', { name: 'Ghi nhận thanh toán' }))
        .toBeVisible({ timeout: 10_000 });
      report.browser_payment_reads = browserReads.length;
      report.retry_http = retried.status();
      await testInfo.attach('S4_UX_041_recovered', {
        body: await cashier.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const billAfter = await order();
      const ledgerAfter = await ledger();
      report.checks.two_failed_auto_gets_one_manual_retry =
        browserReads.length === 3 &&
        retried.status() === 200;
      report.checks.bill_unpaid = billAfter.status === 'BILLING' &&
        Number(billAfter.amount_due) === Number(billBefore.amount_due) &&
        await cashier.getByText('Đã thanh toán', { exact: true }).count() === 0;
      report.checks.ledger_unchanged = JSON.stringify(ledgerAfter) ===
        JSON.stringify(ledgerBefore);
      report.checks.no_ui_business_write = uiWrites.length === 0;
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Payment read recovery mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    releaseFirstRead();
    try { await cleanup(); }
    catch (error) { cleanupError = error; }
    for (const context of contexts) await context.close().catch(() => {});
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = uiObserved ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_UI_SELECTOR') ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const evidenceName = `S4_UX_041_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', evidenceName), evidence);
    await testInfo.attach('S4_UX_041_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-041] Evidence: .\\evidence\\${evidenceName}`);
    console.log('[S4-UX-041] Result: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
