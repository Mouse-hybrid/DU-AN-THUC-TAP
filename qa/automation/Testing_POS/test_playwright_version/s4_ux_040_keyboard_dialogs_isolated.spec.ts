import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-040 | table and bill dialogs support keyboard focus and Escape',
  async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 desktop Chromium only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const tokens: Record<string, string> = {};
    const owned: Array<{code: string; tableId?: string; sessionId?: string;
      orderId?: string; itemId?: string}> = [{ code: 'Q3-1' }, { code: 'Q3-2' }];
    const [source, target] = owned;
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX040',
      test_ref: 'S4-UX-040', checked_at: new Date().toISOString(),
      scope: 'QA3 desktop merge and split dialogs: Enter opens, focus stays within dialog, accessible controls, Escape closes and focus returns; no UI write, both owned sessions/orders/tickets/audit unchanged and cleanup. No merge or split submission.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], dialogs: [], checks: {}, cleanup_pass: false,
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
      const result = await call(method, path, role, data);
      expect(result.http, method + ' ' + path + ' HTTP').toBe(http);
      return result.body;
    }
    const table = (x: typeof source) => checked('GET',
      '/api/v1/tables/' + x.tableId, 'waiter', 200);
    const order = (x: typeof source) => checked('GET',
      '/api/v1/orders/' + x.orderId, 'cashier', 200);
    const queue = async (x: typeof source, status?: string) => {
      const list = await checked('GET', '/api/v1/kitchen/queue' +
        (status ? '?status=' + status : ''), 'kitchen', 200) as any[];
      return list.filter(row => row.order_id === x.orderId);
    };
    const mergeAudit = async () => ({
      session: await checked('GET', '/api/v1/audit-logs?action=TABLE_MERGED&entity_id=' +
        source.sessionId + '&limit=100', 'admin', 200),
      order: await checked('GET', '/api/v1/audit-logs?action=ORDER_MERGED&entity_id=' +
        target.orderId + '&limit=100', 'admin', 200),
    });
    const splitAudit = () => checked('GET', '/api/v1/audit-logs?action=ORDER_SPLIT&entity_id=' +
      source.orderId + '&limit=100', 'admin', 200);
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
    const spec = await contract.json();
    expect(spec.paths?.['/api/v1/tables/{table_id}/merge']?.post).toBeTruthy();
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
    for (const x of owned) {
      const row = tables.find(t => t.code === x.code);
      test.skip(!row || row.status !== 'AVAILABLE',
        'PENDING_FIXTURE: Q3-1 and Q3-2 must be AVAILABLE');
      x.tableId = row.id;
    }
    const menu = await checked('GET', '/api/v1/menu?available_only=true',
      'waiter', 200) as any[];
    const starter = menu.find(row => row.is_available && row.station_id &&
      !row.has_modifiers && Number(row.price) > 0);
    test.skip(!starter, 'PENDING_FIXTURE: mapped menu item required');
    const uiWrites: string[] = report.ui_writes;
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        uiWrites.push(req.method() + ' ' + path);
    });

    async function cleanupOne(x: typeof source) {
      if (!x.sessionId) return;
      let t = await table(x);
      if (t.current_session?.id !== x.sessionId)
        throw new Error('CLEANUP REQUIRED: ' + x.code + ' session moved or ambiguous');
      if (!x.orderId) {
        const matches = (t.orders || []).filter((row: any) =>
          row.table_session_id === x.sessionId);
        if (matches.length > 1)
          throw new Error('CLEANUP REQUIRED: ' + x.code + ' order ambiguous');
        x.orderId = matches[0]?.id || (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: x.sessionId })).id;
      }
      let current = await order(x);
      if (current.table_session_id !== x.sessionId)
        throw new Error('CLEANUP REQUIRED: ' + x.code + ' order ownership changed');
      if (current.status === 'NEW') {
        if (!current.items.length)
          await checked('POST', '/api/v1/orders/' + x.orderId + '/items',
            'waiter', 201, { items: [{ menu_item_id: starter.id, quantity: 1,
              note: 'S4-UX-040 ' + x.code + ' cleanup' }] });
        await checked('POST', '/api/v1/orders/' + x.orderId +
          '/send-to-kitchen', 'waiter', 200);
      }
      current = await order(x);
      for (const item of current.items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'],
          ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'],
          ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order(x)).items.find((row: any) =>
            row.id === item.id)?.status === state)
            await checked('POST', '/api/v1/orders/' + x.orderId +
              '/items/' + item.id + '/' + action, role, 200);
        }
      }
      current = await order(x);
      if (current.items.some((item: any) => item.status !== 'SERVED'))
        throw new Error('CLEANUP REQUIRED: ' + x.code + ' item not served');
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await checked('POST', '/api/v1/orders/' + x.orderId +
          '/request-billing', 'waiter', 200);
      if ((await order(x)).status === 'BILLING')
        await checked('POST', '/api/v1/orders/' + x.orderId +
          '/pay', 'cashier', 200);
      if ((await order(x)).status === 'PAID')
        await checked('POST', '/api/v1/orders/' + x.orderId +
          '/close', 'cashier', 200);
      if ((await table(x)).status === 'CLEANING')
        await checked('POST', '/api/v1/tables/' + x.tableId +
          '/mark-clean', 'waiter', 200);
      t = await table(x);
      const final = await order(x);
      const done = await queue(x, 'DONE');
      const active = await queue(x);
      if (t.status !== 'AVAILABLE' || t.current_session ||
          final.status !== 'CLOSED' ||
          final.items.some((item: any) => item.status !== 'SERVED') ||
          done.length !== final.items.length || active.length)
        throw new Error('CLEANUP REQUIRED: ' + x.code + ' final mismatch');
    }
    async function snapshot() {
      return Promise.all(owned.map(async x => ({
        table: await table(x), order: await order(x), queue: await queue(x),
      })));
    }
    let failure: unknown;
    try {
      for (const x of owned) {
        x.sessionId = (await checked('POST', '/api/v1/tables/' + x.tableId +
          '/open-session', 'waiter', 201, { guest_count: 1 })).id;
        x.orderId = (await checked('POST', '/api/v1/orders', 'waiter',
          201, { table_session_id: x.sessionId })).id;
        const added = await checked('POST', '/api/v1/orders/' + x.orderId +
          '/items', 'waiter', 201, { items: [{ menu_item_id: starter.id,
            quantity: 1, note: 'S4-UX-040 ' + x.code + ' own' }] });
        x.itemId = added.items.find((row: any) =>
          row.note === 'S4-UX-040 ' + x.code + ' own')?.id;
        expect(x.itemId).toBeTruthy();
        await checked('POST', '/api/v1/orders/' + x.orderId +
          '/send-to-kitchen', 'waiter', 200);
      }
      const before = await snapshot();
      const auditBefore = await mergeAudit();
      const splitAuditBefore = await splitAudit();
      for (let index = 0; index < owned.length; index++) {
        expect(before[index].table.status).toBe('OCCUPIED');
        expect(before[index].table.current_session?.id).toBe(owned[index].sessionId);
        expect(before[index].order.table_session_id).toBe(owned[index].sessionId);
        expect(before[index].queue).toHaveLength(1);
      }
      report.tables = owned.map(x => ({ code: x.code,
        session_id: x.sessionId, order_id: x.orderId }));
      console.log('[S4-UX-040] Own Q3-1/Q3-2 occupied orders ' +
        source.orderId + ' / ' + target.orderId);
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto(base + '/tables/' + source.tableId,
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const mergeOpen = page.getByRole('button',
        { name: 'Gộp bàn vào bàn Q3-1' });
      await expect(mergeOpen).toBeVisible({ timeout: 15_000 });
      await mergeOpen.focus();
      await page.keyboard.press('Enter');
      const merge = page.getByRole('dialog', { name: 'Gộp bàn vào bàn Q3-1' });
      await expect(merge).toBeVisible();
      const targetChoice = merge.getByRole('checkbox', { name: /Q3-2/ });
      const mergeCancel = merge.getByRole('button',
        { name: 'Hủy thao tác', exact: true });
      await expect(targetChoice).toBeVisible();
      await expect(mergeCancel).toBeVisible();
      const mergeProbe: any = {
        kind: 'table_merge',
        initial_focus_inside: await merge.evaluate(dialog =>
          dialog.contains(document.activeElement)),
        named_controls: await targetChoice.count() === 1 &&
          await mergeCancel.count() === 1,
      };
      report.dialogs.push(mergeProbe);
      await targetChoice.focus();
      await page.keyboard.press('Tab');
      mergeProbe.tab_focus_inside = await merge.evaluate(dialog =>
        dialog.contains(document.activeElement));
      await testInfo.attach('S4_UX_040_merge_keyboard', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      await page.keyboard.press('Escape');
      await expect(merge).toBeHidden({ timeout: 5_000 });
      mergeProbe.escape_closed = true;
      mergeProbe.focus_returned = await mergeOpen.evaluate(button =>
        document.activeElement === button);

      await page.goto(base + '/tables/' + source.tableId + '/summary',
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const splitOpen = page.getByRole('button',
        { name: 'Tách bill', exact: true });
      await expect(splitOpen).toBeVisible({ timeout: 15_000 });
      await splitOpen.focus();
      await page.keyboard.press('Enter');
      const split = page.getByRole('dialog', { name: 'Tách bill' });
      await expect(split).toBeVisible();
      const splitCancel = split.getByRole('button',
        { name: 'Hủy thao tác', exact: true });
      const splitSubmit = split.getByRole('button',
        { name: 'Tách bill', exact: true });
      await expect(splitCancel).toBeVisible();
      await expect(splitSubmit).toBeVisible();
      const splitProbe: any = {
        kind: 'bill_split',
        initial_focus_inside: await split.evaluate(dialog =>
          dialog.contains(document.activeElement)),
        named_controls: await splitCancel.count() === 1 &&
          await splitSubmit.count() === 1,
      };
      report.dialogs.push(splitProbe);
      await splitCancel.focus();
      await page.keyboard.press('Shift+Tab');
      splitProbe.tab_focus_inside = await split.evaluate(dialog =>
        dialog.contains(document.activeElement));
      await testInfo.attach('S4_UX_040_split_keyboard', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      await page.keyboard.press('Escape');
      await expect(split).toBeHidden({ timeout: 5_000 });
      splitProbe.escape_closed = true;
      splitProbe.focus_returned = await splitOpen.evaluate(button =>
        document.activeElement === button);
      const after = await snapshot();
      const auditAfter = await mergeAudit();
      const splitAuditAfter = await splitAudit();
      const stable = (row: any) => ({
        table_status: row.table.status,
        session: row.table.current_session,
        order_id: row.order.id,
        order_session: row.order.table_session_id,
        order_status: row.order.status,
        subtotal: row.order.subtotal,
        items: row.order.items,
        version: row.order.current_version,
        tickets: row.queue.map((ticket: any) => ({
          id: ticket.id, order_id: ticket.order_id,
          order_item_id: ticket.order_item_id, status: ticket.status,
          station_id: ticket.station_id,
        })).sort((x: any, y: any) => x.id.localeCompare(y.id)),
      });
      report.checks = {
        merge_initial_focus: mergeProbe.initial_focus_inside,
        merge_named_controls: mergeProbe.named_controls,
        merge_tab_inside: mergeProbe.tab_focus_inside,
        merge_escape_and_focus_return: mergeProbe.escape_closed &&
          mergeProbe.focus_returned,
        split_initial_focus: splitProbe.initial_focus_inside,
        split_named_controls: splitProbe.named_controls,
        split_tab_inside: splitProbe.tab_focus_inside,
        split_escape_and_focus_return: splitProbe.escape_closed &&
          splitProbe.focus_returned,
        no_ui_business_write: uiWrites.length === 0,
        two_sessions_orders_tickets_unchanged: after.every((state, index) =>
          JSON.stringify(stable(state)) === JSON.stringify(stable(before[index]))),
        merge_audit_unchanged:
          JSON.stringify(auditAfter) === JSON.stringify(auditBefore),
        split_audit_unchanged:
          JSON.stringify(splitAuditAfter) === JSON.stringify(splitAuditBefore),
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Keyboard dialog UI/state mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    const cleanupErrors: string[] = [];
    for (const x of owned)
      try { await cleanupOne(x); }
      catch (error) { cleanupErrors.push(x.code + ': ' + redact(error)); }
    report.cleanup_pass = !cleanupErrors.length &&
      owned.every(x => !!x.sessionId && !!x.orderId);
    if (cleanupErrors.length) report.cleanup_required = cleanupErrors;
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === beforeBuild;
    report.business_execution = report.dialogs.length === 2 ? 'EXECUTED_UI_NO_WRITE' :
      owned.some(x => !!x.sessionId) ? 'PARTIAL' : 'NOT_EXECUTED';
    report.result = !failure && report.cleanup_pass && report.build_stable ?
      'PASSED' : cleanupErrors.length ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_UI_SELECTOR') ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_040_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_040_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-040] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-040] Result: ' + JSON.stringify(report));
    if (cleanupErrors.length) throw new Error('CLEANUP REQUIRED: ' + cleanupErrors.join('; '));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
