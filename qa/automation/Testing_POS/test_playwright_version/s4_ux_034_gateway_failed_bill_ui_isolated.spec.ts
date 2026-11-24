import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Sandbox card/OTP and signed URLs must not enter automatic video/trace artifacts.
test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('S4-UX-034 | failed VNPay callback keeps cashier bill unpaid',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(21 * 60_000);
    test.skip(testInfo.project.name !== 'chromium', 'Headed desktop Chromium only');
    test.skip(!process.env.P2_VNPAY_SANDBOX_INTERACTIVE,
      'Set P2_VNPAY_SANDBOX_INTERACTIVE=1 for manual sandbox card/OTP');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base, 'QA3 staging only').toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full pinned POS_EXPECTED_COMMIT required');
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; tableCode?: string; sessionId?: string;
      orderId?: string; itemId?: string; menuId?: string; paymentId?: string } = {};
    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX034`,
      test_ref: 'S4-UX-034', checked_at: new Date().toISOString(),
      scope: 'QA3 VNPay sandbox cancellation returns FAILED; CASHIER bill UI shows failure, retry control and pending state after API retry; no false PAID/duplicate ledger, owned cleanup. Requires headed manual sandbox cancellation.',
      case_coverage: 'VNPAY_FAILED_RETURN_CASHIER_UI; API_RETRY_ONLY; UI_RETRY_WRITE_AND_IPN_EXCLUDED',
      project: testInfo.project.name, secrets_recorded: false,
      card_recorded: false, signed_url_recorded: false,
      checks: {}, cleanup_pass: false, business_execution: 'NOT_EXECUTED',
    };
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, ...Object.values(tokens)])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      value = value.replace(/https?:\/\/[^\s"'<>]+vnp_SecureHash[^\s"'<>]*/gi,
        '<REDACTED_SIGNED_URL>');
      return value;
    };
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
    for (const [path, method] of [
      ['/api/v1/orders/{order_id}/payments', 'post'],
      ['/api/v1/orders/{order_id}/payments', 'get'],
      ['/api/v1/payments/vnpay/return', 'get'],
      ['/api/v1/payments/{payment_id}/cancel', 'post'],
    ] as const) expect(spec.paths?.[path]?.[method], `${method} ${path}`).toBeTruthy();
    for (const [role, username, expectedRole] of [
      ['waiter', 'qa3_waiter', 'WAITER'],
      ['cashier', 'qa3_cashier', 'CASHIER'],
      ['kitchen', 'qa3_kitchen', 'KITCHEN'],
      ['admin', 'qa3_admin', 'SUPERVISOR'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status(), `${username} login`).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
      tokens[role] = body.access_token;
      expect(tokens[role]).toBeTruthy();
      if (role === 'waiter') report.qa3_outlet_id = body.staff?.outlet_id;
      else expect(body.staff?.outlet_id).toBe(report.qa3_outlet_id);
    }
    async function call(method: 'GET' | 'POST', path: string, role: string,
      data?: object, key?: string) {
      const response = await request.fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${tokens[role]}`,
          ...(method === 'POST' ? { 'Idempotency-Key': key || randomUUID() } : {}) },
        ...(data !== undefined ? { data } : {}),
        timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST', path: string, role: string,
      http: number, data?: object) {
      const result = await call(method, path, role, data);
      expect(result.http, `${method} ${path}`).toBe(http);
      return result.body;
    }
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`,
      'cashier', 200);
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`,
      'waiter', 200);
    const ledger = () => checked('GET',
      `/api/v1/orders/${own.orderId}/payments`, 'cashier', 200);

    async function cleanup() {
      if (!own.sessionId) { report.cleanup_pass = true; return; }
      const t = await table();
      if (t.current_session?.id !== own.sessionId &&
          !(t.status === 'CLEANING' && own.orderId &&
            ['PAID', 'CLOSED'].includes((await order()).status)))
        throw new Error('CLEANUP REQUIRED: QA3 table/session ownership changed');
      if (!own.orderId) {
        const matches = (t.orders || []).filter((row: any) =>
          row.table_session_id === own.sessionId);
        if (matches.length > 1) throw new Error('CLEANUP REQUIRED: ambiguous order');
        own.orderId = matches[0]?.id || (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
      }
      let current = await order();
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (!current.items.length) {
        await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'waiter', 201,
          { items: [{ menu_item_id: own.menuId, quantity: 1,
            note: 'S4-UX-034 owned cleanup' }] });
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
              `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,
              role, 200);
        }
      }
      current = await order();
      if (current.items.some((item: any) => item.status !== 'SERVED'))
        throw new Error('CLEANUP REQUIRED: item not SERVED');
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
          'waiter', 200);
      if ((await order()).status === 'BILLING') {
        for (const payment of (await ledger()).payments || []) {
          if (['PENDING', 'UNKNOWN'].includes(payment.status)) {
            const cancelled = await call('POST',
              `/api/v1/payments/${payment.id}/cancel`, 'cashier',
              { reason: 'QA owned cleanup after incomplete sandbox run' });
            expect(cancelled.http, 'cancel own pending link').toBe(200);
          }
        }
        await checked('POST', `/api/v1/orders/${own.orderId}/pay`,
          'cashier', 200);
      }
      if ((await order()).status === 'PAID')
        await checked('POST', `/api/v1/orders/${own.orderId}/close`,
          'cashier', 200);
      if ((await table()).status === 'CLEANING')
        await checked('POST', `/api/v1/tables/${own.tableId}/mark-clean`,
          'waiter', 200);
      const finalOrder = await order(), finalTable = await table();
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      const active = await checked('GET', '/api/v1/kitchen/queue',
        'kitchen', 200) as any[];
      report.cleanup_state = {
        order_closed: finalOrder.status === 'CLOSED',
        table_available: finalTable.status === 'AVAILABLE' &&
          !finalTable.current_session,
        items_served: finalOrder.items.every((item: any) => item.status === 'SERVED'),
        ticket_done: done.some(row => row.order_id === own.orderId),
        no_active_ticket: !active.some(row => row.order_id === own.orderId),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final state mismatch');
      report.cleanup_pass = true;
    }

    let failure: unknown, cleanupError: unknown;
    const context = await browser.newContext({ baseURL: base });
    const page = await context.newPage();
    try {
      const tables = await checked('GET', '/api/v1/tables',
        'waiter', 200) as any[];
      const source = tables.find(row => row.code === 'Q3-1' &&
        row.status === 'AVAILABLE');
      if (!source) throw new Error('PENDING_FIXTURE: Q3-1 must be AVAILABLE');
      own.tableId = source.id; own.tableCode = source.code;
      const menu = await checked('GET', '/api/v1/menu?available_only=true',
        'waiter', 200) as any[];
      const starter = menu.find(row => row.is_available && row.station_id &&
        !row.has_modifiers && Number(row.price) === 50_000);
      if (!starter) throw new Error('PENDING_FIXTURE: mapped 50,000 VND item required');
      own.menuId = starter.id;
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${own.tableId}/open-session`, 'waiter', 201,
        { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders',
        'waiter', 201, { table_session_id: own.sessionId })).id;
      const added = await checked('POST',
        `/api/v1/orders/${own.orderId}/items`, 'waiter', 201,
        { items: [{ menu_item_id: own.menuId, quantity: 1,
          note: 'S4-UX-034 VNPay sandbox QA3 own' }] });
      own.itemId = added.items.find((item: any) =>
        item.menu_item_id === own.menuId)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
        'waiter', 200);
      for (const [action, role] of [
        ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
        ['pickup', 'waiter'], ['served', 'waiter'],
      ] as const) await checked('POST',
        `/api/v1/orders/${own.orderId}/items/${own.itemId}/${action}`,
        role, 200);
      await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
        'waiter', 200);
      const beforeOrder = await order(), beforeLedger = await ledger();
      const beforeTable = await table();
      expect(beforeOrder.status).toBe('BILLING');
      expect(Number(beforeOrder.amount_due)).toBe(50_000);
      expect(beforeLedger.payments).toHaveLength(0);
      report.table_code = own.tableCode; report.order_id = own.orderId;
      console.log(`[S4-UX-034] Owned Q3-1 order ${own.orderId}; opening VNPay sandbox`);
      const created = await call('POST',
        `/api/v1/orders/${own.orderId}/payments`, 'cashier',
        { method: 'VNPAY' });
      expect(created.http, 'create VNPay link').toBe(201);
      const payment = created.body?.payment;
      own.paymentId = payment?.id;
      report.payment_id = own.paymentId;
      report.link_http = created.http;
      report.link_expires_at = payment?.expires_at;
      expect(payment?.status).toBe('PENDING');
      expect(Number(created.body?.summary?.pending)).toBe(50_000);
      expect(new Date(payment?.expires_at).getTime()).toBeGreaterThan(Date.now());
      const paymentUrl = new URL(payment?.payment_url);
      expect(paymentUrl.hostname).toBe('sandbox.vnpayment.vn');
      report.business_execution = 'LINK_CREATED';
      console.log('[S4-UX-034] In the headed VNPay sandbox, choose Huy thanh toan and confirm cancellation; do not enter a card/OTP.');
      await page.goto(paymentUrl.toString(),
        { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForURL(url =>
        url.origin === base && url.pathname === '/api/v1/payments/vnpay/return',
        { timeout: 16 * 60_000, waitUntil: 'domcontentloaded' });
      const returnText = await page.locator('body').innerText();
      await testInfo.attach('S4_UX_034_failed_return', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const firstPaymentId = own.paymentId;
      const failedOrder = await order(), failedLedger = await ledger();
      const failedTable = await table();
      report.business_execution = 'EXECUTED';
      const firstPayment = failedLedger.payments?.find((row: any) =>
        row.id === firstPaymentId);
      report.return_failure_text = /Thanh toán chưa hoàn tất/i.test(returnText);
      report.failed_state = {
        payment_status: firstPayment?.status, order_status: failedOrder.status,
        amount_due: failedOrder.amount_due, paid: failedLedger.summary?.paid,
        pending: failedLedger.summary?.pending, table_status: failedTable.status,
      };
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_cashier');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const paymentPath = `/api/v1/orders/${own.orderId}/payments`;
      const [uiPaymentRead] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'GET' &&
          new URL(response.url()).pathname === paymentPath, { timeout: 15_000 }),
        page.goto(base + `/tables/${own.tableId}/summary`,
          { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      ]);
      const billText = await page.locator('body').innerText();
      const failedStatusVisible = /thất bại|FAILED|không thành công|chưa hoàn tất/i.test(billText);
      const retryControlVisible = await page.getByRole('button',
        { name: /^(Ghi nhận thanh toán|Thử lại|Thanh toán lại)/i }).count() > 0;
      report.ui = { payment_get_http: uiPaymentRead.status(),
        failed_status_visible: failedStatusVisible,
        retry_control_visible: retryControlVisible };
      await testInfo.attach('S4_UX_034_cashier_failed_bill', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const retried = await call('POST',
        `/api/v1/orders/${own.orderId}/payments`, 'cashier',
        { method: 'VNPAY' });
      expect(retried.http, 'new VNPay link after failure').toBe(201);
      const secondPayment = retried.body?.payment;
      expect(secondPayment?.id, 'retry payment ID').toBeTruthy();
      own.paymentId = secondPayment?.id;
      report.retry_payment_id = own.paymentId;
      report.retry_http = retried.http;
      report.retry_url_recorded = false;
      const retryLedger = await ledger();
      const [retryRead] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'GET' &&
          new URL(response.url()).pathname === paymentPath, { timeout: 15_000 }),
        page.reload({ waitUntil: 'domcontentloaded' }),
      ]);
      report.ui.retry_get_http = retryRead.status();
      report.ui.pending_status_visible = /đang chờ|chờ thanh toán|PENDING/i.test(
        await page.locator('body').innerText());
      await testInfo.attach('S4_UX_034_cashier_retry_pending', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const cancelled = await call('POST',
        `/api/v1/payments/${own.paymentId}/cancel`, 'cashier',
        { reason: 'QA S4-UX-034 customer changed payment method' });
      report.retry_cancel_http = cancelled.http;
      const finalLedger = await ledger(), finalOrder = await order();
      const audit = await checked('GET',
        `/api/v1/audit-logs?order_id=${own.orderId}&limit=100`,
        'admin', 200) as any[];
      const afterPayments = finalLedger.payments || [];
      report.after_cancel = {
        first_status: afterPayments.find((row: any) => row.id === firstPaymentId)?.status,
        retry_status: afterPayments.find((row: any) => row.id === own.paymentId)?.status,
        order_status: finalOrder.status, amount_due: finalOrder.amount_due,
        paid: finalLedger.summary?.paid, pending: finalLedger.summary?.pending,
      };
      report.audit_counts = {
        link_created: audit.filter(row => row.action === 'PAYMENT_LINK_CREATED').length,
        order_paid: audit.filter(row => row.action === 'ORDER_PAID').length,
      };
      report.checks = {
        cashier_ui_failed_and_retry_visible: report.ui.payment_get_http === 200 &&
          report.ui.failed_status_visible && report.ui.retry_control_visible &&
          report.ui.retry_get_http === 200 && report.ui.pending_status_visible,
        signed_return_failed: report.return_failure_text &&
          !returnText.includes(own.orderId!),
        original_failed_unpaid: firstPayment?.status === 'FAILED' &&
          failedOrder.status === 'BILLING' &&
          Number(failedOrder.amount_due) === 50_000 &&
          Number(failedLedger.summary?.paid) === 0 &&
          Number(failedLedger.summary?.pending) === 0 &&
          failedTable.status === beforeTable.status,
        distinct_retry_link: secondPayment?.status === 'PENDING' &&
          !!secondPayment?.id && secondPayment.id !== firstPaymentId &&
          Number(retried.body?.summary?.pending) === 50_000 &&
          retryLedger.payments?.length === 2,
        retry_cancelled: cancelled.http === 200 &&
          report.after_cancel.first_status === 'FAILED' &&
          report.after_cancel.retry_status === 'CANCELLED' &&
          finalOrder.status === 'BILLING' &&
          Number(finalOrder.amount_due) === 50_000 &&
          Number(finalLedger.summary?.paid) === 0 &&
          Number(finalLedger.summary?.pending) === 0,
        no_paid_audit: report.audit_counts.order_paid === 0 &&
          report.audit_counts.link_created === 2,
      };
      report.business_execution = 'EXECUTED';
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('VNPay cancelled/retry result mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    await context.close().catch(() => {});
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED_BRANCH_ONLY' : cleanupError ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_FIXTURE') ||
        report.business_execution === 'LINK_CREATED' ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `S4_UX_034_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_034_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-034] Evidence: .\\evidence\\${name}`);
    console.log('[S4-UX-034] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
