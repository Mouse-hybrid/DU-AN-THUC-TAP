import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('PF-S4-TABLE-TRANSFER-UI | QA3 desktop transfers an occupied table',
  async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium fixture only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
    expect(expected).toMatch(/^[a-f0-9]{40}$/);
    const runId = 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4TRANSFERUI';
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
    const rows = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
    const source = rows.find(row => row.code === 'Q3-1');
    const target = rows.find(row => row.code === 'Q3-2');
    test.skip(!source || !target || source.status !== 'AVAILABLE' ||
      target.status !== 'AVAILABLE', 'PENDING_FIXTURE: Q3-1/Q3-2 must be AVAILABLE');
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 'cashier', 200) as any[];
    const menuId = menu.find(row => row.is_available && row.station_id && !row.has_modifiers)?.id;
    test.skip(!menuId, 'PENDING_FIXTURE: mapped menu item required');
    const own: { sessionId?: string; orderId?: string; itemId?: string; ticketId?: string } = {};
    const table = (id: string) => checked('GET', `/api/v1/tables/${id}`, 'waiter', 200);
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`, 'cashier', 200);
    const queue = async (status?: string) => {
      const data = await checked('GET', `/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`,
        'kitchen', 200) as any[];
      return data.filter(row => row.order_id === own.orderId);
    };
    const uiWrites: string[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login') uiWrites.push(`${req.method()} ${path}`);
    });
    const report: any = { run_id: runId, test_ref: 'PF-S4-TABLE-TRANSFER-UI',
      checked_at: new Date().toISOString(), staging_commit: build, build_before: build,
      scope: 'QA3 desktop UI transfer Q3-1 to Q3-2; session/order/ticket/audit and BR-TT-010 source AVAILABLE; owned cleanup',
      requirement_ref: 'BR-TT-010', project: testInfo.project.name,
      secrets_recorded: false, ui_transfer_http: null, checks: {}, cleanup_pass: false };
    async function cleanup() {
      if (!own.sessionId) return;
      console.log(`[S4-TRANSFER-UI] Cleanup starts: Q3-1/Q3-2, session ${own.sessionId}, order ${own.orderId}`);
      let from = await table(source.id), to = await table(target.id);
      const fromOwns = from.current_session?.id === own.sessionId;
      const toOwns = to.current_session?.id === own.sessionId;
      if (fromOwns === toOwns) throw new Error('CLEANUP REQUIRED: own session holder ambiguous');
      const holder = fromOwns ? from : to;
      if (!own.orderId) {
        const orders = (holder.orders || []).filter((row: any) => row.table_session_id === own.sessionId);
        if (orders.length === 1) own.orderId = orders[0].id;
        else if (!orders.length) own.orderId = (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
        else throw new Error('CLEANUP REQUIRED: own order ambiguous');
      }
      let current = await order();
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (current.status === 'NEW' && !current.items?.length) {
        await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'waiter', 201,
          { items: [{ menu_item_id: menuId, quantity: 1, note: 'PF-S4-TRANSFER cleanup' }] });
        current = await order();
      }
      if (current.status === 'NEW')
        await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter', 200);
      current = await order();
      if (!current.items?.length) throw new Error('CLEANUP REQUIRED: empty own order');
      for (const item of current.items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`, role, 200);
        }
        expect((await order()).items.find((row: any) => row.id === item.id)?.status).toBe('SERVED');
      }
      if (!['BILLING', 'PAID', 'CLOSED'].includes((await order()).status))
        await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`, 'waiter', 200);
      if (!['PAID', 'CLOSED'].includes((await order()).status))
        await checked('POST', `/api/v1/orders/${own.orderId}/pay`, 'cashier', 200);
      if ((await order()).status !== 'CLOSED')
        await checked('POST', `/api/v1/orders/${own.orderId}/close`, 'cashier', 200);
      for (const id of [source.id, target.id]) {
        const currentTable = await table(id);
        if (currentTable.status === 'CLEANING')
          await checked('POST', `/api/v1/tables/${id}/mark-clean`, 'waiter', 200);
      }
      from = await table(source.id); to = await table(target.id);
      expect(from.status).toBe('AVAILABLE');
      expect(to.status).toBe('AVAILABLE');
      expect(from.current_session).toBeNull();
      expect(to.current_session).toBeNull();
      expect((await order()).status).toBe('CLOSED');
      expect(await queue()).toHaveLength(0);
      expect(await queue('DONE')).toHaveLength((await order()).items.length);
      console.log(`[S4-TRANSFER-UI] Cleanup passed: Q3-1/Q3-2 AVAILABLE, order ${own.orderId} CLOSED`);
    }
    let bodyError: unknown, cleanupError: unknown;
    try {
      own.sessionId = (await checked('POST', `/api/v1/tables/${source.id}/open-session`,
        'waiter', 201, { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'cashier', 201,
        { table_session_id: own.sessionId })).id;
      const added = await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'cashier', 201,
        { items: [{ menu_item_id: menuId, quantity: 1, note: 'PF-S4-TRANSFER own' }] });
      own.itemId = added.items?.find((item: any) => item.note === 'PF-S4-TRANSFER own')?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`, 'waiter', 200);
      const before = await order(), ticketsBefore = await queue();
      expect(ticketsBefore).toHaveLength(1);
      own.ticketId = ticketsBefore[0].id;
      console.log(`[S4-TRANSFER-UI] Own fixture: Q3-1 session ${own.sessionId}, order ${own.orderId}`);

      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click({ timeout: 10_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto(`${base}/tables/${source.id}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByRole('button', { name: 'Chuyển bàn Q3-1' }).click({ timeout: 10_000 });
      const dialog = page.getByRole('dialog', { name: 'Chuyển bàn Q3-1 sang bàn khác' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Bàn Q3-2')).toBeVisible();
      const targetChoice = dialog.getByRole('radio', { name: /Q3-2/ });
      await expect(targetChoice, 'select only owned Q3-2').toHaveCount(1);
      await targetChoice.check({ timeout: 10_000 });
      await expect(dialog.locator('input[name="move-target"]:checked')).toHaveCount(1);
      const submit = dialog.getByRole('button', { name: 'Chuyển bàn', exact: true });
      await expect(submit).toBeEnabled();
      const [response] = await Promise.all([
        page.waitForResponse(res => res.request().method() === 'POST' &&
          new URL(res.url()).pathname === `/api/v1/tables/${source.id}/transfer`,
          { timeout: 20_000 }),
        submit.click({ timeout: 10_000 }),
      ]);
      report.ui_transfer_http = response.status();
      expect(response.status()).toBe(200);
      const transfer = await response.json();
      const from = await table(source.id), to = await table(target.id);
      const after = await order(), ticketsAfter = await queue();
      const audits = await checked('GET',
        `/api/v1/audit-logs?entity_id=${own.sessionId}&entity_type=table_session&action=TABLE_TRANSFERRED&limit=100`,
        'admin', 200) as any[];
      report.observed_table_states = { source: from.status, target: to.status };
      report.checks = {
        one_ui_transfer_write: uiWrites.length === 1 &&
          uiWrites[0] === `POST /api/v1/tables/${source.id}/transfer`,
        same_session: transfer.table_session_id === own.sessionId &&
          to.current_session?.id === own.sessionId && !from.current_session,
        same_order: after.id === before.id && after.table_session_id === before.table_session_id &&
          after.items.length === before.items.length && after.items[0].id === before.items[0].id &&
          after.subtotal === before.subtotal,
        ticket_follows_target: ticketsAfter.length === 1 && ticketsAfter[0].id === own.ticketId &&
          ticketsAfter[0].order_id === own.orderId && ticketsAfter[0].table_code === 'Q3-2',
        target_occupied: to.status === 'OCCUPIED',
        source_available_br_tt_010: from.status === 'AVAILABLE',
        audit_once: audits.filter(row => row.action === 'TABLE_TRANSFERRED' &&
          row.entity_id === own.sessionId && row.staff_role === 'SUPERVISOR' &&
          Number.isFinite(Date.parse(row.created_at))).length === 1,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error(`Transfer UI/BR-TT-010 mismatch: ${JSON.stringify(report.checks)}`);
      console.log(`[S4-TRANSFER-UI] UI business PASS: HTTP 200, source ${from.status}, target ${to.status}`);
    } catch (error) { bodyError = error; }
    try { await cleanup(); report.cleanup_pass = !!own.sessionId; }
    catch (error) { cleanupError = error; console.error(`CLEANUP REQUIRED: ${String(error)}`); }
    try { report.build_after = await version(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === build;
    report.session_id = own.sessionId;
    report.order_id = own.orderId;
    report.ui_writes = uiWrites;
    report.business_execution = uiWrites.some(write =>
      write === `POST /api/v1/tables/${source.id}/transfer`) ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !bodyError && !cleanupError && report.cleanup_pass && report.build_stable ?
      'PASSED' : cleanupError ? 'INCONCLUSIVE' : 'FAILED';
    await testInfo.attach('S4_TABLE_TRANSFER_UI_evidence', {
      body: JSON.stringify(report, null, 2), contentType: 'application/json',
    });
    console.log('[S4-TRANSFER-UI] Evidence: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (bodyError) throw bodyError;
    expect(report.build_stable, 'staging build stable').toBe(true);
  });
