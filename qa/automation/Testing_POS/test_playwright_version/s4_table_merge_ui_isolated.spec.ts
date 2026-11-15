import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('PF-S4-TABLE-MERGE-UI | QA3 desktop merges two occupied tables',
  async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium fixture only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
    expect(expected).toMatch(/^[a-f0-9]{40}$/);
    const runId = 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4MERGEUI';
    const version = async () => {
      const response = await request.get(base + '/version', { timeout: 15_000 });
      expect(response.status()).toBe(200);
      return (await response.json()).commit as string;
    };
    const build = await version();
    test.skip(build !== expected, `PENDING_BUILD: expected ${expected}, staging ${build}`);
    const tokens: Record<string, string> = {};
    async function call(method: 'GET' | 'POST', path: string, role: string, data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: { Authorization: `Bearer ${tokens[role]}`,
          ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) },
        ...(data ? { data } : {}), timeout: 15_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST', path: string, role: string,
      status: number, data?: object): Promise<any> {
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
    const primary = { code: 'Q3-1', tableId: tables.find(row => row.code === 'Q3-1')?.id,
      sessionId: undefined as string | undefined, orderId: undefined as string | undefined,
      itemId: undefined as string | undefined, ticketId: undefined as string | undefined };
    const secondary = { code: 'Q3-2', tableId: tables.find(row => row.code === 'Q3-2')?.id,
      sessionId: undefined as string | undefined, orderId: undefined as string | undefined,
      itemId: undefined as string | undefined, ticketId: undefined as string | undefined };
    test.skip(!primary.tableId || !secondary.tableId ||
      tables.find(row => row.id === primary.tableId)?.status !== 'AVAILABLE' ||
      tables.find(row => row.id === secondary.tableId)?.status !== 'AVAILABLE',
      'PENDING_FIXTURE: Q3-1/Q3-2 must be AVAILABLE');
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 'cashier', 200) as any[];
    const menuId = menu.find(row => row.is_available && row.station_id && !row.has_modifiers)?.id;
    test.skip(!menuId, 'PENDING_FIXTURE: mapped menu item required');
    type OwnTable = typeof primary;
    const table = (x: OwnTable) => checked('GET', `/api/v1/tables/${x.tableId}`, 'waiter', 200);
    const order = (x: OwnTable) => checked('GET', `/api/v1/orders/${x.orderId}`, 'cashier', 200);
    const queue = async (status?: string) => {
      const rows = await checked('GET', `/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`,
        'kitchen', 200) as any[];
      return rows.filter(row => [primary.orderId, secondary.orderId].includes(row.order_id));
    };
    const uiWrites: string[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login') uiWrites.push(`${req.method()} ${path}`);
    });
    const report: any = { run_id: runId, test_ref: 'PF-S4-TABLE-MERGE-UI',
      checked_at: new Date().toISOString(), staging_commit: build, build_before: build,
      scope: 'QA3 desktop UI merges two occupied tables; API session/order/ticket/audit verification and owned cleanup',
      case_coverage: 'UI_TWO_OCCUPIED_TABLES_ONLY', project: testInfo.project.name,
      secrets_recorded: false, ui_merge_http: null, checks: {}, cleanup_pass: false };
    async function discoverOrder(x: OwnTable) {
      if (x.orderId) return;
      const current = await table(x);
      if (current.current_session?.id !== x.sessionId)
        throw new Error(`CLEANUP REQUIRED: ${x.code} session moved`);
      const rows = (current.orders || []).filter((row: any) => row.table_session_id === x.sessionId);
      if (rows.length === 1) x.orderId = rows[0].id;
      else if (!rows.length) x.orderId = (await checked('POST', '/api/v1/orders',
        'waiter', 201, { table_session_id: x.sessionId })).id;
      else throw new Error(`CLEANUP REQUIRED: ${x.code} order ownership ambiguous`);
    }
    async function finishOrder(x: OwnTable) {
      if (!x.sessionId) return;
      await discoverOrder(x);
      let current = await order(x);
      if (current.table_session_id !== x.sessionId)
        throw new Error(`CLEANUP REQUIRED: ${x.code} order/session mismatch`);
      if (current.status === 'CLOSED') return;
      if (!current.items?.length && current.status === 'NEW') {
        await checked('POST', `/api/v1/orders/${x.orderId}/items`, 'waiter', 201,
          { items: [{ menu_item_id: menuId, quantity: 1, note: 'PF-S4-MERGE cleanup' }] });
        current = await order(x);
      }
      if (!current.items?.length) throw new Error(`CLEANUP REQUIRED: ${x.code} empty order`);
      if (current.items.some((item: any) => item.status === 'CREATED'))
        await checked('POST', `/api/v1/orders/${x.orderId}/send-to-kitchen`, 'waiter', 200);
      for (const item of (await order(x)).items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order(x)).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', `/api/v1/orders/${x.orderId}/items/${item.id}/${action}`, role, 200);
        }
        expect((await order(x)).items.find((row: any) => row.id === item.id)?.status).toBe('SERVED');
      }
      if (!['BILLING', 'PAID', 'CLOSED'].includes((await order(x)).status))
        await checked('POST', `/api/v1/orders/${x.orderId}/request-billing`, 'waiter', 200);
      if (!['PAID', 'CLOSED'].includes((await order(x)).status))
        await checked('POST', `/api/v1/orders/${x.orderId}/pay`, 'cashier', 200);
      if ((await order(x)).status !== 'CLOSED')
        await checked('POST', `/api/v1/orders/${x.orderId}/close`, 'cashier', 200);
    }
    async function cleanup() {
      if (!primary.sessionId && !secondary.sessionId) return;
      console.log(`[S4-MERGE-UI] Cleanup starts: Q3-1 ${primary.sessionId}, Q3-2 ${secondary.sessionId}`);
      const first = await table(primary), second = await table(secondary);
      const merged = second.status === 'MERGED' &&
        second.merged_into_table_id === primary.tableId;
      if (merged) {
        if (first.current_session?.id !== primary.sessionId || second.current_session ||
          !primary.orderId || !secondary.orderId)
          throw new Error('CLEANUP REQUIRED: merged session/order ownership ambiguous');
        const sourceOrder = await order(secondary), master = await order(primary);
        if (sourceOrder.status !== 'CLOSED' || sourceOrder.items?.length ||
          master.table_session_id !== primary.sessionId ||
          !master.items.some((item: any) => item.id === secondary.itemId))
          throw new Error('CLEANUP REQUIRED: merged order/item ownership mismatch');
        await finishOrder(primary);
      } else {
        for (const x of [primary, secondary]) {
          if (!x.sessionId) continue;
          if ((await table(x)).current_session?.id !== x.sessionId)
            throw new Error(`CLEANUP REQUIRED: ${x.code} session moved unexpectedly`);
          await finishOrder(x);
        }
      }
      for (const x of [primary, secondary]) {
        const current = await table(x);
        if (current.status === 'CLEANING')
          await checked('POST', `/api/v1/tables/${x.tableId}/mark-clean`, 'waiter', 200);
      }
      const endPrimary = await table(primary), endSecondary = await table(secondary);
      expect(endPrimary.status).toBe('AVAILABLE');
      expect(endSecondary.status).toBe('AVAILABLE');
      expect(endPrimary.current_session).toBeNull();
      expect(endSecondary.current_session).toBeNull();
      expect(endSecondary.merged_into_table_id).toBeFalsy();
      const orders = [];
      for (const x of [primary, secondary]) if (x.orderId) {
        const current = await order(x);
        expect(current.status).toBe('CLOSED');
        expect(current.items.every((item: any) => item.status === 'SERVED')).toBe(true);
        orders.push(current);
      }
      expect(await queue()).toHaveLength(0);
      expect(await queue('DONE')).toHaveLength(orders.flatMap(row => row.items).length);
      console.log(`[S4-MERGE-UI] Cleanup passed: Q3-1/Q3-2 AVAILABLE, orders CLOSED`);
    }
    let bodyError: unknown, cleanupError: unknown;
    try {
      for (const x of [primary, secondary]) {
        x.sessionId = (await checked('POST', `/api/v1/tables/${x.tableId}/open-session`,
          'waiter', 201, { guest_count: 1 })).id;
        x.orderId = (await checked('POST', '/api/v1/orders', 'cashier', 201,
          { table_session_id: x.sessionId })).id;
        const added = await checked('POST', `/api/v1/orders/${x.orderId}/items`, 'cashier', 201,
          { items: [{ menu_item_id: menuId, quantity: 1,
            note: `PF-S4-MERGE own ${x.code}` }] });
        x.itemId = added.items?.find((item: any) => item.note === `PF-S4-MERGE own ${x.code}`)?.id;
        expect(x.itemId).toBeTruthy();
        await checked('POST', `/api/v1/orders/${x.orderId}/send-to-kitchen`, 'waiter', 200);
      }
      console.log(`[S4-MERGE-UI] Own fixture: Q3-1 ${primary.sessionId}/${primary.orderId}, Q3-2 ${secondary.sessionId}/${secondary.orderId}`);
      const tickets = await queue();
      expect(tickets).toHaveLength(2);
      primary.ticketId = tickets.find((row: any) => row.order_item_id === primary.itemId)?.id;
      secondary.ticketId = tickets.find((row: any) => row.order_item_id === secondary.itemId)?.id;
      expect(primary.ticketId).toBeTruthy();
      expect(secondary.ticketId).toBeTruthy();
      const before = [await order(primary), await order(secondary)];
      const beforeSubtotal = before.reduce((sum, row) => sum + Math.round(Number(row.subtotal) * 100), 0);

      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click({ timeout: 10_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto(`${base}/tables/${primary.tableId}`,
        { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByRole('button', { name: 'Gộp bàn vào bàn Q3-1' }).click({ timeout: 10_000 });
      const dialog = page.getByRole('dialog', { name: 'Gộp bàn vào bàn Q3-1' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Bàn Q3-2')).toBeVisible();
      const target = dialog.getByRole('checkbox', { name: /Q3-2/ });
      await expect(target, 'select only owned Q3-2').toHaveCount(1);
      await target.check({ timeout: 10_000 });
      await expect(dialog.locator('input[name="move-target"]:checked')).toHaveCount(1);
      const submit = dialog.getByRole('button', { name: 'Gộp bàn', exact: true });
      await expect(submit).toBeEnabled();
      const [response] = await Promise.all([
        page.waitForResponse(res => res.request().method() === 'POST' &&
          new URL(res.url()).pathname === `/api/v1/tables/${primary.tableId}/merge`,
        { timeout: 20_000 }),
        submit.click({ timeout: 10_000 }),
      ]);
      report.ui_merge_http = response.status();
      expect(response.status()).toBe(200);
      const result = await response.json();
      const first = await table(primary), second = await table(secondary);
      const master = await order(primary), source = await order(secondary);
      const afterTickets = await queue();
      const masterAudit = await checked('GET',
        `/api/v1/audit-logs?action=TABLE_MERGED&entity_id=${primary.sessionId}`,
        'admin', 200) as any[];
      const sourceAudit = await checked('GET',
        `/api/v1/audit-logs?action=ORDER_MERGED&entity_id=${secondary.orderId}`,
        'admin', 200) as any[];
      report.checks = {
        one_ui_merge_write: uiWrites.length === 1 &&
          uiWrites[0] === `POST /api/v1/tables/${primary.tableId}/merge`,
        master_session: first.current_session?.id === primary.sessionId &&
          first.current_session?.guest_count === 2 && !second.current_session &&
          result.table_session_id === primary.sessionId,
        secondary_merged: second.status === 'MERGED' &&
          second.merged_into_table_id === primary.tableId,
        one_master_order: master.items.length === 2 &&
          [primary.itemId, secondary.itemId].every(id => master.items.some((item: any) => item.id === id)) &&
          Math.round(Number(master.subtotal) * 100) === beforeSubtotal &&
          source.status === 'CLOSED' && source.items.length === 0 &&
          result.order_id === primary.orderId,
        tickets_follow_items: afterTickets.length === 2 &&
          [primary.ticketId, secondary.ticketId].every(id => afterTickets.some((row: any) => row.id === id)) &&
          afterTickets.every((row: any) => row.order_id === primary.orderId && row.table_code === primary.code),
        audit_merge_once: masterAudit.filter(row => row.action === 'TABLE_MERGED' &&
          row.entity_id === primary.sessionId).length === 1,
        source_history: sourceAudit.filter(row => row.action === 'ORDER_MERGED' &&
          row.entity_id === secondary.orderId && row.payload?.into_order_id === primary.orderId).length === 1,
      };
      expect(Object.values(report.checks).every(Boolean), JSON.stringify(report.checks)).toBe(true);
      console.log(`[S4-MERGE-UI] UI submit PASS: HTTP 200; master ${primary.orderId}, source ${secondary.orderId}`);
    } catch (error) { bodyError = error; }
    try { await cleanup(); report.cleanup_pass = !!primary.sessionId && !!secondary.sessionId; }
    catch (error) { cleanupError = error; console.error(`CLEANUP REQUIRED: ${String(error)}`); }
    try { report.build_after = await version(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === build;
    report.primary_session_id = primary.sessionId;
    report.secondary_session_id = secondary.sessionId;
    report.master_order_id = primary.orderId;
    report.source_order_id = secondary.orderId;
    report.ui_writes = uiWrites;
    report.business_execution = uiWrites.some(write =>
      write === `POST /api/v1/tables/${primary.tableId}/merge`) ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !bodyError && !cleanupError && report.cleanup_pass && report.build_stable ?
      'PASSED' : cleanupError ? 'INCONCLUSIVE' : 'FAILED';
    await testInfo.attach('S4_TABLE_MERGE_UI_evidence', {
      body: JSON.stringify(report, null, 2), contentType: 'application/json',
    });
    console.log('[S4-MERGE-UI] Evidence: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (bodyError) throw bodyError;
    expect(report.build_stable, 'staging build stable').toBe(true);
  });
