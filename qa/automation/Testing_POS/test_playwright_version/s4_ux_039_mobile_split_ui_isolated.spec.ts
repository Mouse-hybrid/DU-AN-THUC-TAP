import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-039 | mobile split button and dialog remain usable',
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
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX039',
      test_ref: 'S4-UX-039', checked_at: new Date().toISOString(),
      scope: 'QA3 owned two SERVED items: 375px and 768px summary split button is visible and clickable without overlay; split dialog fits horizontally, cancel works, no split write; bill, tickets, audit unchanged and owned cleanup.',
      case_coverage: 'MOBILE_SPLIT_VISIBILITY_AND_CANCEL_ONLY',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], viewports: [], checks: {}, cleanup_pass: false,
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
              quantity: 1, note: 'S4-UX-039 cleanup' }] });
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
          { menu_item_id: keep.id, quantity: 1, note: 'S4-UX-039 keep' },
          { menu_item_id: move.id, quantity: 1, note: 'S4-UX-039 move' },
        ] });
      own.itemIds = ['S4-UX-039 keep', 'S4-UX-039 move'].map(note =>
        added.items.find((item: any) => item.note === note)?.id);
      expect(own.itemIds.every(Boolean)).toBe(true);
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/send-to-kitchen', 'waiter', 200);
      // The current quantity split dialog is exposed for served items.
      for (const itemId of own.itemIds!)
        for (const [action, role] of [
          ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
          ['pickup', 'waiter'], ['served', 'waiter'],
        ] as const)
          await checked('POST', '/api/v1/orders/' + own.orderId +
            '/items/' + itemId + '/' + action, role, 200);
      console.log('[S4-UX-039] Own Q3-1 session ' + own.sessionId +
        ', order ' + own.orderId);
      const before = {
        table: await table(), order: await order(),
        tickets: await queue('DONE'), splitAudit: await audit(),
      };
      expect(before.order.items).toHaveLength(2);
      expect(before.tickets).toHaveLength(2);
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      for (const width of [375, 768]) {
        await page.setViewportSize({ width, height: 812 });
        await page.goto('/tables/' + own.tableId + '/summary',
          { waitUntil: 'domcontentloaded', timeout: 20_000 });
        const split = page.getByRole('button', { name: 'Tách bill', exact: true });
        await expect(split).toBeVisible({ timeout: 15_000 });
        await split.scrollIntoViewIfNeeded();
        const hit = await split.evaluate(button => {
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y);
          return {
            button_x: rect.left, button_right: rect.right,
            button_y: rect.top, button_bottom: rect.bottom,
            hit_button: !!target && button.contains(target),
            viewport_width: window.innerWidth,
            viewport_height: window.innerHeight,
          };
        });
        const probe: any = { width, hit };
        report.viewports.push(probe);
        if (!(hit.button_x >= 0 && hit.button_right <= width &&
              hit.button_y >= 0 && hit.button_bottom <= 812 && hit.hit_button))
          throw new Error('MOBILE_SPLIT_BUTTON_OBSCURED: ' + JSON.stringify(probe));
        await split.click({ timeout: 5_000 });
        const dialog = page.getByRole('dialog', { name: 'Tách bill' });
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await expect(dialog.getByTestId('split-row')).toHaveCount(2);
        const box = await dialog.boundingBox();
        probe.dialog = box && {
          x: box.x, y: box.y, width: box.width, height: box.height,
          horizontally_visible: box.x >= -1 && box.x + box.width <= width + 1,
        };
        await testInfo.attach('S4_UX_039_' + width + '_split_dialog', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
        if (!probe.dialog?.horizontally_visible)
          throw new Error('MOBILE_SPLIT_DIALOG_CLIPPED: ' + JSON.stringify(probe));
        const cancel = dialog.getByRole('button',
          { name: 'Hủy thao tác', exact: true });
        await expect(cancel).toBeVisible();
        await cancel.click({ timeout: 5_000 });
        await expect(dialog).toBeHidden();
        probe.cancel_closed = true;
      }
      const after = {
        table: await table(), order: await order(),
        tickets: await queue('DONE'), splitAudit: await audit(),
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
        mobile_375_button_and_dialog: report.viewports[0]?.cancel_closed === true &&
          report.viewports[0]?.hit?.hit_button === true &&
          report.viewports[0]?.dialog?.horizontally_visible === true,
        tablet_768_button_and_dialog: report.viewports[1]?.cancel_closed === true &&
          report.viewports[1]?.hit?.hit_button === true &&
          report.viewports[1]?.dialog?.horizontally_visible === true,
        no_split_post: !uiWrites.some(path =>
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
        throw new Error('Mobile split UI/state mismatch: ' +
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
    const name = 'S4_UX_039_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_039_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-039] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-039] Result: ' + JSON.stringify(report));
    await context.close();
    if (report.cleanup_required)
      throw new Error('CLEANUP REQUIRED: ' + report.cleanup_required);
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
