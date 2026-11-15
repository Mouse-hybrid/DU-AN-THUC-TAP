import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('PF-S4-REWARD-MIN-ORDER-UI | below-minimum reward shown on own bill',
  async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium fixture only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const version = async () => {
      const response = await request.get(base + '/version', { timeout: 15_000 });
      expect(response.status()).toBe(200);
      return (await response.json()).commit as string;
    };
    const build = await version();
    test.skip(build !== expected, `PENDING_BUILD: expected ${expected}, staging ${build}`);
    const tokens: Record<string, string> = {};
    async function call(method: 'GET' | 'POST' | 'PATCH', path: string, role: string, data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: { Authorization: `Bearer ${tokens[role]}`,
          ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}) },
        ...(data ? { data } : {}), timeout: 15_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST' | 'PATCH', path: string,
      role: string, status: number, data?: object): Promise<any> {
      const response = await call(method, path, role, data);
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
      return response.body;
    }
    for (const role of ['admin', 'waiter', 'cashier', 'kitchen']) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username: `qa3_${role}`, password: pin }, timeout: 15_000,
      });
      expect(response.status(), `QA3 ${role} login`).toBe(200);
      tokens[role] = (await response.json()).access_token;
      expect(tokens[role]).toBeTruthy();
    }
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
    const source = tables.find(row => row.code === 'Q3-1');
    test.skip(!source || source.status !== 'AVAILABLE', 'PENDING_FIXTURE: Q3-1 AVAILABLE');
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 'cashier', 200) as any[];
    const starter = menu.find(row => row.is_available && row.station_id &&
      !row.has_modifiers && Number(row.price) > 0);
    test.skip(!starter, 'PENDING_FIXTURE: positive-price mapped menu item');
    const own: { sessionId?: string; orderId?: string; rewardId?: string; menuId?: string } =
      { menuId: starter.id };
    const rewardName = `QA S4 min order ${randomUUID().slice(0, 8)}`;
    let rewardCreateAttempted = false;
    const uiWrites: string[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
        path !== '/api/v1/auth/login') uiWrites.push(`${req.method()} ${path}`);
    });
    const table = () => checked('GET', `/api/v1/tables/${source.id}`, 'waiter', 200);
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`, 'cashier', 200);
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4REWARDMINUI',
      test_ref: 'PF-S4-REWARD-MIN-ORDER-UI', checked_at: new Date().toISOString(),
      scope: 'QA3 desktop UI shows an owned reward below minimum as ineligible; no reward applied, no customer UI',
      business_case: 'P2-RWD-004 NOT_EXECUTED: PO/CRM policy and customer-specific eligibility not asserted',
      staging_commit: build, build_before: build, project: testInfo.project.name,
      secrets_recorded: false, cleanup_pass: false, checks: {}, ui_writes: uiWrites,
    };
    async function cleanup() {
      const errors: string[] = [];
      if (rewardCreateAttempted && !own.rewardId) {
        try {
          const rewards = await checked('GET', '/api/v1/rewards', 'admin', 200) as any[];
          const matches = rewards.filter(row => row.name === rewardName);
          if (matches.length > 1) throw new Error('owned reward ambiguous');
          own.rewardId = matches[0]?.id;
        } catch (error) { errors.push(`discover owned reward: ${String(error)}`); }
      }
      if (own.rewardId) {
        try {
          const disabled = await checked('PATCH', `/api/v1/rewards/${own.rewardId}`,
            'admin', 200, { is_active: false });
          expect(disabled.is_active).toBe(false);
          report.reward_disabled = true;
        } catch (error) { errors.push(`reward ${own.rewardId}: ${String(error)}`); }
      }
      if (own.sessionId) {
        try {
          const t = await table();
          if (t.current_session?.id !== own.sessionId)
            throw new Error('CLEANUP REQUIRED: session owner changed');
          if (!own.orderId) {
            const found = (t.orders || []).filter((row: any) => row.table_session_id === own.sessionId);
            if (found.length === 1) own.orderId = found[0].id;
            else if (!found.length) own.orderId = (await checked('POST', '/api/v1/orders',
              'waiter', 201, { table_session_id: own.sessionId })).id;
            else throw new Error('CLEANUP REQUIRED: own orders ambiguous');
          }
          let current = await order();
          if (current.table_session_id !== own.sessionId)
            throw new Error('CLEANUP REQUIRED: order/session mismatch');
          if (current.status === 'NEW') {
            if (!current.items?.length) await checked('POST', `/api/v1/orders/${own.orderId}/items`,
              'waiter', 201, { items: [{ menu_item_id: own.menuId, quantity: 1,
                note: 'PF-S4-REWARD-MIN-ORDER cleanup' }] });
            await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter', 200);
          }
          current = await order();
          for (const item of current.items) {
            for (const [state, action, role] of [
              ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
              ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
            ] as const) {
              if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
                await checked('POST', `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,
                  role, 200);
            }
            expect((await order()).items.find((row: any) => row.id === item.id)?.status).toBe('SERVED');
          }
          if (!['BILLING', 'PAID', 'CLOSED'].includes((await order()).status))
            await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`, 'waiter', 200);
          if (!['PAID', 'CLOSED'].includes((await order()).status))
            await checked('POST', `/api/v1/orders/${own.orderId}/pay`, 'cashier', 200);
          if ((await order()).status !== 'CLOSED')
            await checked('POST', `/api/v1/orders/${own.orderId}/close`, 'cashier', 200);
          if ((await table()).status === 'CLEANING')
            await checked('POST', `/api/v1/tables/${source.id}/mark-clean`, 'waiter', 200);
          const final = await table();
          expect(final.status).toBe('AVAILABLE');
          expect(final.current_session).toBeNull();
          expect((await order()).status).toBe('CLOSED');
          const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE', 'kitchen', 200) as any[];
          const active = await checked('GET', '/api/v1/kitchen/queue', 'kitchen', 200) as any[];
          expect(done.filter(row => row.order_id === own.orderId)).toHaveLength((await order()).items.length);
          expect(active.filter(row => row.order_id === own.orderId)).toHaveLength(0);
          report.order_closed = true;
          report.table_available = true;
        } catch (error) { errors.push(`order ${own.orderId}: ${String(error)}`); }
      }
      if (errors.length) throw new Error(`CLEANUP REQUIRED: ${errors.join('; ')}`);
    }
    let failure: unknown, cleanupError: unknown;
    try {
      own.sessionId = (await checked('POST', `/api/v1/tables/${source.id}/open-session`,
        'waiter', 201, { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'cashier', 201,
        { table_session_id: own.sessionId })).id;
      await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'cashier', 201,
        { items: [{ menu_item_id: starter.id, quantity: 1, note: 'PF-S4-REWARD-MIN-ORDER own' }] });
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter', 200);
      const before = await order();
      const minAmount = (Number(before.subtotal) + 1).toFixed(2);
      rewardCreateAttempted = true;
      own.rewardId = (await checked('POST', '/api/v1/rewards', 'admin', 201, {
        name: rewardName, reward_type: 'FIXED', value: '1.00', min_order_amount: minAmount,
      })).id;
      expect(own.rewardId).toBeTruthy();
      const eligible = await checked('GET',
        `/api/v1/orders/${own.orderId}/eligible-rewards`, 'cashier', 200) as any[];
      const ownRow = eligible.find(row => row.reward_id === own.rewardId);
      expect(ownRow?.eligible).toBe(false);
      expect(ownRow?.reason_code).toBe('MIN_ORDER');
      console.log(`[S4-REWARD-MIN-ORDER-UI] Own fixture: Q3-1 session ${own.sessionId}, order ${own.orderId}`);

      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click({ timeout: 10_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto(`${base}/tables/${source.id}/summary`,
        { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const uiReward = page.getByTestId('reward-row').filter({ hasText: rewardName });
      await expect(uiReward).toBeVisible({ timeout: 15_000 });
      await expect(uiReward.getByText(/Đơn chưa đạt giá trị tối thiểu/)).toBeVisible();
      await testInfo.attach('PF_S4_REWARD_MIN_ORDER_screen', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 15_000 }),
        contentType: 'image/png',
      });
      const after = await order();
      report.checks = {
        api_min_order_denial: ownRow?.eligible === false && ownRow?.reason_code === 'MIN_ORDER',
        ui_own_reward_visible: await uiReward.isVisible(),
        ui_denial_reason_visible: await uiReward.getByText(/Đơn chưa đạt giá trị tối thiểu/).isVisible(),
        no_ui_business_write: uiWrites.length === 0,
        order_unchanged: after.id === before.id && after.total === before.total &&
          after.discount_total === before.discount_total &&
          JSON.stringify(after.applied_reward) === JSON.stringify(before.applied_reward),
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error(`Reward UI mismatch: ${JSON.stringify(report.checks)}`);
      console.log('[S4-REWARD-MIN-ORDER-UI] UI denial PASS; no reward write');
    } catch (error) { failure = error; }
    try { await cleanup(); report.cleanup_pass = !!own.sessionId && !!own.rewardId; }
    catch (error) { cleanupError = error; console.error(String(error)); }
    try { report.build_after = await version(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === build;
    report.order_id = own.orderId;
    report.business_execution = own.rewardId ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !failure && !cleanupError && report.cleanup_pass && report.build_stable ?
      'PASSED' : cleanupError ? 'INCONCLUSIVE' : 'FAILED';
    await testInfo.attach('PF_S4_REWARD_MIN_ORDER_evidence', {
      body: JSON.stringify(report, null, 2), contentType: 'application/json',
    });
    console.log('[S4-REWARD-MIN-ORDER-UI] Evidence: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
