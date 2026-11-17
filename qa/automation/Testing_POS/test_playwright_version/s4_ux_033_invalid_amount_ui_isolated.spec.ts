import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test('S4-UX-033 | CASHIER sees validation for zero CASH amount',
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
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX033`,
      test_ref: 'S4-UX-033', checked_at: new Date().toISOString(),
      scope: 'QA3 desktop CASHIER enters zero CASH amount on owned 50,000 VND bill; UI/server rejection, unchanged bill, ledger and audit, owned cleanup; unknown method not entered',
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
      const ownPaid = t.status === 'CLEANING' && !t.current_session &&
        own.orderId && ['PAID', 'CLOSED'].includes((await order()).status);
      if (!ownPaid && t.current_session?.id !== own.sessionId)
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
            note: 'S4-UX-033 owned cleanup' }] });
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
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      const active = await checked('GET', '/api/v1/kitchen/queue',
        'kitchen', 200) as any[];
      report.cleanup_state = {
        table_available: finalTable.status === 'AVAILABLE' && !finalTable.current_session,
        order_closed: finalOrder.status === 'CLOSED',
        items_served: finalOrder.items.every((item: any) => item.status === 'SERVED'),
        ticket_done: done.some(item => item.order_id === own.orderId),
        no_active_ticket: !active.some(item => item.order_id === own.orderId),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final QA3 table/order mismatch');
      report.cleanup_pass = true;
    }

    const contexts = [] as Array<Awaited<ReturnType<typeof browser.newContext>>>;
    async function login(role: 'cashier') {
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
    try {
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${own.tableId}/open-session`, 'waiter', 201,
        { guest_count: 1 })).id;
      expect(own.sessionId).toBeTruthy();
      own.orderId = (await checked('POST', '/api/v1/orders', 'waiter', 201,
        { table_session_id: own.sessionId })).id;
      const added = await checked('POST', `/api/v1/orders/${own.orderId}/items`,
        'waiter', 201, { items: [{ menu_item_id: own.menuId, quantity: 1,
          note: 'S4-UX-033 own' }] });
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
      console.log(`[S4-UX-033] Own fixture: Q3-1 order ${own.orderId}`);
      const cashier = await login('cashier');
      watch(cashier);
      const [allowed] = await Promise.all([
        cashier.waitForResponse(response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname ===
            `/api/v1/orders/${own.orderId}/payments`, { timeout: 15_000 }),
        cashier.goto(`/tables/${own.tableId}/summary`,
          { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      ]);
      await expect(cashier.getByText('Không thể tải thanh toán')).toHaveCount(0);
      expect(allowed.status()).toBe(200);
      await testInfo.attach('S4_UX_033_before_payment', {
        body: await cashier.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const amount = cashier.getByLabel(/Số tiền thu/i);
      if (await amount.count() !== 1) {
        report.input_controls = await cashier.locator('input').evaluateAll(rows =>
          rows.map(row => ({
            type: row.getAttribute('type'),
            placeholder: row.getAttribute('placeholder'),
            label: row.getAttribute('aria-label'),
          })));
        throw new Error('PENDING_UI_SELECTOR: zero amount field not identified');
      }
      const tableBefore = await table();
      const paymentPath = `/api/v1/orders/${own.orderId}/payments`;
      const paidBefore = await checked('GET',
        `/api/v1/audit-logs?action=ORDER_PAID&entity_id=${own.orderId}`,
        'admin', 200) as any[];
      const paymentBefore = await checked('GET',
        `/api/v1/audit-logs?action=PAYMENT_RECORDED&entity_id=${own.orderId}`,
        'admin', 200) as any[];
      expect(paidBefore.filter(row => row.action === 'ORDER_PAID' &&
        row.entity_id === own.orderId)).toHaveLength(0);
      expect(paymentBefore.filter(row => row.action === 'PAYMENT_RECORDED' &&
        row.entity_id === own.orderId)).toHaveLength(0);
      await amount.fill('0');
      await expect(amount).toHaveValue('0');
      uiObserved = true;
      const submit = cashier.getByRole('button',
        { name: 'Ghi nhận thanh toán', exact: true });
      await expect(submit).toBeVisible();
      const disabled = await submit.isDisabled();
      let rejectedResponse: Awaited<ReturnType<typeof cashier.waitForResponse>> | null = null;
      if (!disabled) {
        const response = cashier.waitForResponse(row =>
          row.request().method() === 'POST' &&
          new URL(row.url()).pathname === paymentPath,
          { timeout: 5_000 }).catch(() => null);
        await submit.click();
        rejectedResponse = await response;
      }
      report.http = { cashier_get: allowed.status(),
        payment_post: rejectedResponse?.status() ?? null };
      report.ui_action = disabled ? 'BUTTON_DISABLED' : 'CLICK_ZERO_AMOUNT';
      const validity = await amount.evaluate(row => {
        const input = row as HTMLInputElement;
        return { valid: input.validity.valid,
          message_present: !!input.validationMessage,
          aria_invalid: input.getAttribute('aria-invalid') === 'true' };
      });
      const feedback = await cashier.locator(
        '[role="alert"], [role="status"], [aria-live="polite"], .nova-field-error, .nova-error')
        .allTextContents();
      report.validation = {
        button_disabled: disabled, native_invalid: !validity.valid,
        native_message: validity.message_present, aria_invalid: validity.aria_invalid,
        visible_feedback: feedback.some(text =>
          /số tiền|không hợp lệ|phải lớn|thanh toán|lỗi/i.test(text)),
      };
      const billAfter = await order();
      const ledgerAfter = await ledger();
      const tableAfter = await table();
      const paidAfter = await checked('GET',
        `/api/v1/audit-logs?action=ORDER_PAID&entity_id=${own.orderId}`,
        'admin', 200) as any[];
      const paymentAfter = await checked('GET',
        `/api/v1/audit-logs?action=PAYMENT_RECORDED&entity_id=${own.orderId}`,
        'admin', 200) as any[];
      report.checks = {
        zero_rejected: disabled ||
          (rejectedResponse === null && uiWrites.length === 0) ||
          rejectedResponse?.status() === 422,
        no_successful_payment_write: uiWrites.every(write =>
          write === `POST ${paymentPath}`) && uiWrites.length <= 1 &&
          rejectedResponse?.status() !== 201,
        bill_unchanged: billAfter.status === billBefore.status &&
          Number(billAfter.amount_due) === Number(billBefore.amount_due),
        ledger_unchanged: ledgerAfter.payments?.length === ledgerBefore.payments.length &&
          Number(ledgerAfter.summary?.remaining) ===
            Number(ledgerBefore.summary?.remaining),
        table_unchanged: tableAfter.status === tableBefore.status &&
          tableAfter.current_session?.id === own.sessionId,
        audit_unchanged: paidAfter.filter(row => row.action === 'ORDER_PAID' &&
          row.entity_id === own.orderId).length === 0 &&
          paymentAfter.filter(row => row.action === 'PAYMENT_RECORDED' &&
            row.entity_id === own.orderId).length === 0,
        validation_cue: !validity.valid || validity.aria_invalid ||
          report.validation.visible_feedback,
      };
      await testInfo.attach('S4_UX_033_zero_amount_result', {
        body: await cashier.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      if (!Object.values(report.checks).every(Boolean))
        throw new Error(`Zero amount UI/ledger/audit mismatch: ${JSON.stringify(report.checks)}`);
    } catch (error) { failure = error; }
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
    const evidenceName = `S4_UX_033_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', evidenceName), evidence);
    await testInfo.attach('S4_UX_033_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-033] Evidence: .\\evidence\\${evidenceName}`);
    console.log('[S4-UX-033] Result: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
