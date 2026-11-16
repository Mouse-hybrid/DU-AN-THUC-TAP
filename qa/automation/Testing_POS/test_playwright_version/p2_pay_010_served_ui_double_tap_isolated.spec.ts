import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('PF-P2-PAY-010-SERVED-UI | QA3 double taps split of served items',
  async ({ page, request }, testInfo) => {
    test.setTimeout(300_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium fixture only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
    expect(expected).toMatch(/^[a-f0-9]{40}$/);
    const runId = 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2PAY010SERVEDUI';
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
        method,
        headers: { Authorization: `Bearer ${tokens[role]}`,
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
    const ownTable = tables.find(row => row.code === 'Q3-1');
    test.skip(!ownTable || ownTable.status !== 'AVAILABLE', 'PENDING_FIXTURE: Q3-1 must be AVAILABLE');
    const menu = await checked('GET', '/api/v1/menu?available_only=true', 'cashier', 200) as any[];
    const choices = menu.filter(row => row.id && row.name && row.is_available &&
      row.station_id && !row.has_modifiers);
    test.skip(choices.length < 2 || choices[0].name === choices[1].name,
      'PENDING_FIXTURE: two distinct mapped menu items required');
    const [keepMenu, moveMenu] = choices;
    const own: { sessionId?: string; sourceId?: string; childId?: string; orderIds: string[];
      keepId?: string; moveId?: string; keepTicket?: string; moveTicket?: string } = {};
    own.orderIds = [];
    const report: any = { run_id: runId, test_ref: 'PF-P2-PAY-010-SERVED-UI',
      checked_at: new Date().toISOString(), build_before: build, staging_commit: build,
      project: testInfo.project.name, case_coverage: 'SERVED_UI_DOUBLE_TAP_SPLIT',
      paired_api_run_id: 'RUN-20261116022607855-P2PAY010',
      scope: 'QA3 desktop double taps split confirmation with two SERVED items; verify one child bill, original item/ticket ownership, one audit and owned cleanup',
      secrets_recorded: false, ui_split_http: null, checks: {}, cleanup_pass: false };
    const uiWrites: string[] = [];
    const splitKeys: string[] = [];
    const splitStatuses: number[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login') uiWrites.push(`${req.method()} ${path}`);
      if (req.method() === 'POST' && path.endsWith('/split'))
        splitKeys.push(req.headers()['idempotency-key'] || '');
    });
    page.on('response', response => {
      if (response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/split')) splitStatuses.push(response.status());
    });
    const table = () => checked('GET', `/api/v1/tables/${ownTable.id}`, 'waiter', 200);
    const order = (id: string) => checked('GET', `/api/v1/orders/${id}`, 'cashier', 200);
    const queue = async (status?: string) => {
      const rows = await checked('GET', `/api/v1/kitchen/queue${status ? `?status=${status}` : ''}`,
        'kitchen', 200) as any[];
      return rows.filter(row => own.orderIds.includes(row.order_id));
    };
    async function discoverChild() {
      const current = await table();
      expect(current.current_session?.id, 'own QA3 session remains on Q3-1').toBe(own.sessionId);
      const ids = [...new Set((current.orders || []).filter((row: any) =>
        row.table_session_id === own.sessionId).map((row: any) => row.id))] as string[];
      if (ids.length > 5) throw new Error('CLEANUP REQUIRED: too many orders in own QA3 session');
      own.orderIds = ids;
      const extra = ids.find(id => id !== own.sourceId);
      if (extra && !own.childId) own.childId = extra;
    }
    async function finishOrder(id: string) {
      let current = await order(id);
      if (current.table_session_id !== own.sessionId)
        throw new Error(`CLEANUP REQUIRED: order ${id} ownership mismatch`);
      if (current.status === 'CLOSED') return;
      if (!current.items?.length && current.status === 'NEW') {
        await checked('POST', `/api/v1/orders/${id}/items`, 'waiter', 201,
          { items: [{ menu_item_id: keepMenu.id, quantity: 1, note: 'PF-S4-SPLIT cleanup' }] });
        current = await order(id);
      }
      if (!current.items?.length)
        throw new Error(`CLEANUP REQUIRED: order ${id} has no items after split`);
      if (current.items.some((item: any) => item.status === 'CREATED'))
        await checked('POST', `/api/v1/orders/${id}/send-to-kitchen`, 'waiter', 200);
      for (const item of (await order(id)).items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'], ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'], ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order(id)).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', `/api/v1/orders/${id}/items/${item.id}/${action}`, role, 200);
        }
        expect((await order(id)).items.find((row: any) => row.id === item.id)?.status).toBe('SERVED');
      }
      current = await order(id);
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${id}/request-billing`, 'waiter', 200);
      if (!['PAID', 'CLOSED'].includes((await order(id)).status))
        await checked('POST', `/api/v1/orders/${id}/pay`, 'cashier', 200);
      if ((await order(id)).status !== 'CLOSED')
        await checked('POST', `/api/v1/orders/${id}/close`, 'cashier', 200);
    }
    async function cleanup() {
      if (!own.sessionId) return;
      console.log(`[S4-SPLIT-DOUBLE] Cleanup starts: Q3-1 session ${own.sessionId}, source ${own.sourceId}`);
      if (!own.sourceId) {
        const current = await table();
        if (current.current_session?.id !== own.sessionId)
          throw new Error('CLEANUP REQUIRED: own session no longer on Q3-1');
        const rows = (current.orders || []).filter((row: any) => row.table_session_id === own.sessionId);
        if (rows.length === 1) own.sourceId = rows[0].id;
        else if (!rows.length) own.sourceId = (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
        else throw new Error('CLEANUP REQUIRED: source order ownership ambiguous');
      }
      await discoverChild();
      for (const id of own.orderIds) await finishOrder(id);
      const current = await table();
      if (current.status === 'CLEANING')
        await checked('POST', `/api/v1/tables/${ownTable.id}/mark-clean`, 'waiter', 200);
      const final = await table();
      expect(final.status).toBe('AVAILABLE');
      expect(final.current_session).toBeNull();
      const finalOrders = [];
      for (const id of own.orderIds) {
        const currentOrder = await order(id);
        expect(currentOrder.status).toBe('CLOSED');
        finalOrders.push(currentOrder);
      }
      expect(await queue(), 'no own active kitchen ticket').toHaveLength(0);
      expect(await queue('DONE')).toHaveLength(finalOrders.flatMap(row => row.items).length);
      console.log(`[S4-SPLIT-DOUBLE] Cleanup passed: Q3-1 AVAILABLE; ${own.orderIds.length} owned orders CLOSED`);
    }
    let bodyError: unknown;
    let cleanupError: unknown;
    try {
      own.sessionId = (await checked('POST', `/api/v1/tables/${ownTable.id}/open-session`,
        'waiter', 201, { guest_count: 2 })).id;
      own.sourceId = (await checked('POST', '/api/v1/orders', 'cashier', 201,
        { table_session_id: own.sessionId })).id;
      own.orderIds = [own.sourceId!];
      console.log(`[S4-SPLIT-DOUBLE] Own fixture: Q3-1 session ${own.sessionId}, order ${own.sourceId}`);
      const added = await checked('POST', `/api/v1/orders/${own.sourceId}/items`, 'cashier', 201,
        { items: [
          { menu_item_id: keepMenu.id, quantity: 1, note: 'PF-S4-SPLIT keep' },
          { menu_item_id: moveMenu.id, quantity: 1, note: 'PF-S4-SPLIT move' },
        ] });
      own.keepId = added.items?.find((row: any) => row.note === 'PF-S4-SPLIT keep')?.id;
      own.moveId = added.items?.find((row: any) => row.note === 'PF-S4-SPLIT move')?.id;
      expect(own.keepId).toBeTruthy();
      expect(own.moveId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.sourceId}/send-to-kitchen`, 'waiter', 200);
      let before = await order(own.sourceId);
      const ticketsBefore = await queue();
      expect(before.items).toHaveLength(2);
      expect(ticketsBefore).toHaveLength(2);
      own.keepTicket = ticketsBefore.find((row: any) => row.order_item_id === own.keepId)?.id;
      own.moveTicket = ticketsBefore.find((row: any) => row.order_item_id === own.moveId)?.id;
      expect(own.keepTicket).toBeTruthy();
      expect(own.moveTicket).toBeTruthy();
      for (const itemId of [own.keepId!, own.moveId!]) {
        for (const [action, role] of [
          ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
          ['pickup', 'waiter'], ['served', 'waiter'],
        ] as const) {
          await checked('POST', `/api/v1/orders/${own.sourceId}/items/${itemId}/${action}`,
            role, 200);
        }
      }
      before = await order(own.sourceId);
      const doneBefore = await queue('DONE');
      expect(before.items).toHaveLength(2);
      expect(before.items.every((row: any) => row.status === 'SERVED')).toBe(true);
      expect(doneBefore).toHaveLength(2);
      expect(doneBefore.map((row: any) => row.id).sort()).toEqual(
        [own.keepTicket, own.moveTicket].sort());
      report.items_served_before_split = true;

      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click({ timeout: 10_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto(`${base}/tables/${ownTable.id}/summary`,
        { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.getByRole('button', { name: 'Tách bill', exact: true }).click({ timeout: 10_000 });
      const dialog = page.getByRole('dialog', { name: 'Tách bill' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('split-row')).toHaveCount(2);
      const moveRow = dialog.getByTestId('split-row').filter({ hasText: moveMenu.name });
      await expect(moveRow, 'select only the owned move item').toHaveCount(1);
      const quantityButtons = moveRow.locator('button');
      await expect(quantityButtons, 'served item uses decrement/increment controls').toHaveCount(2);
      await quantityButtons.nth(1).click({ timeout: 10_000 });
      const submit = dialog.getByRole('button', { name: 'Tách bill', exact: true });
      await expect(submit).toBeEnabled();
      const [response] = await Promise.all([
        page.waitForResponse(res => res.request().method() === 'POST' &&
          new URL(res.url()).pathname === `/api/v1/orders/${own.sourceId}/split`, { timeout: 20_000 }),
        submit.dblclick({ timeout: 10_000 }),
      ]);
      // Give the UI's second click a chance to issue a request before reading the bill state.
      await page.waitForTimeout(1_200);
      report.ui_split_http = response.status();
      expect(response.status()).toBe(201);
      const result = await response.json();
      own.childId = result.new_order?.id;
      await discoverChild();
      expect(own.childId).toBeTruthy();
      const source = await order(own.sourceId), child = await order(own.childId!);
      const ticketsAfter = await queue('DONE');
      const audit = await checked('GET',
        `/api/v1/audit-logs?action=ORDER_SPLIT&entity_id=${own.sourceId}`, 'admin', 200) as any[];
      const currentTable = await table();
      report.checks = {
        double_tap_no_extra_write: uiWrites.length >= 1 && uiWrites.length <= 2 &&
          uiWrites.every(write => write === `POST /api/v1/orders/${own.sourceId}/split`) &&
          (uiWrites.length === 1 || (splitKeys.length === 2 && !!splitKeys[0] &&
            splitKeys[0] === splitKeys[1] && splitStatuses.length === 2 &&
            splitStatuses.every(status => status === 201))),
        same_session_two_bills: source.table_session_id === own.sessionId &&
          child.table_session_id === own.sessionId &&
          currentTable.orders.filter((row: any) => row.table_session_id === own.sessionId).length === 2 &&
          own.orderIds.length === 2,
        total_preserved: Math.round((Number(source.subtotal) + Number(child.subtotal)) * 100) ===
          Math.round(Number(before.subtotal) * 100),
        exact_item_partition: source.items.length === 1 && child.items.length === 1 &&
          source.items[0].id === own.keepId && child.items[0].id === own.moveId &&
          source.items[0].status === 'SERVED' && child.items[0].status === 'SERVED',
        original_tickets_follow_items: ticketsAfter.length === 2 &&
          ticketsAfter.some((row: any) => row.id === own.keepTicket && row.order_id === own.sourceId) &&
          ticketsAfter.some((row: any) => row.id === own.moveTicket && row.order_id === own.childId),
        source_version_incremented: source.current_version > before.current_version,
        split_audit_once: audit.filter(row => row.action === 'ORDER_SPLIT' &&
          row.entity_id === own.sourceId && row.payload?.new_order_id === own.childId).length === 1,
      };
      expect(Object.values(report.checks).every(Boolean), JSON.stringify(report.checks)).toBe(true);
      console.log(`[S4-SPLIT-DOUBLE] Double tap observed: ${uiWrites.length} split request(s); source ${own.sourceId}, child ${own.childId}`);
    } catch (error) { bodyError = error; }
    try { await cleanup(); report.cleanup_pass = !!own.sessionId; }
    catch (error) { cleanupError = error; console.error(`CLEANUP REQUIRED: ${String(error)}`); }
    try { report.build_after = await version(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === build;
    report.source_order_id = own.sourceId;
    report.child_order_id = own.childId;
    report.owned_order_count = own.orderIds.length;
    report.ui_writes = uiWrites;
    report.ui_split_statuses = splitStatuses;
    report.same_idempotency_key_if_two_requests = splitKeys.length === 2 ?
      !!splitKeys[0] && splitKeys[0] === splitKeys[1] : null;
    report.business_execution = uiWrites.some(write =>
      write === `POST /api/v1/orders/${own.sourceId}/split`) ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !bodyError && !cleanupError && report.cleanup_pass && report.build_stable ?
      'PASSED' : cleanupError ? 'INCONCLUSIVE' : 'FAILED';
    await testInfo.attach('P2_PAY_010_SERVED_UI_evidence', {
      body: JSON.stringify(report, null, 2), contentType: 'application/json',
    });
    console.log('[S4-SPLIT-DOUBLE] Evidence: ' + JSON.stringify(report));
    if (cleanupError) throw cleanupError;
    if (bodyError) throw bodyError;
    expect(report.build_stable, 'staging build stable').toBe(true);
  });
