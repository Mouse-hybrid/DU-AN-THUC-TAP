import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-017 | UI denies splitting an already paid child bill',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(240_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base, 'QA3 staging only').toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full pinned POS_EXPECTED_COMMIT required');
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; sessionId?: string; sourceId?: string;
      childId?: string; menuId?: string; itemIds?: string[] } = {};
    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX017`,
      test_ref: 'S4-UX-017', checked_at: new Date().toISOString(),
      scope: 'QA3 owned two-bill session: child paid CASH while source remains BILLING; desktop UI guards second split of paid child; bill, ledger, audit, tickets and cleanup; no gateway',
      case_coverage: 'PAID_CHILD_UI_SPLIT_DENIAL',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], checks: {}, cleanup_pass: false,
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
      const response = await call(method, path, role, data);
      expect(response.http, `${method} ${path} HTTP`).toBe(http);
      return response.body;
    }
    const order = (id: string) => checked('GET', `/api/v1/orders/${id}`, 'cashier', 200);
    const ledger = (id: string) => checked('GET',
      `/api/v1/orders/${id}/payments`, 'cashier', 200);
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`, 'waiter', 200);
    const audit = (id: string, action: string) => checked('GET',
      `/api/v1/audit-logs?action=${action}&entity_id=${id}`, 'admin', 200);
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
    expect(spec.paths?.['/api/v1/orders/{order_id}/split']?.post).toBeTruthy();
    expect(spec.paths?.['/api/v1/orders/{order_id}/payments']?.post).toBeTruthy();
    for (const [role, expectedRole] of [
      ['waiter', 'WAITER'], ['cashier', 'CASHIER'], ['kitchen', 'KITCHEN'],
      ['admin', 'SUPERVISOR'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username: `qa3_${role}`, password: pin }, timeout: 20_000,
      });
      expect(response.status(), `QA3 ${role} login`).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
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

    async function discoverOrders() {
      const t = await table();
      const ids = [...new Set((t.orders || [])
        .filter((row: any) => row.table_session_id === own.sessionId)
        .map((row: any) => row.id))] as string[];
      if (ids.length > 2 || ids.some(id => id !== own.sourceId && own.childId && id !== own.childId))
        throw new Error('CLEANUP REQUIRED: unexpected order in owned session');
      if (!own.sourceId && ids.length === 1) own.sourceId = ids[0];
      const child = ids.find(id => id !== own.sourceId);
      if (child) own.childId = child;
      return t;
    }
    async function finish(id: string) {
      let current = await order(id);
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session ownership mismatch');
      if (current.status === 'CLOSED') return;
      if (!current.items.length && current.status === 'NEW') {
        await checked('POST', `/api/v1/orders/${id}/items`, 'waiter', 201, {
          items: [{ menu_item_id: own.menuId, quantity: 1,
            note: 'S4-UX-017 owned cleanup' }],
        });
        current = await order(id);
      }
      if (current.items.some((item: any) => item.status === 'CREATED'))
        await checked('POST', `/api/v1/orders/${id}/send-to-kitchen`,
          'waiter', 200);
      for (const item of (await order(id)).items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'],
          ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'],
          ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order(id)).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', `/api/v1/orders/${id}/items/${item.id}/${action}`,
              role, 200);
        }
      }
      current = await order(id);
      if (current.items.some((item: any) => item.status !== 'SERVED'))
        throw new Error('CLEANUP REQUIRED: item not served');
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${id}/request-billing`, 'waiter', 200);
      if ((await order(id)).status === 'BILLING')
        await checked('POST', `/api/v1/orders/${id}/pay`, 'cashier', 200);
      if ((await order(id)).status === 'PAID')
        await checked('POST', `/api/v1/orders/${id}/close`, 'cashier', 200);
    }
    async function cleanup() {
      if (!own.sessionId) return;
      const t = await discoverOrders();
      if (t.current_session?.id !== own.sessionId &&
          !(t.status === 'CLEANING' && !t.current_session))
        throw new Error('CLEANUP REQUIRED: Q3-1 session ownership changed');
      if (!own.sourceId) {
        own.sourceId = (await checked('POST', '/api/v1/orders', 'waiter', 201,
          { table_session_id: own.sessionId })).id;
      }
      await discoverOrders();
      for (const id of [own.childId, own.sourceId].filter(Boolean) as string[])
        await finish(id);
      if ((await table()).status === 'CLEANING')
        await checked('POST', `/api/v1/tables/${own.tableId}/mark-clean`,
          'waiter', 200);
      const finalTable = await table();
      const ids = [own.childId, own.sourceId].filter(Boolean) as string[];
      const finalOrders = await Promise.all(ids.map(id => order(id)));
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      const active = await checked('GET', '/api/v1/kitchen/queue',
        'kitchen', 200) as any[];
      report.cleanup_state = {
        table_available: finalTable.status === 'AVAILABLE' && !finalTable.current_session,
        orders_closed: finalOrders.every(row => row.status === 'CLOSED'),
        items_served: finalOrders.every(row =>
          row.items.every((item: any) => item.status === 'SERVED')),
        tickets_done: finalOrders.flatMap(row => row.items).every((item: any) =>
          done.some(ticket => ticket.order_item_id === item.id)),
        no_active_ticket: !active.some(ticket => ids.includes(ticket.order_id)),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final QA3 fixture mismatch');
      report.cleanup_pass = true;
    }

    const context = await browser.newContext({ baseURL: base });
    const page = await context.newPage();
    const uiWrites: string[] = report.ui_writes;
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        uiWrites.push(`${req.method()} ${path}`);
    });
    const reads: string[] = [];
    page.on('response', response => {
      if (response.request().method() === 'GET')
        reads.push(new URL(response.url()).pathname);
    });
    async function openPaidChild(id: string) {
      const paymentPath = `/api/v1/orders/${id}/payments`;
      const candidates = [
        `/tables/${own.tableId}/summary?order_id=${id}`,
        `/tables/${own.tableId}/summary?orderId=${id}`,
      ];
      for (const path of candidates) {
        reads.length = 0;
        await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        try {
          await expect(page.getByText('Đã thanh toán').first())
            .toBeVisible({ timeout: 5_000 });
        } catch { continue; }
        if (reads.includes(paymentPath) &&
            !reads.some(read => read.endsWith('/payments') && read !== paymentPath)) {
          return path;
        }
      }
      report.bill_navigation = {
        id, pathname: new URL(page.url()).pathname,
        headings: await page.locator('h1,h2,h3').allTextContents(),
        buttons: (await page.locator('button').allTextContents())
          .map(value => value.trim()).filter(Boolean).slice(0, 30),
        payment_reads: reads.filter(path => path.endsWith('/payments')),
      };
      throw new Error('PENDING_UI_SELECTOR: paid child summary not selected');
    }
    async function attemptSplit(id: string) {
      report.child_ui_route = await openPaidChild(id);
      await testInfo.attach('S4_UX_017_paid_child_before', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const open = page.getByRole('button', { name: 'Tách bill', exact: true });
      if (!await open.count() || !await open.isVisible())
        return { guard: 'hidden' };
      if (!await open.isEnabled()) return { guard: 'disabled' };
      await open.click({ timeout: 10_000 });
      const dialog = page.getByRole('dialog', { name: 'Tách bill' });
      if (!await dialog.isVisible() &&
          await page.getByText(/không thể tách|bill đã thanh toán/i).count())
        return { guard: 'client_denial' };
      if (!await dialog.isVisible())
        throw new Error('PENDING_UI_SELECTOR: enabled split button had no dialog');
      await expect(dialog.getByTestId('split-row')).toHaveCount(2);
      const first = dialog.getByTestId('split-row').first();
      await expect(first.locator('button')).toHaveCount(2);
      await first.locator('button').nth(1).click();
      const submit = dialog.getByRole('button', { name: 'Tách bill', exact: true });
      await expect(submit).toBeEnabled();
      const [response] = await Promise.all([
        page.waitForResponse(row => row.request().method() === 'POST' &&
          new URL(row.url()).pathname === `/api/v1/orders/${id}/split`,
          { timeout: 20_000 }),
        submit.click(),
      ]);
      report.ui_split_http = response.status();
      expect(response.status()).toBe(409);
      await expect(page.getByText(/không thể|đã thanh toán|xung đột|lỗi/i).first())
        .toBeVisible({ timeout: 5_000 });
      return { guard: 'server', http: response.status() };
    }

    let failure: unknown, cleanupError: unknown;
    try {
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${own.tableId}/open-session`, 'waiter', 201,
        { guest_count: 2 })).id;
      own.sourceId = (await checked('POST', '/api/v1/orders', 'waiter', 201,
        { table_session_id: own.sessionId })).id;
      const added = await checked('POST',
        `/api/v1/orders/${own.sourceId}/items`, 'waiter', 201, {
          items: [
            { menu_item_id: own.menuId, quantity: 1, note: 'S4-UX-017 source' },
            { menu_item_id: own.menuId, quantity: 1, note: 'S4-UX-017 child A' },
            { menu_item_id: own.menuId, quantity: 1, note: 'S4-UX-017 child B' },
          ],
        });
      own.itemIds = added.items.filter((row: any) =>
        ['S4-UX-017 source', 'S4-UX-017 child A', 'S4-UX-017 child B']
          .includes(row.note))
        .map((row: any) => row.id);
      expect(own.itemIds).toHaveLength(3);
      const moving = added.items.filter((row: any) =>
        ['S4-UX-017 child A', 'S4-UX-017 child B'].includes(row.note));
      expect(moving).toHaveLength(2);
      await checked('POST', `/api/v1/orders/${own.sourceId}/send-to-kitchen`,
        'waiter', 200);
      for (const itemId of own.itemIds!)
        for (const [action, role] of [
          ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
          ['pickup', 'waiter'], ['served', 'waiter'],
        ] as const)
          await checked('POST',
            `/api/v1/orders/${own.sourceId}/items/${itemId}/${action}`,
            role, 200);
      const split = await checked('POST', `/api/v1/orders/${own.sourceId}/split`,
        'waiter', 201,
        { items: moving.map((row: any) =>
          ({ order_item_id: row.id, quantity: 1 })) });
      own.childId = split.new_order?.id;
      await discoverOrders();
      expect(own.childId).toBeTruthy();
      for (const id of [own.childId!, own.sourceId!]) {
        const current = await order(id);
        expect(current.table_session_id).toBe(own.sessionId);
        expect(current.items).toHaveLength(id === own.childId ? 2 : 1);
        expect(Number(current.amount_due)).toBe(id === own.childId ? 100_000 : 50_000);
        if (current.status !== 'BILLING')
          await checked('POST', `/api/v1/orders/${id}/request-billing`,
            'waiter', 200);
        expect((await ledger(id)).payments).toHaveLength(0);
      }
      report.table_code = 'Q3-1';
      report.source_order_id = own.sourceId;
      report.child_order_id = own.childId;
      console.log(`[S4-UX-017] Own fixture: Q3-1 source ${own.sourceId}, child ${own.childId}`);
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_cashier');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const payment = await checked('POST',
        `/api/v1/orders/${own.childId}/payments`, 'cashier', 201,
        { method: 'CASH', amount: '100000.00', cash_received: '100000.00' });
      report.payment_id = payment.payment?.id;
      expect(report.payment_id).toBeTruthy();
      const before = {
        child: await order(own.childId!), source: await order(own.sourceId!),
        childLedger: await ledger(own.childId!),
        sourceLedger: await ledger(own.sourceId!),
        splitAudit: await audit(own.sourceId!, 'ORDER_SPLIT'),
        paidAudit: await audit(own.childId!, 'ORDER_PAID'),
        table: await table(),
      };
      expect(before.child.status).toBe('PAID');
      expect(before.source.status).toBe('BILLING');
      expect(before.childLedger.payments).toHaveLength(1);
      expect(before.sourceLedger.payments).toHaveLength(0);
      expect(before.table.current_session?.id).toBe(own.sessionId);
      report.ui_guard = await attemptSplit(own.childId!);
      const after = {
        child: await order(own.childId!), source: await order(own.sourceId!),
        childLedger: await ledger(own.childId!),
        sourceLedger: await ledger(own.sourceId!),
        splitAudit: await audit(own.sourceId!, 'ORDER_SPLIT'),
        paidAudit: await audit(own.childId!, 'ORDER_PAID'),
        table: await table(),
      };
      const expectedWrite = `POST /api/v1/orders/${own.childId}/split`;
      report.checks = {
        paid_child_guarded: ['hidden', 'disabled', 'client_denial']
          .includes(report.ui_guard.guard) ||
          report.ui_guard.http === 409,
        no_successful_ui_split: report.ui_guard.guard === 'server' ?
          uiWrites.length === 1 && uiWrites[0] === expectedWrite :
          uiWrites.length === 0,
        child_unchanged: JSON.stringify(after.child) === JSON.stringify(before.child),
        source_unchanged: JSON.stringify(after.source) === JSON.stringify(before.source),
        child_ledger_unchanged: JSON.stringify(after.childLedger) ===
          JSON.stringify(before.childLedger),
        source_ledger_unchanged: JSON.stringify(after.sourceLedger) ===
          JSON.stringify(before.sourceLedger),
        split_audit_unchanged: JSON.stringify(after.splitAudit) ===
          JSON.stringify(before.splitAudit),
        paid_audit_unchanged: JSON.stringify(after.paidAudit) ===
          JSON.stringify(before.paidAudit),
        no_extra_bill: (after.table.orders || []).length ===
          (before.table.orders || []).length &&
          after.table.current_session?.id === own.sessionId,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Paid child split UI mismatch: ' + JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { await cleanup(); } catch (error) { cleanupError = error; }
    await context.close().catch(() => {});
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = report.ui_guard ? 'EXECUTED' :
      report.payment_id ? 'PARTIAL' : 'NOT_EXECUTED';
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_UI_SELECTOR') ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `S4_UX_017_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_017_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-017] Evidence: .\\evidence\\${name}`);
    console.log('[S4-UX-017] Result: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
