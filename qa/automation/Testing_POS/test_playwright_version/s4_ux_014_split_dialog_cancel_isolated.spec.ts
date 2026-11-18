import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-014 | split dialog quantity controls and cancel leave bill intact',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(210_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 desktop Chromium only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; sessionId?: string; orderId?: string;
      itemIds?: string[] } = {};
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX014',
      test_ref: 'S4-UX-014', checked_at: new Date().toISOString(),
      scope: 'QA3 split dialog shows two quantity rows, +/- controls and valid remainder; cancel leaves bill, tickets and split audit unchanged; owned cleanup. No split submission.',
      case_coverage: 'DIALOG_QUANTITY_AND_CANCEL_ONLY',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], checks: {}, cleanup_pass: false,
    };
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, ...Object.values(tokens)])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      return value;
    };
    async function call(method: 'GET' | 'POST', path: string,
      role: string, data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: {
          Authorization: 'Bearer ' + tokens[role],
          ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
        }, ...(data !== undefined ? { data } : {}), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST', path: string,
      role: string, http: number, data?: object): Promise<any> {
      const response = await call(method, path, role, data);
      expect(response.http, method + ' ' + path + ' HTTP').toBe(http);
      return response.body;
    }
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const beforeBuild = await build();
    test.skip(beforeBuild !== expected, 'PENDING_BUILD: staging SHA differs');
    report.staging_commit = beforeBuild;
    const contract = await request.get(base + '/openapi.json', { timeout: 20_000 });
    expect(contract.status()).toBe(200);
    expect((await contract.json()).paths?.['/api/v1/orders/{order_id}/split']?.post)
      .toBeTruthy();
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
    const tableRow = tables.find(row => row.code === 'Q3-1');
    test.skip(!tableRow || tableRow.status !== 'AVAILABLE',
      'PENDING_FIXTURE: Q3-1 must be AVAILABLE');
    own.tableId = tableRow.id;
    const menu = await checked('GET', '/api/v1/menu?available_only=true',
      'waiter', 200) as any[];
    const choices = menu.filter(row => row.id && row.name && row.is_available &&
      row.station_id && !row.has_modifiers && Number(row.price) > 0);
    test.skip(choices.length < 2 || choices[0].name === choices[1].name,
      'PENDING_FIXTURE: two distinct mapped menu items required');
    const [keep, move] = choices;
    const table = () => checked('GET', '/api/v1/tables/' + own.tableId,
      'waiter', 200);
    const order = () => checked('GET', '/api/v1/orders/' + own.orderId,
      'cashier', 200);
    const queue = async (status?: string) => {
      const rows = await checked('GET', '/api/v1/kitchen/queue' +
        (status ? '?status=' + status : ''), 'kitchen', 200) as any[];
      return rows.filter(row => row.order_id === own.orderId);
    };
    const audit = () => checked('GET', '/api/v1/audit-logs?action=ORDER_SPLIT' +
      '&entity_id=' + own.orderId + '&limit=100', 'admin', 200);
    async function cleanup() {
      if (!own.sessionId) return;
      const t = await table();
      if (t.current_session?.id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: Q3-1 session ownership changed');
      if (!own.orderId) {
        const ids = (t.orders || []).filter((row: any) =>
          row.table_session_id === own.sessionId).map((row: any) => row.id);
        if (ids.length > 1)
          throw new Error('CLEANUP REQUIRED: order ownership ambiguous');
        own.orderId = ids[0] || (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
      }
      const ids = (t.orders || []).filter((row: any) =>
        row.table_session_id === own.sessionId).map((row: any) => row.id);
      if (ids.some((id: string) => id !== own.orderId))
        throw new Error('CLEANUP REQUIRED: unexpected child order');
      let current = await order();
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (current.status === 'NEW') {
        if (!current.items.length)
          await checked('POST', '/api/v1/orders/' + own.orderId + '/items',
            'waiter', 201, { items: [{ menu_item_id: keep.id,
              quantity: 1, note: 'S4-UX-014 cleanup' }] });
        await checked('POST', '/api/v1/orders/' + own.orderId +
          '/send-to-kitchen', 'waiter', 200);
      }
      current = await order();
      for (const item of current.items) {
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
      if (!current.items.length ||
          current.items.some((item: any) => item.status !== 'SERVED'))
        throw new Error('CLEANUP REQUIRED: item not served');
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
      const finalTable = await table(), finalOrder = await order();
      const active = await queue(), done = await queue('DONE');
      report.cleanup_state = {
        table_available: finalTable.status === 'AVAILABLE' &&
          !finalTable.current_session,
        order_closed: finalOrder.status === 'CLOSED',
        items_served: finalOrder.items.every((item: any) => item.status === 'SERVED'),
        tickets_done: finalOrder.items.every((item: any) =>
          done.some((row: any) => row.order_item_id === item.id)),
        no_active_ticket: active.length === 0,
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final fixture mismatch');
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
        uiWrites.push(req.method() + ' ' + path);
    });
    let failure: unknown;
    try {
      own.sessionId = (await checked('POST', '/api/v1/tables/' +
        own.tableId + '/open-session', 'waiter', 201, { guest_count: 2 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'waiter',
        201, { table_session_id: own.sessionId })).id;
      const added = await checked('POST', '/api/v1/orders/' + own.orderId +
        '/items', 'waiter', 201, { items: [
          { menu_item_id: keep.id, quantity: 1, note: 'S4-UX-014 keep' },
          { menu_item_id: move.id, quantity: 1, note: 'S4-UX-014 move' },
        ] });
      own.itemIds = ['S4-UX-014 keep', 'S4-UX-014 move'].map(note =>
        added.items.find((item: any) => item.note === note)?.id);
      expect(own.itemIds.every(Boolean)).toBe(true);
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/send-to-kitchen', 'waiter', 200);
      console.log('[S4-UX-014] Own Q3-1 session ' + own.sessionId +
        ', order ' + own.orderId);
      const before = {
        table: await table(), order: await order(),
        tickets: await queue(), splitAudit: await audit(),
      };
      expect(before.order.items).toHaveLength(2);
      expect(before.tickets).toHaveLength(2);
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto('/tables/' + own.tableId + '/summary',
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByRole('button', { name: 'Tách bill', exact: true })
        .click({ timeout: 15_000 });
      const dialog = page.getByRole('dialog', { name: 'Tách bill' });
      await expect(dialog).toBeVisible();
      const rows = dialog.getByTestId('split-row');
      await expect(rows).toHaveCount(2);
      const keepRow = rows.filter({ hasText: keep.name });
      const moveRow = rows.filter({ hasText: move.name });
      await expect(keepRow).toHaveCount(1);
      await expect(moveRow).toHaveCount(1);
      await expect(keepRow).toContainText(keep.name);
      await expect(moveRow).toContainText(move.name);
      await expect(keepRow).toContainText(
        Number(keep.price).toLocaleString('vi-VN'));
      await expect(moveRow).toContainText(
        Number(move.price).toLocaleString('vi-VN'));
      const controls = moveRow.locator('button');
      await expect(controls).toHaveCount(2);
      const keepBefore = await keepRow.innerText();
      const moveBefore = await moveRow.innerText();
      const submit = dialog.getByRole('button', { name: 'Tách bill', exact: true });
      await expect(submit).toBeDisabled();
      await controls.nth(1).click();
      await expect.poll(() => moveRow.innerText()).not.toBe(moveBefore);
      await expect(submit).toBeEnabled();
      const plusText = await moveRow.innerText();
      await controls.nth(0).click();
      await expect.poll(() => moveRow.innerText()).toBe(moveBefore);
      await expect(submit).toBeDisabled();
      await controls.nth(1).click();
      await expect.poll(() => moveRow.innerText()).toBe(plusText);
      await expect(keepRow).toHaveText(keepBefore);
      await expect(submit).toBeEnabled();
      const keepControls = keepRow.locator('button');
      await expect(keepControls).toHaveCount(2);
      if (await keepControls.nth(1).isEnabled()) {
        await keepControls.nth(1).click();
        await expect(submit).toBeDisabled();
        await keepControls.nth(0).click();
        await expect(keepRow).toHaveText(keepBefore);
      }
      await expect(submit).toBeEnabled();
      report.dialog = { rows: 2, plus_minus_changed_quantity: true,
        all_items_guarded: true };
      await testInfo.attach('S4_UX_014_split_dialog', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
      await expect(dialog).toBeHidden();
      const after = {
        table: await table(), order: await order(),
        tickets: await queue(), splitAudit: await audit(),
      };
      const stableTable = (row: any) => ({
        status: row.status, current_session: row.current_session,
        merged_into_table_id: row.merged_into_table_id,
        orders: row.orders,
      });
      const stableOrder = (row: any) => ({
        id: row.id, table_session_id: row.table_session_id,
        status: row.status, subtotal: row.subtotal,
        current_version: row.current_version, items: row.items,
      });
      const stableTickets = (rows: any[]) => rows.map(row => ({
        id: row.id, order_id: row.order_id, order_item_id: row.order_item_id,
        status: row.status, station_id: row.station_id,
      })).sort((a, b) => a.id.localeCompare(b.id));
      report.checks = {
        two_quantity_rows: report.dialog.rows === 2 &&
          before.order.items.length === 2,
        plus_minus_changes_quantity: plusText !== moveBefore,
        valid_remainder: report.dialog.all_items_guarded &&
          keepBefore.includes(keep.name),
        cancel_no_split_post: !uiWrites.some(path =>
          path === 'POST /api/v1/orders/' + own.orderId + '/split'),
        no_ui_business_write: uiWrites.length === 0,
        table_unchanged: JSON.stringify(stableTable(after.table)) ===
          JSON.stringify(stableTable(before.table)),
        order_unchanged: JSON.stringify(stableOrder(after.order)) ===
          JSON.stringify(stableOrder(before.order)),
        tickets_unchanged: JSON.stringify(stableTickets(after.tickets)) ===
          JSON.stringify(stableTickets(before.tickets)),
        split_audit_unchanged: JSON.stringify(after.splitAudit) ===
          JSON.stringify(before.splitAudit),
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Split dialog/cancel mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { await cleanup(); } catch (error) {
      report.cleanup_required = redact(error);
    }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === beforeBuild;
    report.session_id = own.sessionId;
    report.order_id = own.orderId;
    report.business_execution = Object.keys(report.checks).length ?
      'EXECUTED_UI_NO_WRITE' : own.sessionId ? 'PARTIAL' : 'NOT_EXECUTED';
    report.result = !failure && report.cleanup_pass && report.build_stable ?
      'PASSED' : report.cleanup_required ? 'INCONCLUSIVE' : 'FAILED';
    if (failure) report.error = redact(failure);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_014_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_014_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-014] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-014] Result: ' + JSON.stringify(report));
    await context.close();
    if (report.cleanup_required)
      throw new Error('CLEANUP REQUIRED: ' + report.cleanup_required);
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
