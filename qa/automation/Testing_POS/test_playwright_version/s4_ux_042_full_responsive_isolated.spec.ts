import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-042 | table, KDS, SENT/SERVED/PAID responsive at three widths',
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
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX042FULL',
      test_ref: 'S4-UX-042', checked_at: new Date().toISOString(),
      scope: 'QA3 owned 100,000 VND order: table, KDS, SENT/SERVED/PAID summary at 375x812/768x1024/1366x768; readable information, API reconciliation and owned cleanup. No UI business write.',
      case_coverage: 'TABLE_KDS_SENT_SERVED_PAID_RESPONSIVE',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], viewports: [], sent_viewports: [], paid_viewports: [], checks: {}, cleanup_pass: false,
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
    const keep = menu.find(row => row.id && row.is_available &&
      row.station_id && !row.has_modifiers && Number(row.price) === 50_000);
    test.skip(!keep, 'PENDING_FIXTURE: mapped 50,000 VND item required');
    const move = keep;
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
      if (t.current_session?.id !== own.sessionId &&
          !(t.status === 'CLEANING' && !t.current_session && own.orderId &&
            (await order()).table_session_id === own.sessionId))
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
              quantity: 1, note: 'S4-UX-042 cleanup' }] });
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

    async function unobscured(locator: any, fullBox = false) {
      await expect(locator).toBeVisible({ timeout: 12_000 });
      await locator.scrollIntoViewIfNeeded();
      return locator.evaluate((element: Element, requireFullBox: boolean) => {
        const box = element.getBoundingClientRect();
        const inView = (rect: DOMRect) => rect.width > 0 && rect.height > 0 &&
          rect.left >= -1 && rect.right <= window.innerWidth + 1 &&
          rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
        const hitInside = (rect: DOMRect) => {
          const hit = document.elementFromPoint(rect.left + rect.width / 2,
            rect.top + rect.height / 2);
          return !!hit && element.contains(hit);
        };
        if (requireFullBox) return inView(box) && hitInside(box);
        const range = document.createRange();
        range.selectNodeContents(element);
        const textRects = Array.from(range.getClientRects());
        return textRects.length > 0 &&
          textRects.every(rect => inView(rect) && hitInside(rect));
      }, fullBox);
    }
    try {
      own.sessionId = (await checked('POST', '/api/v1/tables/' +
        own.tableId + '/open-session', 'waiter', 201, { guest_count: 2 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'waiter',
        201, { table_session_id: own.sessionId })).id;
      const added = await checked('POST', '/api/v1/orders/' + own.orderId +
        '/items', 'waiter', 201, { items: [
          { menu_item_id: keep.id, quantity: 1, note: 'S4-UX-042 keep' },
          { menu_item_id: move.id, quantity: 1, note: 'S4-UX-042 move' },
        ] });
      own.itemIds = ['S4-UX-042 keep', 'S4-UX-042 move'].map(note =>
        added.items.find((item: any) => item.note === note)?.id);
      expect(own.itemIds.every(Boolean)).toBe(true);
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/send-to-kitchen', 'waiter', 200);

      const expectedTotal = Number((await order()).subtotal);
      expect(expectedTotal, 'two 50,000 VND lines').toBe(100_000);
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(base + '/tables', { timeout: 15_000 });
      for (const { width, height } of [
        { width: 375, height: 812 },
        { width: 768, height: 1024 },
        { width: 1366, height: 768 },
      ]) {
        await page.setViewportSize({ width, height });
        const probe: any = { width, height };
        report.sent_viewports.push(probe);
        await page.goto('/tables', { waitUntil: 'domcontentloaded' });
        const tile = page.getByRole('button', { name: /^Bàn Q3-1,/ });
        await expect(tile).toContainText('Q3-1');
        probe.table = await unobscured(tile, true);
        await testInfo.attach('S4_UX_042_' + width + '_table', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
        await page.goto('/tables/' + own.tableId + '/summary',
          { waitUntil: 'domcontentloaded' });
        const sentStatus = page.locator('.nova-order-header-actions .nova-status-badge');
        await expect(sentStatus).toHaveText('Đã gửi bếp');
        const sentTotal = page.locator('.nova-order-total').filter({ hasText: 'Tạm tính' })
          .locator('strong');
        await expect(sentTotal).toContainText('100.000');
        probe.sent_summary = await unobscured(sentStatus) &&
          await unobscured(sentTotal) &&
          await unobscured(page.getByRole('button',
            { name: 'Yêu cầu thanh toán đơn', exact: true }), true);
        await testInfo.attach('S4_UX_042_' + width + '_sent', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
        await page.goto('/kitchen', { waitUntil: 'domcontentloaded' });
        const ticket = page.locator('.nova-kds-ticket')
          .filter({ hasText: 'S4-UX-042 keep' });
        await expect(ticket).toHaveCount(1, { timeout: 12_000 });
        await expect(ticket.locator('.nova-kds-table')).toContainText('Q3-1');
        probe.kds = await unobscured(ticket.locator('.nova-kds-note'));
        await testInfo.attach('S4_UX_042_' + width + '_kds', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
      }
      for (const itemId of own.itemIds!)
        for (const [action, role] of [
          ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
          ['pickup', 'waiter'], ['served', 'waiter'],
        ] as const)
          await checked('POST', '/api/v1/orders/' + own.orderId +
            '/items/' + itemId + '/' + action, role, 200);
      console.log('[S4-UX-042] Own Q3-1 session ' + own.sessionId +
        ', order ' + own.orderId);
      const before = {
        table: await table(), order: await order(),
        tickets: await queue('DONE'), splitAudit: await audit(),
      };
      expect(before.order.items).toHaveLength(2);
      expect(before.tickets).toHaveLength(2);
      const expectedTotalConfirmed = Number(before.order.subtotal);
      expect(expectedTotalConfirmed).toBe(expectedTotal);
      for (const { width, height } of [
        { width: 375, height: 812 },
        { width: 768, height: 1024 },
        { width: 1366, height: 768 },
      ]) {
        await page.setViewportSize({ width, height });
        await page.goto('/tables/' + own.tableId + '/summary',
          { waitUntil: 'domcontentloaded', timeout: 20_000 });
        const heading = page.getByRole('heading', { name: 'Bàn Q3-1', exact: true });
        const status = page.locator('.nova-order-header-actions .nova-status-badge');
        const total = page.locator('.nova-order-total').filter({ hasText: 'Tạm tính' })
          .locator('strong');
        const primary = page.getByRole('button',
          { name: 'Yêu cầu thanh toán đơn', exact: true });
        const elements = { heading, status, total, primary };
        const probe: any = { width, height, items: {} };
        report.viewports.push(probe);
        for (const [key, locator] of Object.entries(elements)) {
          await expect(locator, width + 'px ' + key).toBeVisible({ timeout: 15_000 });
          await locator.scrollIntoViewIfNeeded();
          probe.items[key] = await locator.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const textRects = Array.from(range.getClientRects());
            const textVisible = textRects.length > 0 && textRects.every(line =>
              line.width > 0 && line.height > 0 &&
              line.left >= -1 && line.right <= window.innerWidth + 1 &&
              line.top >= -1 && line.bottom <= window.innerHeight + 1 &&
              [0.1, 0.5, 0.9].every(fraction => {
                const hit = document.elementFromPoint(
                  line.left + line.width * fraction,
                  line.top + line.height / 2);
                return !!hit && element.contains(hit);
              }));
            return {
              text: element.textContent?.trim() || '',
              left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
              viewport_width: window.innerWidth, viewport_height: window.innerHeight,
              box_unclipped: rect.width > 0 && rect.height > 0 &&
                rect.left >= -1 && rect.right <= window.innerWidth + 1 &&
                rect.top >= -1 && rect.bottom <= window.innerHeight + 1 &&
                (element.clientWidth === 0 ||
                  element.scrollWidth <= element.clientWidth + 1),
              text_visible: textVisible,
              text_rects: textRects.map(line => ({
                left: line.left, right: line.right,
                top: line.top, bottom: line.bottom,
              })),
            };
          });
        }
        probe.page_scroll_width = await page.evaluate(() =>
          document.documentElement.scrollWidth);
        probe.server_total = expectedTotal;
        probe.rendered_total = Number(probe.items.total.text.replace(/\D/g, ''));
        probe.table_matches = probe.items.heading.text === 'Bàn Q3-1';
        probe.status_matches = probe.items.status.text === 'Đã phục vụ';
        probe.total_matches = probe.rendered_total === expectedTotal;
        probe.elements_readable = Object.values(probe.items).every((item: any) =>
          item.text_visible && item.text.length > 0) &&
          probe.items.primary.box_unclipped;
        await testInfo.attach('S4_UX_042_' + width + '_summary', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
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
        phone_375_readable: report.viewports[0]?.elements_readable === true &&
          report.viewports[0]?.table_matches === true &&
          report.viewports[0]?.status_matches === true &&
          report.viewports[0]?.total_matches === true,
        tablet_768_readable: report.viewports[1]?.elements_readable === true &&
          report.viewports[1]?.table_matches === true &&
          report.viewports[1]?.status_matches === true &&
          report.viewports[1]?.total_matches === true,
        desktop_1366_readable: report.viewports[2]?.elements_readable === true &&
          report.viewports[2]?.table_matches === true &&
          report.viewports[2]?.status_matches === true &&
          report.viewports[2]?.total_matches === true,
        no_ui_business_write: uiWrites.length === 0,
        table_unchanged: JSON.stringify(stableTable(after.table)) ===
          JSON.stringify(stableTable(before.table)),
        order_unchanged: JSON.stringify(stableOrder(after.order)) ===
          JSON.stringify(stableOrder(before.order)),
        tickets_unchanged: JSON.stringify(stableTickets(after.tickets)) ===
          JSON.stringify(stableTickets(before.tickets)),
        audit_unchanged: JSON.stringify(after.splitAudit) ===
          JSON.stringify(before.splitAudit),
      };

      report.checks.sent_table_kds_summary = report.sent_viewports.length === 3 &&
        report.sent_viewports.every((probe: any) =>
          probe.table === true && probe.sent_summary === true && probe.kds === true);
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/request-billing', 'waiter', 200);
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/pay', 'cashier', 200);
      expect((await order()).status).toBe('PAID');
      await page.getByRole('button',
        { name: 'Làm mới tóm tắt đơn', exact: true }).click();
      const paidStatus = page.locator('.nova-order-header-actions .nova-status-badge');
      await expect(paidStatus).toHaveText('Đã thanh toán', { timeout: 12_000 });
      for (const { width, height } of [
        { width: 375, height: 812 },
        { width: 768, height: 1024 },
        { width: 1366, height: 768 },
      ]) {
        await page.setViewportSize({ width, height });
        const paidTotal = page.locator('.nova-order-total').filter({ hasText: 'Tạm tính' })
          .locator('strong');
        await expect(paidTotal).toContainText('100.000');
        const back = page.getByRole('link', { name: 'Về sơ đồ bàn' });
        report.paid_viewports.push({
          width, height, status: await unobscured(paidStatus),
          total: await unobscured(paidTotal),
          action: await unobscured(back, true),
          page_scroll_width: await page.evaluate(() =>
            document.documentElement.scrollWidth),
        });
        await testInfo.attach('S4_UX_042_' + width + '_paid', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
      }
      report.checks.paid_summary_readable = report.paid_viewports.length === 3 &&
        report.paid_viewports.every((probe: any) =>
          probe.status === true && probe.total === true && probe.action === true);
      report.checks.no_ui_business_write = uiWrites.length === 0;
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Summary responsive UI/state mismatch: ' +
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
    const name = 'S4_UX_042_FULL_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_042_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-042] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-042] Result: ' + JSON.stringify(report));
    await context.close();
    if (report.cleanup_required)
      throw new Error('CLEANUP REQUIRED: ' + report.cleanup_required);
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
