import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Sandbox card/OTP and signed URLs must not enter automatic video/trace artifacts.
test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('P2-PAY-006 | QA3 rejects four tampered signed VNPay Returns',
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
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-P2PAY006`,
      test_ref: 'P2-PAY-006', checked_at: new Date().toISOString(),
      scope: 'QA3 isolated VNPay sandbox success then four invalid Return variants (amount, signature, missing query, reference); payment, bill and audit unchanged; manual test card/OTP; IPN and FE VNPay screen excluded',
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
            note: 'P2-PAY-006 owned cleanup' }] });
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
        if (own.paymentId) {
          const payment = (await ledger()).payments?.find(
            (row: any) => row.id === own.paymentId);
          if (['PENDING', 'UNKNOWN'].includes(payment?.status)) {
            const cancelled = await call('POST',
              `/api/v1/payments/${own.paymentId}/cancel`, 'cashier',
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
          note: 'P2-PAY-006 VNPay sandbox QA3 own' }] });
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
      expect(beforeOrder.status).toBe('BILLING');
      expect(Number(beforeOrder.amount_due)).toBe(50_000);
      expect(beforeLedger.payments).toHaveLength(0);
      report.table_code = own.tableCode; report.order_id = own.orderId;
      console.log(`[P2-PAY-006] Owned Q3-1 order ${own.orderId}; opening VNPay sandbox`);
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
      console.log('[P2-PAY-006] Complete the NCB sandbox test-card and OTP steps in the headed browser; do not scan a bank-app QR.');
      await page.goto(paymentUrl.toString(),
        { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForURL(url =>
        url.origin === base && url.pathname === '/api/v1/payments/vnpay/return',
        { timeout: 16 * 60_000, waitUntil: 'domcontentloaded' });
      const returnText = await page.locator('body').innerText();
      await testInfo.attach('P2_PAY_006_signed_return', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      report.return_success_text = /Thanh toán thành công/i.test(returnText);
      const signedReturn = new URL(page.url()); // memory only: never attach or log
      expect(signedReturn.origin).toBe(base);
      expect(signedReturn.pathname).toBe('/api/v1/payments/vnpay/return');
      expect(signedReturn.searchParams.get('vnp_SecureHash')).toBeTruthy();
      expect(signedReturn.searchParams.get('vnp_Amount')).toBeTruthy();
      expect(signedReturn.searchParams.get('vnp_TxnRef')).toBeTruthy();
      const baselineOrder = await order(), baselineLedger = await ledger();
      const baselineTable = await table();
      const auditRows = () => checked('GET',
        `/api/v1/audit-logs?order_id=${own.orderId}&limit=100`,
        'admin', 200) as Promise<any[]>;
      const baselineAudit = await auditRows();
      const actions = (rows: any[], name: string) =>
        rows.filter(row => row.action === name).length;
      const baselineConfirmed = actions(baselineAudit, 'PAYMENT_CONFIRMED');
      const baselinePaid = actions(baselineAudit, 'ORDER_PAID');
      expect(baselineOrder.status).toBe('PAID');
      expect(baselineLedger.payments?.length).toBe(1);
      expect(baselineLedger.payments[0]?.id).toBe(own.paymentId);
      expect(baselineLedger.payments[0]?.status).toBe('SUCCEEDED');
      expect(Number(baselineLedger.summary?.paid)).toBe(50_000);
      expect(Number(baselineLedger.summary?.remaining)).toBe(0);
      expect(baselineTable.status).toBe('CLEANING');
      expect(baselineConfirmed).toBe(1);
      expect(baselinePaid).toBe(1);
      report.business_execution = 'EXECUTED';

      const amount = new URL(signedReturn);
      amount.searchParams.set('vnp_Amount', String(
        Number(amount.searchParams.get('vnp_Amount')) - 100));
      const signature = new URL(signedReturn);
      const originalHash = signature.searchParams.get('vnp_SecureHash')!;
      signature.searchParams.set('vnp_SecureHash',
        (originalHash[0] === '0' ? '1' : '0') + originalHash.slice(1));
      const reference = new URL(signedReturn);
      const originalRef = reference.searchParams.get('vnp_TxnRef')!;
      reference.searchParams.set('vnp_TxnRef',
        (originalRef[0] === '0' ? '1' : '0') + originalRef.slice(1));
      const missing = new URL(signedReturn.pathname, base);
      const cases = [
        { name: 'amount', url: amount },
        { name: 'signature', url: signature },
        { name: 'missing_query', url: missing },
        { name: 'transaction_ref', url: reference },
      ];
      report.probes = [];
      for (const probe of cases) {
        // Response metadata only. Signed URL and query never leave this scope.
        const response = await request.get(probe.url.toString(),
          { timeout: 20_000, failOnStatusCode: false });
        const body = await response.text();
        const postOrder = await order(), postLedger = await ledger();
        const postTable = await table(), postAudit = await auditRows();
        const observed = {
          variant: probe.name, http: response.status(),
          invalid_message: /Liên kết không hợp lệ/i.test(body),
          payment_unchanged: postLedger.payments?.length === 1 &&
            postLedger.payments[0]?.id === own.paymentId &&
            postLedger.payments[0]?.status === 'SUCCEEDED' &&
            Number(postLedger.summary?.paid) === 50_000 &&
            Number(postLedger.summary?.remaining) === 0,
          order_table_unchanged: postOrder.status === 'PAID' &&
            Number(postOrder.amount_due) === 0 &&
            postTable.status === 'CLEANING',
          audit_unchanged:
            actions(postAudit, 'PAYMENT_CONFIRMED') === baselineConfirmed &&
            actions(postAudit, 'ORDER_PAID') === baselinePaid,
        };
        report.probes.push(observed);
      }
      report.checks = {
        valid_return_settled_once: report.return_success_text &&
          !returnText.includes(own.orderId),
        four_invalid_returns_rejected: report.probes.length === 4 &&
          report.probes.every((row: any) => row.http === 400 &&
            row.invalid_message),
        no_bill_or_ledger_mutation: report.probes.every((row: any) =>
          row.payment_unchanged && row.order_table_unchanged),
        no_extra_confirmation_audit: report.probes.every((row: any) =>
          row.audit_unchanged),
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('VNPay invalid Return result mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    await context.close().catch(() => {});
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_FIXTURE') ||
        report.business_execution === 'LINK_CREATED' ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `P2_PAY_006_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('P2_PAY_006_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[P2-PAY-006] Evidence: .\\evidence\\${name}`);
    console.log('[P2-PAY-006] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
