import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('S4-UX-029 | paid bill cannot apply or remove a reward in UI',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 desktop Chromium only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; sessionId?: string; orderId?: string;
      itemId?: string; menuId?: string; customerId?: string; rewardId?: string;
      orderRewardId?: string; phone?: string; customerName?: string;
      rewardName?: string } = {};
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX029',
      test_ref: 'S4-UX-029', checked_at: new Date().toISOString(),
      project: testInfo.project.name,
      scope: 'QA3 paid CASH bill with an owned FIXED reward: revisit desktop UI and verify apply/remove guarded; bill, points, ledger, audit and owned cleanup. No gateway or PO customer-specific policy.',
      secrets_recorded: false, phone_recorded: false,
      checks: {}, ui_writes: [], cleanup_pass: false,
    };
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, own.phone, ...Object.values(tokens)])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      return value;
    };
    async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string, role: string, data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: {
          Authorization: 'Bearer ' + tokens[role],
          ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}),
        }, ...(data !== undefined ? { data } : {}), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string, role: string, http: number, data?: object): Promise<any> {
      const result = await call(method, path, role, data);
      expect(result.http, method + ' ' + path + ' HTTP').toBe(http);
      return result.body;
    }
    const order = () => checked('GET', '/api/v1/orders/' + own.orderId,
      'cashier', 200);
    const table = () => checked('GET', '/api/v1/tables/' + own.tableId,
      'waiter', 200);
    const ledger = () => checked('GET', '/api/v1/orders/' + own.orderId +
      '/payments', 'cashier', 200);
    const points = () => checked('GET', '/api/v1/customers/' + own.customerId +
      '/points?limit=200', 'cashier', 200);
    const audit = () => checked('GET', '/api/v1/audit-logs?order_id=' +
      own.orderId + '&limit=200', 'admin', 200);
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const before = await build();
    test.skip(before !== expected,
      'PENDING_BUILD: staging differs from POS_EXPECTED_COMMIT');
    report.staging_commit = before;
    const contract = await request.get(base + '/openapi.json', { timeout: 20_000 });
    expect(contract.status()).toBe(200);
    const spec = await contract.json();
    for (const [path, method] of [
      ['/api/v1/customers', 'post'], ['/api/v1/rewards', 'post'],
      ['/api/v1/orders/{order_id}/rewards', 'post'],
      ['/api/v1/orders/{order_id}/rewards/{order_reward_id}', 'delete'],
      ['/api/v1/orders/{order_id}/payments', 'post'],
    ]) expect(spec.paths?.[path]?.[method], method + ' ' + path).toBeTruthy();
    for (const [role, expectedRole] of [
      ['admin', 'SUPERVISOR'], ['cashier', 'CASHIER'],
      ['waiter', 'WAITER'], ['kitchen', 'KITCHEN'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username: 'qa3_' + role, password: pin }, timeout: 20_000,
      });
      expect(response.status(), role + ' login').toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
      tokens[role] = body.access_token;
      expect(tokens[role]).toBeTruthy();
    }
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
    const source = tables.find(row => row.code === 'Q3-1');
    test.skip(!source || source.status !== 'AVAILABLE',
      'PENDING_FIXTURE: Q3-1 must be AVAILABLE');
    own.tableId = source.id;
    const menu = await checked('GET', '/api/v1/menu?available_only=true',
      'waiter', 200) as any[];
    const starter = menu.find(row => row.is_available && row.station_id &&
      !row.has_modifiers && Number(row.price) === 50_000);
    test.skip(!starter, 'PENDING_FIXTURE: mapped 50,000 VND item required');
    own.menuId = starter.id;
    own.phone = '09' + String(randomInt(0, 100000000)).padStart(8, '0');
    own.customerName = 'QA S4 paid guard ' + randomUUID().slice(0, 8);
    own.rewardName = 'QA S4 paid reward ' + randomUUID().slice(0, 8);
    const duplicates = await checked('GET', '/api/v1/customers?phone=' +
      own.phone, 'cashier', 200) as any[];
    test.skip(duplicates.length > 0, 'PENDING_FIXTURE: phone collision');

    async function cleanup() {
      const errors: string[] = [];
      if (!own.customerId) {
        try {
          const matches = (await checked('GET', '/api/v1/customers?phone=' +
            own.phone, 'cashier', 200) as any[]).filter(row =>
              row.full_name === own.customerName);
          if (matches.length > 1) throw new Error('ambiguous customer');
          own.customerId = matches[0]?.id;
        } catch (error) { errors.push('discover customer: ' + redact(error)); }
      }
      if (!own.rewardId) {
        try {
          const matches = (await checked('GET', '/api/v1/rewards',
            'admin', 200) as any[]).filter(row => row.name === own.rewardName);
          if (matches.length > 1) throw new Error('ambiguous reward');
          own.rewardId = matches[0]?.id;
        } catch (error) { errors.push('discover reward: ' + redact(error)); }
      }
      if (own.sessionId) {
        try {
          const t = await table();
          if (t.current_session && t.current_session.id !== own.sessionId)
            throw new Error('CLEANUP REQUIRED: table session owner changed');
          if (!own.orderId) {
            const matches = (t.orders || []).filter((row: any) =>
              row.table_session_id === own.sessionId);
            if (matches.length !== 1)
              throw new Error('CLEANUP REQUIRED: own order uncertain');
            own.orderId = matches[0].id;
          }
          let current = await order();
          if (current.table_session_id !== own.sessionId)
            throw new Error('CLEANUP REQUIRED: order/session mismatch');
          if (current.applied_reward && !['PAID', 'CLOSED'].includes(current.status))
            await checked('DELETE', '/api/v1/orders/' + own.orderId +
              '/rewards/' + current.applied_reward.id, 'cashier', 200);
          current = await order();
          if (current.status === 'NEW') {
            if (!current.items.length)
              await checked('POST', '/api/v1/orders/' + own.orderId + '/items',
                'waiter', 201, { items: [{ menu_item_id: own.menuId,
                  quantity: 1, note: 'S4-UX-029 cleanup' }] });
            await checked('POST', '/api/v1/orders/' + own.orderId +
              '/send-to-kitchen', 'waiter', 200);
          }
          for (const item of (await order()).items) {
            for (const [state, action, role] of [
              ['SENT', 'start-cooking', 'kitchen'],
              ['PREPARING', 'mark-ready', 'kitchen'],
              ['READY', 'pickup', 'waiter'],
              ['PICKED_UP', 'served', 'waiter'],
            ] as const) {
              if ((await order()).items.find((row: any) =>
                row.id === item.id)?.status === state)
                await checked('POST', '/api/v1/orders/' + own.orderId +
                  '/items/' + item.id + '/' + action, role, 200);
            }
          }
          current = await order();
          if (!['PAID', 'CLOSED'].includes(current.status) && current.customer_id)
            await checked('POST', '/api/v1/orders/' + own.orderId +
              '/customer', 'cashier', 200, { customer_id: null });
          current = await order();
          if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
            await checked('POST', '/api/v1/orders/' + own.orderId +
              '/request-billing', 'waiter', 200);
          if ((await order()).status === 'BILLING')
            await checked('POST', '/api/v1/orders/' + own.orderId +
              '/pay', 'cashier', 200);
          if ((await order()).status === 'PAID')
            await checked('POST', '/api/v1/orders/' + own.orderId +
              '/close', 'cashier', 200);
          if ((await table()).status === 'CLEANING')
            await checked('POST', '/api/v1/tables/' + own.tableId +
              '/mark-clean', 'waiter', 200);
          const finalOrder = await order();
          const finalTable = await table();
          const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
            'kitchen', 200) as any[];
          const active = await checked('GET', '/api/v1/kitchen/queue',
            'kitchen', 200) as any[];
          report.cleanup_state = {
            order_closed: finalOrder.status === 'CLOSED',
            table_available: finalTable.status === 'AVAILABLE' &&
              !finalTable.current_session,
            items_served: finalOrder.items.every((row: any) =>
              row.status === 'SERVED'),
            ticket_done: done.some(row => row.order_id === own.orderId),
            no_active_ticket: !active.some(row => row.order_id === own.orderId),
          };
          if (!Object.values(report.cleanup_state).every(Boolean))
            throw new Error('CLEANUP REQUIRED: final order/table/ticket mismatch');
        } catch (error) { errors.push('order: ' + redact(error)); }
      }
      if (own.rewardId) {
        try {
          const disabled = await checked('PATCH', '/api/v1/rewards/' +
            own.rewardId, 'admin', 200, { is_active: false });
          report.reward_inactive = disabled.is_active === false;
          if (!report.reward_inactive) throw new Error('reward active');
        } catch (error) { errors.push('reward: ' + redact(error)); }
      }
      if (own.customerId) {
        try {
          await checked('PATCH', '/api/v1/customers/' + own.customerId,
            'admin', 200, { is_active: false });
          const customer = await checked('GET', '/api/v1/customers/' +
            own.customerId, 'admin', 200);
          report.customer_inactive = customer.is_active === false;
          if (!report.customer_inactive) throw new Error('customer active');
        } catch (error) { errors.push('customer: ' + redact(error)); }
      }
      if (errors.length) throw new Error('CLEANUP REQUIRED: ' + errors.join('; '));
      report.cleanup_pass = !!own.orderId && !!own.rewardId && !!own.customerId &&
        Object.values(report.cleanup_state || {}).every(Boolean) &&
        report.reward_inactive && report.customer_inactive;
    }

    const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];
    const uiWrites: string[] = report.ui_writes;
    function watch(page: Page) {
      page.on('request', req => {
        const path = new URL(req.url()).pathname;
        if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
          uiWrites.push(req.method() + ' ' + path);
      });
    }
    let failure: unknown, cleanupError: unknown;
    try {
      own.customerId = (await checked('POST', '/api/v1/customers',
        'cashier', 201, { phone: own.phone, full_name: own.customerName,
          consent: true })).id;
      own.rewardId = (await checked('POST', '/api/v1/rewards',
        'admin', 201, { name: own.rewardName, reward_type: 'FIXED',
          value: '1.00', min_order_amount: '0' })).id;
      own.sessionId = (await checked('POST', '/api/v1/tables/' + own.tableId +
        '/open-session', 'waiter', 201, { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'waiter',
        201, { table_session_id: own.sessionId })).id;
      const added = await checked('POST', '/api/v1/orders/' + own.orderId +
        '/items', 'waiter', 201, { items: [{ menu_item_id: own.menuId,
          quantity: 1, note: 'S4-UX-029 owned paid reward' }] });
      own.itemId = added.items?.find((row: any) =>
        row.menu_item_id === own.menuId)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/customer', 'cashier', 200, { customer_id: own.customerId });
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/rewards', 'cashier', 201, { reward_id: own.rewardId });
      const applied = await order();
      own.orderRewardId = applied.applied_reward?.id;
      expect(own.orderRewardId).toBeTruthy();
      expect(Number(applied.total)).toBe(49_999);
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/send-to-kitchen', 'waiter', 200);
      for (const [action, role] of [
        ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
        ['pickup', 'waiter'], ['served', 'waiter'],
      ] as const)
        await checked('POST', '/api/v1/orders/' + own.orderId +
          '/items/' + own.itemId + '/' + action, role, 200);
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/request-billing', 'waiter', 200);
      const payment = await checked('POST', '/api/v1/orders/' + own.orderId +
        '/payments', 'cashier', 201, { method: 'CASH',
          amount: '49999.00', cash_received: '49999.00' });
      report.payment_id = payment.payment?.id;
      const paidOrder = await order();
      const paidLedger = await ledger();
      const paidPoints = await points();
      const paidAudit = await audit();
      const paidTable = await table();
      expect(paidOrder.status).toBe('PAID');
      expect(paidTable.status).toBe('CLEANING');
      expect(paidLedger.payments).toHaveLength(1);
      report.order_id = own.orderId;
      report.table_code = 'Q3-1';
      console.log('[S4-UX-029] Own Q3-1 paid order ' + own.orderId);

      const context = await browser.newContext({ baseURL: base });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      watch(page);
      await page.goto('/tables/' + own.tableId + '/summary?order_id=' +
        own.orderId, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page.getByText('Đã thanh toán').first()).toBeVisible({ timeout: 15_000 });
      const apply = page.getByTestId('reward-row').getByRole('button',
        { name: /^(Áp dụng|Áp ưu đãi|Sử dụng)(?:\s|$)/i });
      const remove = page.getByRole('button',
        { name: /^(Gỡ|Bỏ ưu đãi|Bỏ áp dụng|Xóa ưu đãi|Hủy ưu đãi)(?:\s|$)/i });
      const actions: any[] = [];
      for (const [kind, button, method, suffix] of [
        ['apply', apply, 'POST', '/rewards'],
        ['remove', remove, 'DELETE', '/rewards/' + own.orderRewardId],
      ] as const) {
        const visible = await button.count() > 0 && await button.first().isVisible();
        if (!visible) { actions.push({ kind, guard: 'hidden' }); continue; }
        if (!await button.first().isEnabled()) {
          actions.push({ kind, guard: 'disabled' }); continue;
        }
        const path = '/api/v1/orders/' + own.orderId + suffix;
        const [response] = await Promise.all([
          page.waitForResponse(row => row.request().method() === method &&
            new URL(row.url()).pathname === path, { timeout: 15_000 }),
          button.first().click(),
        ]);
        actions.push({ kind, guard: 'server', http: response.status() });
        expect(response.status(), kind + ' after PAID').toBe(409);
      }
      report.ui_guards = actions;
      const afterOrder = await order();
      const afterLedger = await ledger();
      const afterPoints = await points();
      const afterAudit = await audit();
      report.checks = {
        paid_reward_preserved: paidOrder.applied_reward?.id === own.orderRewardId &&
          afterOrder.applied_reward?.id === own.orderRewardId &&
          afterOrder.status === 'PAID',
        ui_apply_guarded: actions.find(row => row.kind === 'apply')?.guard !== 'server' ||
          actions.find(row => row.kind === 'apply')?.http === 409,
        ui_remove_guarded: actions.find(row => row.kind === 'remove')?.guard !== 'server' ||
          actions.find(row => row.kind === 'remove')?.http === 409,
        bill_unchanged: Number(afterOrder.total) === Number(paidOrder.total) &&
          Number(afterOrder.amount_due) === Number(paidOrder.amount_due),
        ledger_unchanged: JSON.stringify(afterLedger) === JSON.stringify(paidLedger),
        points_unchanged: JSON.stringify(afterPoints) === JSON.stringify(paidPoints),
        audit_unchanged: JSON.stringify(afterAudit) === JSON.stringify(paidAudit),
        no_successful_ui_write: uiWrites.length === actions.filter(row =>
          row.guard === 'server').length,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Paid reward UI/state mismatch: ' +
          JSON.stringify(report.checks));
      await testInfo.attach('S4_UX_029_paid_guard', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
    } catch (error) { failure = error; }
    for (const context of contexts) await context.close().catch(() => {});
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = report.payment_id ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_UI_SELECTOR') ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_029_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_029_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-029] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-029] Result: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
