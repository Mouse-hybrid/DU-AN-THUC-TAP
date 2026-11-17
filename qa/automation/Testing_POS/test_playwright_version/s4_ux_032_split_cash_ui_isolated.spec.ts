import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-032 | CASHIER pays child bill then source bill in UI',
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
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX032`,
      test_ref: 'S4-UX-032', checked_at: new Date().toISOString(),
      scope: 'QA3 UI CASH payment of child then source bill, same session; two ledgers, table lifecycle, audit and owned cleanup; no fee/tax or gateway',
      case_coverage: 'TWO_CASH_BILLS_NO_DISCOUNT_FEE',
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
            note: 'S4-UX-032 owned cleanup' }],
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
    async function openBill(id: string) {
      const paymentPath = `/api/v1/orders/${id}/payments`;
      const candidates = [
        `/tables/${own.tableId}/summary?order_id=${id}`,
        `/tables/${own.tableId}/summary?orderId=${id}`,
      ];
      for (const path of candidates) {
        reads.length = 0;
        await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(700);
        if (reads.includes(paymentPath) &&
            !reads.some(read => read.endsWith('/payments') && read !== paymentPath)) {
          await expect(page.getByRole('button',
            { name: 'Ghi nhận thanh toán', exact: true })).toBeVisible();
          return path;
        }
      }
      await page.goto(`/tables/${own.tableId}`,
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const links = await page.locator('a[href]').evaluateAll(rows => rows.map(row => ({
        text: row.textContent?.trim().slice(0, 100), href: row.getAttribute('href'),
      })).filter(row => row.href?.startsWith('/tables/') &&
        !row.href.includes('?')).slice(0, 20));
      report.bill_navigation = { id, candidates, links, payment_reads: reads
        .filter(path => path.endsWith('/payments')) };
      throw new Error('PENDING_UI_SELECTOR: cannot prove selected UI bill ' + id);
    }
    async function payOnUI(id: string, label: string) {
      const route = await openBill(id);
      await testInfo.attach(`S4_UX_032_${label}_before`, {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const [response] = await Promise.all([
        page.waitForResponse(row => row.request().method() === 'POST' &&
          new URL(row.url()).pathname === `/api/v1/orders/${id}/payments`,
          { timeout: 20_000 }),
        page.getByRole('button', { name: 'Ghi nhận thanh toán', exact: true }).click(),
      ]);
      report[`${label}_ui_route`] = route;
      report[`${label}_http`] = response.status();
      expect(response.status()).toBe(201);
      const payment = (await response.json()).payment;
      expect(payment?.order_id).toBe(id);
      expect(payment?.method).toBe('CASH');
      expect(payment?.status).toBe('SUCCEEDED');
      expect(Number(payment?.amount)).toBe(50_000);
      expect(Number(payment?.cash_received)).toBe(50_000);
      expect(Number(payment?.change_due)).toBe(0);
      const afterLedger = await ledger(id);
      expect(afterLedger.payments?.map((row: any) => row.id)).toEqual([payment.id]);
      expect(Number(afterLedger.summary?.remaining)).toBe(0);
      const paid = await audit(id, 'ORDER_PAID') as any[];
      const recorded = await audit(id, 'PAYMENT_RECORDED') as any[];
      expect(paid.filter(row => row.action === 'ORDER_PAID' && row.entity_id === id))
        .toHaveLength(1);
      expect(recorded.filter(row => row.action === 'PAYMENT_RECORDED' &&
        row.entity_id === id && row.payload?.payment_id === payment.id))
        .toHaveLength(1);
      await testInfo.attach(`S4_UX_032_${label}_paid`, {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      return payment.id as string;
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
            { menu_item_id: own.menuId, quantity: 1, note: 'S4-UX-032 source' },
            { menu_item_id: own.menuId, quantity: 1, note: 'S4-UX-032 child' },
          ],
        });
      own.itemIds = added.items.filter((row: any) =>
        ['S4-UX-032 source', 'S4-UX-032 child'].includes(row.note))
        .map((row: any) => row.id);
      expect(own.itemIds).toHaveLength(2);
      const moving = added.items.find((row: any) => row.note === 'S4-UX-032 child');
      expect(moving?.id).toBeTruthy();
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
        { items: [{ order_item_id: moving.id, quantity: 1 }] });
      own.childId = split.new_order?.id;
      await discoverOrders();
      expect(own.childId).toBeTruthy();
      for (const id of [own.childId!, own.sourceId!]) {
        const current = await order(id);
        expect(current.table_session_id).toBe(own.sessionId);
        expect(current.items).toHaveLength(1);
        expect(Number(current.amount_due)).toBe(50_000);
        if (current.status !== 'BILLING')
          await checked('POST', `/api/v1/orders/${id}/request-billing`,
            'waiter', 200);
        expect((await ledger(id)).payments).toHaveLength(0);
      }
      report.table_code = 'Q3-1';
      report.source_order_id = own.sourceId;
      report.child_order_id = own.childId;
      console.log(`[S4-UX-032] Own fixture: Q3-1 source ${own.sourceId}, child ${own.childId}`);
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_cashier');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const childPaymentId = await payOnUI(own.childId!, 'child');
      const child = await order(own.childId!);
      const sourceBill = await order(own.sourceId!);
      const afterFirst = await table();
      report.after_first = {
        child_paid: child.status === 'PAID', source_unpaid: sourceBill.status === 'BILLING',
        table_not_released: !!afterFirst.current_session &&
          afterFirst.current_session.id === own.sessionId &&
          afterFirst.status !== 'CLEANING',
      };
      expect(Object.values(report.after_first).every(Boolean),
        JSON.stringify(report.after_first)).toBe(true);
      const sourcePaymentId = await payOnUI(own.sourceId!, 'source');
      const afterBoth = await table();
      report.checks = {
        two_ui_payment_writes: uiWrites.length === 2 &&
          uiWrites[0] === `POST /api/v1/orders/${own.childId}/payments` &&
          uiWrites[1] === `POST /api/v1/orders/${own.sourceId}/payments`,
        distinct_payments: childPaymentId !== sourcePaymentId,
        child_paid_first: report.after_first.child_paid &&
          report.after_first.source_unpaid && report.after_first.table_not_released,
        both_paid: (await order(own.childId!)).status === 'PAID' &&
          (await order(own.sourceId!)).status === 'PAID',
        table_cleaning_after_both: afterBoth.status === 'CLEANING' &&
          !afterBoth.current_session,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Two-bill UI mismatch: ' + JSON.stringify(report.checks));
      report.payment_ids = [childPaymentId, sourcePaymentId];
    } catch (error) { failure = error; }
    try { await cleanup(); } catch (error) { cleanupError = error; }
    await context.close().catch(() => {});
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = uiWrites.length === 2 ? 'EXECUTED' :
      uiWrites.length ? 'PARTIAL' : 'NOT_EXECUTED';
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_UI_SELECTOR') ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `S4_UX_032_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_032_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-032] Evidence: .\\evidence\\${name}`);
    console.log('[S4-UX-032] Result: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
