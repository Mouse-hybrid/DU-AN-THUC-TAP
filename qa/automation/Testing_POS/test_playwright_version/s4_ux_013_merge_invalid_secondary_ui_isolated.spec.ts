import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-013 | UI denies merging BILLING and CLEANING secondary tables',
  async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
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
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX013',
      test_ref: 'S4-UX-013', checked_at: new Date().toISOString(),
      scope: 'QA3 desktop UI attempts Q3-1 merge with Q3-2 in BILLING and CLEANING; each attempt guarded, sessions/orders/tickets/merge audit unchanged; owned cleanup. No mobile UI.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], scenarios: [], checks: {}, cleanup_pass: false,
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
      table: await checked('GET', '/api/v1/audit-logs?action=TABLE_MERGED&entity_id=' +
        source.sessionId + '&limit=100', 'admin', 200),
      order: await checked('GET', '/api/v1/audit-logs?action=ORDER_MERGED&entity_id=' +
        target.orderId + '&limit=100', 'admin', 200),
    });
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
      if (t.current_session?.id !== x.sessionId &&
          !(t.status === 'CLEANING' && !t.current_session && x.orderId))
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
              note: 'S4-UX-013 ' + x.code + ' cleanup' }] });
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
        table: await table(x), order: await order(x),
        active: await queue(x), done: await queue(x, 'DONE'),
      })));
    }
    const stableTable = (x: any) => ({
      status: x.status, session: x.current_session,
      merged_into_table_id: x.merged_into_table_id,
    });
    const stableOrder = (x: any) => ({
      id: x.id, table_session_id: x.table_session_id,
      status: x.status, subtotal: x.subtotal,
      items: x.items, current_version: x.current_version,
    });
    const stableTickets = (x: any) => [...x.active, ...x.done]
      .map((row: any) => ({
        id: row.id, order_id: row.order_id, order_item_id: row.order_item_id,
        status: row.status, table_code: row.table_code, station_id: row.station_id,
      })).sort((a: any, b: any) => a.id.localeCompare(b.id));
    async function attempt(state: 'BILLING' | 'CLEANING') {
      const before = await snapshot();
      const auditBefore = await mergeAudit();
      expect(before[0].table.status).toBe('OCCUPIED');
      expect(before[1].table.status).toBe(state);
      expect(before[0].table.current_session?.id).toBe(source.sessionId);
      expect(before[1].table.current_session?.id).toBe(
        state === 'BILLING' ? target.sessionId : undefined);
      expect(before[1].order.status).toBe(
        state === 'BILLING' ? 'BILLING' : 'PAID');
      const countBefore = uiWrites.length;
      await page.goto(base + '/tables/' + source.tableId,
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const open = page.getByRole('button', { name: 'Gộp bàn vào bàn Q3-1' });
      await expect(open).toBeVisible({ timeout: 15_000 });
      await open.click();
      const dialog = page.getByRole('dialog', { name: 'Gộp bàn vào bàn Q3-1' });
      await expect(dialog).toBeVisible();
      const choice = dialog.getByRole('checkbox', { name: /Q3-2/ });
      const scenario: any = { state, target_listed:
        await dialog.getByText('Bàn Q3-2').count() > 0, ui_merge_http: null };
      await testInfo.attach('S4_UX_013_' + state + '_dialog', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      if (!await choice.count() || !await choice.isVisible())
        scenario.ui_guard = 'target_unselectable';
      else if (!await choice.isEnabled())
        scenario.ui_guard = 'target_disabled';
      else {
        await choice.check();
        const submit = dialog.getByRole('button',
          { name: 'Gộp bàn', exact: true });
        if (!await submit.isEnabled())
          scenario.ui_guard = 'submit_disabled';
        else {
          const [response] = await Promise.all([
            page.waitForResponse(row => row.request().method() === 'POST' &&
              new URL(row.url()).pathname ===
                '/api/v1/tables/' + source.tableId + '/merge',
              { timeout: 20_000 }),
            submit.click(),
          ]);
          scenario.ui_merge_http = response.status();
          scenario.ui_guard = 'server';
          expect(response.status()).toBe(409);
          await expect(page.getByText(/không thể gộp|xung đột|không hợp lệ|đang thanh toán|đang dọn/i)
            .first()).toBeVisible({ timeout: 5_000 });
        }
      }
      scenario.ui_writes = uiWrites.slice(countBefore);
      const after = await snapshot();
      const auditAfter = await mergeAudit();
      scenario.checks = {
        rejected: !!scenario.ui_guard &&
          (scenario.ui_guard !== 'server' || scenario.ui_merge_http === 409),
        ui_writes_as_expected: scenario.ui_guard === 'server' ?
          scenario.ui_writes.length === 1 &&
          scenario.ui_writes[0] ===
            'POST /api/v1/tables/' + source.tableId + '/merge' :
          scenario.ui_writes.length === 0,
        sessions_unchanged: after.every((row, index) =>
          JSON.stringify(stableTable(row.table)) ===
            JSON.stringify(stableTable(before[index].table))),
        orders_unchanged: after.every((row, index) =>
          JSON.stringify(stableOrder(row.order)) ===
            JSON.stringify(stableOrder(before[index].order))),
        tickets_unchanged: after.every((row, index) =>
          JSON.stringify(stableTickets(row)) ===
            JSON.stringify(stableTickets(before[index]))),
        merge_audit_unchanged: JSON.stringify(auditAfter) ===
          JSON.stringify(auditBefore),
      };
      report.scenarios.push(scenario);
      if (!Object.values(scenario.checks).every(Boolean))
        throw new Error(state + ' UI/state mismatch: ' +
          JSON.stringify(scenario.checks));
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
            quantity: 1, note: 'S4-UX-013 ' + x.code + ' own' }] });
        x.itemId = added.items.find((row: any) =>
          row.note === 'S4-UX-013 ' + x.code + ' own')?.id;
        expect(x.itemId).toBeTruthy();
        await checked('POST', '/api/v1/orders/' + x.orderId +
          '/send-to-kitchen', 'waiter', 200);
      }
      report.tables = owned.map(x => ({ code: x.code,
        session_id: x.sessionId, order_id: x.orderId }));
      console.log('[S4-UX-013] Own Q3-1/Q3-2 orders ' +
        source.orderId + ' / ' + target.orderId);
      for (const [state, action, role] of [
        ['SENT', 'start-cooking', 'kitchen'],
        ['PREPARING', 'mark-ready', 'kitchen'],
        ['READY', 'pickup', 'waiter'],
        ['PICKED_UP', 'served', 'waiter'],
      ] as const) {
        expect((await order(target)).items.find((item: any) =>
          item.id === target.itemId)?.status).toBe(state);
        await checked('POST', '/api/v1/orders/' + target.orderId +
          '/items/' + target.itemId + '/' + action, role, 200);
      }
      await checked('POST', '/api/v1/orders/' + target.orderId +
        '/request-billing', 'waiter', 200);
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await attempt('BILLING');
      await checked('POST', '/api/v1/orders/' + target.orderId +
        '/pay', 'cashier', 200);
      await attempt('CLEANING');
      report.checks = {
        billing_rejected_without_mutation:
          Object.values(report.scenarios[0].checks).every(Boolean),
        cleaning_rejected_without_mutation:
          Object.values(report.scenarios[1].checks).every(Boolean),
      };
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
    report.business_execution = report.scenarios.length === 2 ? 'EXECUTED' :
      owned.some(x => !!x.sessionId) ? 'PARTIAL' : 'NOT_EXECUTED';
    report.result = !failure && report.cleanup_pass && report.build_stable ?
      'PASSED' : cleanupErrors.length ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_UI_SELECTOR') ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_013_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_013_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-013] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-013] Result: ' + JSON.stringify(report));
    if (cleanupErrors.length) throw new Error('CLEANUP REQUIRED: ' + cleanupErrors.join('; '));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
