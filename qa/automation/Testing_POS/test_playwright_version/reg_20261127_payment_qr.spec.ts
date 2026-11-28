import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('REG-20261127-PAYMENT-QR | apply and remove own eligible reward',
  async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium fixture only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; sessionId?: string; orderId?: string; itemId?: string;
      customerId?: string; customerName?: string; phone?: string;
      rewardId?: string; rewardName?: string; orderRewardId?: string; menuId?: string; qrToken?: string; paymentId?: string } = {};
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4REWARDUI',
      test_ref: 'REG-20261127-PAYMENT-QR', checked_at: new Date().toISOString(),
      scope: 'QA3 owned 315000 VND bill: payment panel updates to 283500 after 10 percent reward and back without navigation; real QR copy/paste and VNPay recheck message; owned cleanup',
      business_case: 'ADR 0004 and regression of PR 115; IPN outside staging scope',
      project: testInfo.project.name, secrets_recorded: false, phone_recorded: false,
      checks: {}, cleanup_pass: false, ui_writes: [],
    };
    const safe = (error: unknown) => {
      let message = String(error);
      for (const secret of [pin, own.phone, own.qrToken, ...Object.values(tokens)])
        if (secret) message = message.replaceAll(secret, '<REDACTED>');
      return message;
    };
    async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string, role?: string, data?: object) {
      const response = await request.fetch(base + path, {
        method,
        headers: {
          ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
          ...(method !== 'GET' ? { 'Idempotency-Key': randomUUID() } : {}),
        },
        ...(data !== undefined ? { data } : {}), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string, role: string, http: number, data?: object): Promise<any> {
      const response = await call(method, path, role, data);
      expect(response.http, `${method} ${path}: HTTP ${response.http}`).toBe(http);
      return response.body;
    }
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`, 'cashier', 200);
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`, 'waiter', 200);
    const points = () => checked('GET',
      `/api/v1/customers/${own.customerId}/points?limit=200`, 'cashier', 200);
    async function build() {
      const response = await request.get(base + '/version', { timeout: 15_000 });
      expect(response.status()).toBe(200);
      return (await response.json()).commit as string;
    }
    const beforeBuild = await build();
    test.skip(beforeBuild !== expected,
      `PENDING_BUILD: expected ${expected}, staging ${beforeBuild}`);
    report.staging_commit = beforeBuild;
    report.build_before = beforeBuild;
    const specResponse = await request.get(base + '/openapi.json', { timeout: 15_000 });
    expect(specResponse.status()).toBe(200);
    const spec = await specResponse.json();
    for (const [path, method] of [
      ['/api/v1/customers', 'post'], ['/api/v1/rewards', 'post'],
      ['/api/v1/orders/{order_id}/rewards', 'post'],
      ['/api/v1/orders/{order_id}/rewards/{order_reward_id}', 'delete'],
    ]) expect(spec.paths?.[path]?.[method], `PENDING_CONTRACT: ${method} ${path}`).toBeTruthy();
    for (const role of ['admin', 'cashier', 'waiter', 'kitchen']) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username: `qa3_${role}`, password: pin }, timeout: 15_000,
      });
      expect(response.status(), `QA3 ${role} login`).toBe(200);
      tokens[role] = (await response.json()).access_token;
      expect(tokens[role]).toBeTruthy();
    }
    const settings = await checked('GET', '/api/v1/outlet/settings', 'admin', 200);
    expect(Number(settings.vat_rate || 0)).toBe(0);
    expect(Number(settings.service_charge_rate || 0)).toBe(0);
    report.pricing = { vat_rate: settings.vat_rate, service_charge_rate: settings.service_charge_rate };
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
    const source = tables.find(row => row.code === 'Q3-1');
    test.skip(!source || source.status !== 'AVAILABLE', 'PENDING_FIXTURE: Q3-1 AVAILABLE');
    own.tableId = source.id;
    const menu = await checked('GET', '/api/v1/menu?available_only=true',
      'cashier', 200) as any[];
    const starter = menu.find(row => row.is_available && row.station_id &&
      !row.has_modifiers && Number(row.price) > 1);
    test.skip(!starter, 'PENDING_FIXTURE: mapped positive-price menu item');
    own.phone = '09' + String(randomInt(0, 100000000)).padStart(8, '0');
    own.customerName = `QA S4 reward UI ${randomUUID().slice(0, 8)}`;
    own.rewardName = `QA S4 eligible UI ${randomUUID().slice(0, 8)}`;
    const existing = await checked('GET', `/api/v1/customers?phone=${own.phone}`,
      'cashier', 200) as any[];
    test.skip(existing.length !== 0, 'PENDING_FIXTURE: generated phone exists');

    const uiWrites: string[] = report.ui_writes;
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
        path !== '/api/v1/auth/login')
        uiWrites.push(`${req.method()} ${path}`);
    });
    const buttonNames = async () => page.locator('button').evaluateAll(buttons =>
      buttons.map(button => ({ text: button.textContent?.trim().slice(0, 60),
        label: button.getAttribute('aria-label') })).filter(row => row.text || row.label));
    async function cleanup() {
      const errors: string[] = [];
      if (own.paymentId) {
        try {
          const r = await call('POST', `/api/v1/payments/${own.paymentId}/cancel`, 'cashier',
            { reason: 'QA regression owned cleanup' });
          expect(r.http).toBe(200);
        } catch (error) { errors.push(safe(error)); }
      }
      if (own.qrToken) {
        try { await checked('DELETE', `/api/v1/tables/${own.tableId}/qr-session`, 'waiter', 204); }
        catch (error) { errors.push(safe(error)); }
      }
      if (own.menuId) {
        try { await checked('PATCH', `/api/v1/menu/${own.menuId}`, 'admin', 200, { is_available: false }); }
        catch (error) { errors.push(safe(error)); }
      }
      if (!own.customerId) {
        try {
          const customers = await checked('GET', `/api/v1/customers?phone=${own.phone}`,
            'cashier', 200) as any[];
          const matches = customers.filter(row => row.full_name === own.customerName);
          if (matches.length > 1) throw new Error('ambiguous owned customer');
          own.customerId = matches[0]?.id;
        } catch (error) { errors.push(`discover customer: ${safe(error)}`); }
      }
      if (!own.rewardId) {
        try {
          const rewards = await checked('GET', '/api/v1/rewards', 'admin', 200) as any[];
          const matches = rewards.filter(row => row.name === own.rewardName);
          if (matches.length > 1) throw new Error('ambiguous owned reward');
          own.rewardId = matches[0]?.id;
        } catch (error) { errors.push(`discover reward: ${safe(error)}`); }
      }
      if (own.sessionId) {
        try {
          const t = await table();
          if (t.current_session?.id !== own.sessionId)
            throw new Error('CLEANUP REQUIRED: session owner changed');
          if (!own.orderId) {
            const found = (t.orders || []).filter((row: any) =>
              row.table_session_id === own.sessionId);
            if (found.length === 1) own.orderId = found[0].id;
            else throw new Error('CLEANUP REQUIRED: own order uncertain');
          }
          let current = await order();
          if (current.table_session_id !== own.sessionId)
            throw new Error('CLEANUP REQUIRED: order/session mismatch');
          if (current.applied_reward && !['PAID', 'CLOSED'].includes(current.status)) {
            const appliedId = current.applied_reward.id || own.orderRewardId;
            if (!appliedId) throw new Error('CLEANUP REQUIRED: applied reward ID missing');
            await checked('DELETE',
              `/api/v1/orders/${own.orderId}/rewards/${appliedId}`, 'cashier', 200);
          }
          current = await order();
          if (current.status === 'NEW') {
            if (!current.items?.length)
              await checked('POST', `/api/v1/orders/${own.orderId}/items`,
                'waiter', 201, { items: [{ menu_item_id: starter.id, quantity: 1,
                  note: 'REG-20261127-PAYMENT-QR cleanup' }] });
            await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
              'waiter', 200);
          }
          current = await order();
          for (const item of current.items) {
            for (const [state, action, role] of [
              ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
              ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
            ] as const) {
              if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
                await checked('POST',
                  `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`, role, 200);
            }
            expect((await order()).items.find((row: any) => row.id === item.id)?.status)
              .toBe('SERVED');
          }
          if (own.customerId && !['PAID', 'CLOSED'].includes((await order()).status) &&
            (await order()).customer_id)
            await checked('POST', `/api/v1/orders/${own.orderId}/customer`,
              'cashier', 200, { customer_id: null });
          if (!['BILLING', 'PAID', 'CLOSED'].includes((await order()).status))
            await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
              'waiter', 200);
          if (!['PAID', 'CLOSED'].includes((await order()).status))
            await checked('POST', `/api/v1/orders/${own.orderId}/pay`, 'cashier', 200);
          if ((await order()).status !== 'CLOSED')
            await checked('POST', `/api/v1/orders/${own.orderId}/close`, 'cashier', 200);
          if ((await table()).status === 'CLEANING')
            await checked('POST', `/api/v1/tables/${own.tableId}/mark-clean`, 'waiter', 200);
          const final = await order();
          const end = await table();
          const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
            'kitchen', 200) as any[];
          const active = await checked('GET', '/api/v1/kitchen/queue',
            'kitchen', 200) as any[];
          report.cleanup_state = {
            order_closed: final.status === 'CLOSED',
            table_available: end.status === 'AVAILABLE',
            open_session: !!end.current_session,
            items_served: final.items.every((row: any) => row.status === 'SERVED'),
            ticket_done: done.some(row => row.order_id === own.orderId),
            no_active_ticket: !active.some(row => row.order_id === own.orderId),
          };
          if (!report.cleanup_state.order_closed || !report.cleanup_state.table_available ||
            report.cleanup_state.open_session || !report.cleanup_state.items_served ||
            !report.cleanup_state.ticket_done || !report.cleanup_state.no_active_ticket)
            throw new Error('CLEANUP REQUIRED: owned order/table/ticket not settled');
        } catch (error) { errors.push(`order ${own.orderId}: ${safe(error)}`); }
      }
      if (own.rewardId) {
        try {
          const disabled = await checked('PATCH', `/api/v1/rewards/${own.rewardId}`,
            'admin', 200, { is_active: false });
          report.reward_inactive = disabled.is_active === false;
          if (!report.reward_inactive) throw new Error('owned reward remains active');
        } catch (error) { errors.push(`reward ${own.rewardId}: ${safe(error)}`); }
      }
      if (own.customerId) {
        try {
          await checked('PATCH', `/api/v1/customers/${own.customerId}`,
            'admin', 200, { is_active: false });
          const customer = await checked('GET',
            `/api/v1/customers/${own.customerId}`, 'admin', 200);
          report.customer_inactive = customer.is_active === false;
          report.cleanup_points_unchanged = customer.points_balance === 0 &&
            (await points()).length === 0;
          if (!report.customer_inactive || !report.cleanup_points_unchanged)
            throw new Error('owned customer or points not settled');
        } catch (error) { errors.push(`customer ${own.customerId}: ${safe(error)}`); }
      }
      if (errors.length) throw new Error('CLEANUP REQUIRED: ' + errors.join('; '));
      report.cleanup_pass = !!own.orderId && !!own.rewardId && !!own.customerId;
    }

    let failure: unknown, cleanupError: unknown;
    try {
      own.customerId = (await checked('POST', '/api/v1/customers', 'cashier', 201,
        { phone: own.phone, full_name: own.customerName, consent: true })).id;
      expect(own.customerId).toBeTruthy();
      own.rewardId = (await checked('POST', '/api/v1/rewards', 'admin', 201,
        { name: own.rewardName, reward_type: 'PERCENT', value: '10',
          min_order_amount: '0' })).id;
      expect(own.rewardId).toBeTruthy();
      own.menuId = (await checked('POST', '/api/v1/menu', 'admin', 201,
        { name: `QA regression 315k ${randomUUID().slice(0, 8)}`, price: '315000.00',
          station_id: starter.station_id, category_id: starter.category_id, is_available: true })).id;
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${source.id}/open-session`, 'waiter', 201,
        { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'cashier', 201,
        { table_session_id: own.sessionId })).id;
      const added = await checked('POST', `/api/v1/orders/${own.orderId}/items`,
        'waiter', 201, { items: [{ menu_item_id: own.menuId, quantity: 1,
          note: 'REG-20261127-PAYMENT-QR own' }] });
      own.itemId = added.items?.find((row: any) => row.menu_item_id === own.menuId)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/customer`,
        'cashier', 200, { customer_id: own.customerId });
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter', 200);
      await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`, 'waiter', 200);
      const original = await order();
      expect(Number(original.total)).toBe(315000);
      const beforePoints = await points();
      const beforeBalance = (await checked('GET',
        `/api/v1/customers/${own.customerId}`, 'cashier', 200)).points_balance;
      expect(beforePoints).toHaveLength(0);
      expect(beforeBalance).toBe(0);
      const eligible = await checked('GET',
        `/api/v1/orders/${own.orderId}/eligible-rewards`, 'cashier', 200) as any[];
      expect(eligible.find(row => row.reward_id === own.rewardId)?.eligible).toBe(true);
      console.log(`[S4-REWARD-UI] Own fixture: Q3-1 session ${own.sessionId}, order ${own.orderId}`);

      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const qr = await checked('POST', `/api/v1/tables/${own.tableId}/qr-session`, 'waiter', 201);
      own.qrToken = qr.token;
      await page.goto(`${base}/tables/${own.tableId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Mã QR gọi món bàn Q3-1', exact: true }).click();
      const qrDialog = page.getByRole('dialog');
      const expectedLink = await qrDialog.getByTestId('qr-link').innerText();
      await qrDialog.getByRole('button', { name: 'Sao chép đường dẫn QR', exact: true }).click();
      await expect(qrDialog.getByRole('button', { name: 'Sao chép đường dẫn QR' })).toHaveText('Đã chép');
      await page.evaluate(() => {
        const probe = document.createElement('textarea');
        probe.id = 'qa-copy-probe'; document.body.append(probe); probe.focus();
      });
      await page.keyboard.press('Control+V');
      const copiedMatches = await page.locator('#qa-copy-probe').inputValue() === expectedLink;
      expect(copiedMatches, 'Actual clipboard paste matches QR link').toBe(true);
      report.qr_copy = { result: 'PASSED', pasted_link_matches: copiedMatches };
      await page.locator('#qa-copy-probe').evaluate(node => node.remove());
      await qrDialog.getByRole('button', { name: 'Đóng mã QR', exact: true }).click();
      await page.goto(`${base}/tables/${own.tableId}/summary`,
        { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await expect(page.getByTestId('pay-total')).toHaveText('315.000 ₫');
      await expect(page.getByTestId('pay-remaining')).toHaveText('315.000 ₫');
      let navigationCount = 0;
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigationCount++; });
      const rewardRow = page.getByTestId('reward-row').filter({ hasText: own.rewardName! });
      await expect(rewardRow).toBeVisible({ timeout: 15_000 });
      const applyButton = rewardRow.getByRole('button',
        { name: /^(Áp dụng(?: ưu đãi)?|Áp ưu đãi|Sử dụng)(?:\s|$)/i });
      if (!await applyButton.count()) throw new Error(
        'PENDING_UI_SELECTOR: eligible reward apply control; visible buttons ' +
        JSON.stringify(await buttonNames()));
      const [applyResponse] = await Promise.all([
        page.waitForResponse(response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/v1/orders/${own.orderId}/rewards`, { timeout: 15_000 }),
        applyButton.click({ timeout: 10_000 }),
      ]);
      report.apply_http = applyResponse.status();
      expect(report.apply_http).toBe(201);
      await expect(page.getByTestId('pay-total')).toHaveText('283.500 ₫', { timeout: 10000 });
      await expect(page.getByTestId('pay-remaining')).toHaveText('283.500 ₫');
      expect(navigationCount).toBe(0);
      const applied = await order();
      own.orderRewardId = applied.applied_reward?.id;
      expect(own.orderRewardId).toBeTruthy();
      const bill = page.locator('aside[aria-label="Tổng tiền"]');
      await expect(bill).toContainText(Number(applied.total).toLocaleString('vi-VN'));
      await testInfo.attach('PF_S4_REWARD_APPLIED_screen', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const removeButton = page.getByRole('button',
        { name: /^(Gỡ|Bỏ ưu đãi|Bỏ áp dụng|Xóa ưu đãi|Hủy ưu đãi)(?:\s|$)/i });
      if (!await removeButton.count()) throw new Error(
        'PENDING_UI_SELECTOR: applied reward remove control; visible buttons ' +
        JSON.stringify(await buttonNames()));
      const [removeResponse] = await Promise.all([
        page.waitForResponse(response =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname ===
            `/api/v1/orders/${own.orderId}/rewards/${own.orderRewardId}`,
        { timeout: 15_000 }),
        removeButton.click({ timeout: 10_000 }),
      ]);
      report.remove_http = removeResponse.status();
      expect(report.remove_http).toBe(200);
      await expect(page.getByTestId('pay-total')).toHaveText('315.000 ₫', { timeout: 10000 });
      await expect(page.getByTestId('pay-remaining')).toHaveText('315.000 ₫');
      expect(navigationCount).toBe(0);
      report.payment_panel = { before_vnd: 315000, applied_vnd: 283500, restored_vnd: 315000, navigations: navigationCount };
      const restored = await order();
      await expect(bill).toContainText(Number(restored.total).toLocaleString('vi-VN'));
      await testInfo.attach('PF_S4_REWARD_REMOVED_screen', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const afterPoints = await points();
      const balance = (await checked('GET',
        `/api/v1/customers/${own.customerId}`, 'cashier', 200)).points_balance;
      const audit = await checked('GET',
        `/api/v1/audit-logs?order_id=${own.orderId}&limit=200`,
        'admin', 200) as any[];
      report.checks = {
        one_ui_apply: uiWrites.filter(path =>
          path === `POST /api/v1/orders/${own.orderId}/rewards`).length === 1,
        one_ui_remove: uiWrites.filter(path =>
          path === `DELETE /api/v1/orders/${own.orderId}/rewards/${own.orderRewardId}`).length === 1,
        no_other_ui_business_write: uiWrites.length === 2,
        apply_discount: applied.applied_reward?.reward_id === own.rewardId &&
          Number(applied.discount_total) === 31500 &&
          Number(applied.total) === Number(original.total) - 31500 &&
          applied.status === original.status,
        remove_restores_bill: restored.applied_reward == null &&
          Number(restored.discount_total) === Number(original.discount_total) &&
          Number(restored.total) === Number(original.total),
        points_unchanged: balance === beforeBalance &&
          JSON.stringify(afterPoints) === JSON.stringify(beforePoints),
        audit_once: audit.filter(row => row.action === 'ORDER_REWARD_APPLIED').length === 1 &&
          audit.filter(row => row.action === 'ORDER_REWARD_REMOVED').length === 1 &&
          audit.filter(row => row.action === 'ORDER_PAID').length === 0,
      };
      const link = await checked('POST', `/api/v1/orders/${own.orderId}/payments`,
        'cashier', 201, { method: 'VNPAY' });
      own.paymentId = link.payment?.id;
      expect(own.paymentId).toBeTruthy();
      await page.reload({ waitUntil: 'domcontentloaded' });
      const checkButton = page.getByRole('button', { name: 'Kiểm tra lại kết quả VNPay', exact: true });
      const [recheck] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' &&
          new URL(r.url()).pathname === `/api/v1/payments/${own.paymentId}/check`),
        checkButton.click(),
      ]);
      expect([200, 502, 503]).toContain(recheck.status());
      let message = 'Chưa hỏi được VNPay lúc này. Nếu khách đã trả xong, màn này vẫn tự cập nhật trong vài giây; chưa cần thu lại.';
      if (recheck.status() === 200) {
        const state = (await recheck.json()).payment.status;
        expect(state).not.toBe('SUCCEEDED');
        message = ['PENDING', 'UNKNOWN'].includes(state)
          ? 'VNPay chưa có kết quả. Khách chưa trả xong hoặc cần thử lại sau.'
          : 'Link VNPay không thành công. Có thể tạo link mới hoặc thu cách khác.';
      }
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      expect((await order()).status).toBe('BILLING');
      report.vnpay_recheck = { result: 'PASSED', http: recheck.status(), visible_message: message };
      report.order_id = own.orderId;
      report.before_total = original.total;
      report.applied_total = applied.total;
      report.restored_total = restored.total;
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Reward UI/bill/points/audit mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { await cleanup(); }
    catch (error) { cleanupError = error; console.error(safe(error)); }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === beforeBuild;
    report.business_execution = report.apply_http ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' :
      safe(failure).includes('PENDING_UI_SELECTOR') ? 'PENDING' : 'FAILED';
    if (failure) report.error = safe(failure);
    if (cleanupError) report.cleanup_required = safe(cleanupError);
    mkdirSync(join(process.cwd(), 'evidence', 'qa27'), { recursive: true });
    writeFileSync(join(process.cwd(), 'evidence', 'qa27', `${report.run_id}.json`), JSON.stringify(report, null, 2));
    await testInfo.attach('PF_S4_REWARD_APPLY_REMOVE_evidence', {
      body: JSON.stringify(report, null, 2), contentType: 'application/json',
    });
    console.log('[S4-REWARD-UI] Evidence: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(safe(cleanupError));
    if (failure) throw new Error(safe(failure));
    expect(report.build_stable).toBe(true);
  });
