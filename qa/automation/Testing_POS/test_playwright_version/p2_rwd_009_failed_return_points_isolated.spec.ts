import { randomUUID, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Sandbox card/OTP and signed URLs must not enter automatic video/trace artifacts.
test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('PF-P2-RWD-009-FAILED-RETURN | QA3 failed signed Return preserves owned reward points',
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
      orderId?: string; itemId?: string; menuId?: string; paymentId?: string;
      customerId?: string; customerName?: string; phone?: string;
      rewardId?: string; rewardName?: string; billAmount?: number; points?: number } = {};
    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-PFP2RWD009RETURN`,
      test_ref: 'PF-P2-RWD-009-FAILED-RETURN',
      business_case: 'P2-RWD-009 remains Pending until PO confirms points policy and evidence scopes are reviewed', checked_at: new Date().toISOString(),
      scope: 'QA3 owned POINTS reward with customer: VNPay sandbox cancellation via signed Return, points ledger/bill/audit unchanged; fresh link cancelled, owned cleanup; FE VNPay UI, expiry and IPN excluded',
      project: testInfo.project.name, case_coverage: 'SIGNED_FAILED_RETURN_WITH_POINTS',
      full_case_status: 'PENDING_PO_POINTS_FAILURE_POLICY', secrets_recorded: false,
      card_recorded: false, signed_url_recorded: false, phone_recorded: false,
      checks: {}, cleanup_pass: false, business_execution: 'NOT_EXECUTED',
    };
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, own.phone, ...Object.values(tokens)])
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
      ['/api/v1/customers/{customer_id}/points', 'get'],
      ['/api/v1/orders/{order_id}/rewards', 'post'],
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
    async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, role: string,
      data?: object, key?: string) {
      const response = await request.fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${tokens[role]}`,
          ...(method !== 'GET' ? { 'Idempotency-Key': key || randomUUID() } : {}) },
        ...(data !== undefined ? { data } : {}),
        timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, role: string,
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
    const points = () => checked('GET',
      `/api/v1/customers/${own.customerId}/points?limit=200`, 'cashier', 200);
    const customer = () => checked('GET',
      `/api/v1/customers/${own.customerId}`, 'cashier', 200);

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
            note: 'P2-RWD-009 owned cleanup' }] });
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
      if (current.applied_reward) {
        await checked('DELETE',
          `/api/v1/orders/${own.orderId}/rewards/${current.applied_reward.id}`,
          'cashier', 200);
      }
      if ((await order()).customer_id)
        await checked('POST', `/api/v1/orders/${own.orderId}/customer`,
          'cashier', 200, { customer_id: null });
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

    async function deactivateOwned() {
      if (!own.rewardId && own.rewardName) {
        const rows = await checked('GET', '/api/v1/rewards', 'admin', 200) as any[];
        const matches = rows.filter(row => row.name === own.rewardName);
        if (matches.length !== 1)
          throw new Error('CLEANUP REQUIRED: owned reward identity uncertain');
        own.rewardId = matches[0].id;
      }
      if (own.rewardId) {
        await checked('PATCH', `/api/v1/rewards/${own.rewardId}`, 'admin',
          200, { is_active: false });
        const rows = await checked('GET', '/api/v1/rewards', 'admin', 200) as any[];
        report.reward_inactive = rows.find(row => row.id === own.rewardId)?.is_active === false;
        if (!report.reward_inactive)
          throw new Error('CLEANUP REQUIRED: owned reward remains active');
      }
      if (!own.customerId && own.phone && own.customerName) {
        const rows = await checked('GET',
          `/api/v1/customers?phone=${own.phone}`, 'cashier', 200) as any[];
        const matches = rows.filter(row => row.full_name === own.customerName);
        if (matches.length !== 1)
          throw new Error('CLEANUP REQUIRED: owned customer identity uncertain');
        own.customerId = matches[0].id;
      }
      if (own.customerId) {
        await checked('PATCH', `/api/v1/customers/${own.customerId}`,
          'admin', 200, { is_active: false });
        report.customer_inactive = (await checked('GET',
          `/api/v1/customers/${own.customerId}`, 'admin', 200)).is_active === false;
        if (!report.customer_inactive)
          throw new Error('CLEANUP REQUIRED: owned customer remains active');
        const currentPoints = await points();
        report.cleanup_points_unchanged =
          currentPoints.length === 1 &&
          currentPoints[0]?.entry_type === 'ADJUST' &&
          (await checked('GET', `/api/v1/customers/${own.customerId}`,
            'admin', 200)).points_balance === own.points;
        if (!report.cleanup_points_unchanged)
          throw new Error('CLEANUP REQUIRED: points changed during cleanup');
      }
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
      const rules = await checked('GET', '/api/v1/loyalty-rules', 'admin', 200) as any[];
      const rule = rules[0];
      if (!rule || Number(rule.redeem_value_per_point) <= 0 ||
          Number(rule.max_redeem_percent) <= 0)
        throw new Error('PENDING_FIXTURE: redeem rule unavailable');
      own.points = Math.floor(50_000 * Number(rule.max_redeem_percent) / 100 /
        Number(rule.redeem_value_per_point));
      if (!own.points || own.points > 1_000_000)
        throw new Error('PENDING_FIXTURE: redeem amount invalid');
      own.customerName = `QA P2RWD009 ${randomUUID().slice(0, 8)}`;
      own.phone = '09' + String(randomInt(0, 100_000_000)).padStart(8, '0');
      const duplicates = await checked('GET',
        `/api/v1/customers?phone=${own.phone}`, 'cashier', 200) as any[];
      if (duplicates.length) throw new Error('PENDING_FIXTURE: generated phone already exists');
      own.customerId = (await checked('POST', '/api/v1/customers', 'cashier', 201,
        { phone: own.phone, full_name: own.customerName, consent: true })).id;
      await checked('POST', `/api/v1/customers/${own.customerId}/points/adjust`,
        'admin', 201, { points: own.points, reason: 'QA owned P2-RWD-009 baseline' });
      own.rewardName = `QA P2RWD009 ${randomUUID().slice(0, 8)}`;
      own.rewardId = (await checked('POST', '/api/v1/rewards', 'admin', 201,
        { name: own.rewardName, reward_type: 'POINTS',
          min_order_amount: '0' })).id;
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${own.tableId}/open-session`, 'waiter', 201,
        { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders',
        'waiter', 201, { table_session_id: own.sessionId })).id;
      const added = await checked('POST',
        `/api/v1/orders/${own.orderId}/items`, 'waiter', 201,
        { items: [{ menu_item_id: own.menuId, quantity: 1,
          note: 'P2-RWD-009 VNPay sandbox QA3 own' }] });
      own.itemId = added.items.find((item: any) =>
        item.menu_item_id === own.menuId)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/customer`,
        'cashier', 200, { customer_id: own.customerId });
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
        'waiter', 200);
      for (const [action, role] of [
        ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
        ['pickup', 'waiter'], ['served', 'waiter'],
      ] as const) await checked('POST',
        `/api/v1/orders/${own.orderId}/items/${own.itemId}/${action}`,
        role, 200);
      await checked('POST', `/api/v1/orders/${own.orderId}/rewards`,
        'cashier', 201, { reward_id: own.rewardId, points: own.points });
      await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
        'waiter', 200);
      const beforeOrder = await order(), beforeLedger = await ledger();
      const beforeTable = await table();
      expect(beforeOrder.status).toBe('BILLING');
      own.billAmount = 50_000 - own.points! * Number(rule.redeem_value_per_point);
      expect(Number(beforeOrder.amount_due)).toBe(own.billAmount);
      expect(beforeLedger.payments).toHaveLength(0);
      const pointsBefore = await points();
      expect(pointsBefore).toHaveLength(1);
      expect((await customer()).points_balance).toBe(own.points);
      report.table_code = own.tableCode; report.order_id = own.orderId;
      console.log(`[P2-RWD-009] Owned Q3-1 order ${own.orderId}; opening VNPay sandbox`);
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
      expect(Number(created.body?.summary?.pending)).toBe(own.billAmount);
      expect(new Date(payment?.expires_at).getTime()).toBeGreaterThan(Date.now());
      const paymentUrl = new URL(payment?.payment_url);
      expect(paymentUrl.hostname).toBe('sandbox.vnpayment.vn');
      report.business_execution = 'LINK_CREATED';
      console.log('[P2-RWD-009] In the headed VNPay sandbox, choose Huy thanh toan and confirm cancellation; do not enter a card/OTP.');
      await page.goto(paymentUrl.toString(),
        { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForURL(url =>
        url.origin === base && url.pathname === '/api/v1/payments/vnpay/return',
        { timeout: 16 * 60_000, waitUntil: 'domcontentloaded' });
      const returnText = await page.locator('body').innerText();
      await testInfo.attach('P2_RWD_009_failed_return', {
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
      const pointsAfterFailed = await points();
      const customerAfterFailed = await customer();
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
      const cancelled = await call('POST',
        `/api/v1/payments/${own.paymentId}/cancel`, 'cashier',
        { reason: 'QA P2-RWD-009 customer changed payment method' });
      report.retry_cancel_http = cancelled.http;
      const finalLedger = await ledger(), finalOrder = await order();
      const pointsAfterCancel = await points();
      const customerAfterCancel = await customer();
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
      report.points_after_failure = customerAfterFailed.points_balance;
      report.points_after_retry_cancel = customerAfterCancel.points_balance;
      report.points_ledger_count = pointsAfterCancel.length;
      report.checks = {
        signed_return_failed: report.return_failure_text &&
          !returnText.includes(own.orderId!),
        original_failed_unpaid: firstPayment?.status === 'FAILED' &&
          failedOrder.status === 'BILLING' &&
          Number(failedOrder.amount_due) === own.billAmount &&
          Number(failedLedger.summary?.paid) === 0 &&
          Number(failedLedger.summary?.pending) === 0 &&
          failedTable.status === beforeTable.status,
        distinct_retry_link: secondPayment?.status === 'PENDING' &&
          !!secondPayment?.id && secondPayment.id !== firstPaymentId &&
          Number(retried.body?.summary?.pending) === own.billAmount &&
          retryLedger.payments?.length === 2,
        retry_cancelled: cancelled.http === 200 &&
          report.after_cancel.first_status === 'FAILED' &&
          report.after_cancel.retry_status === 'CANCELLED' &&
          finalOrder.status === 'BILLING' &&
          Number(finalOrder.amount_due) === own.billAmount &&
          Number(finalLedger.summary?.paid) === 0 &&
          Number(finalLedger.summary?.pending) === 0,
        no_paid_audit: report.audit_counts.order_paid === 0 &&
          report.audit_counts.link_created === 2,
        failed_payment_does_not_consume_points:
          customerAfterFailed.points_balance === own.points &&
          JSON.stringify(pointsBefore) === JSON.stringify(pointsAfterFailed),
        retry_cancel_does_not_consume_points:
          customerAfterCancel.points_balance === own.points &&
          JSON.stringify(pointsBefore) === JSON.stringify(pointsAfterCancel),
      };
      report.business_execution = 'EXECUTED';
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('VNPay cancelled/retry result mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    await context.close().catch(() => {});
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { await deactivateOwned(); }
    catch (error) { cleanupError ||= error; report.cleanup_pass = false; }
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
    const name = `PF_P2_RWD_009_RETURN_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('P2_RWD_009_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[P2-RWD-009] Evidence: .\\evidence\\${name}`);
    console.log('[P2-RWD-009] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
