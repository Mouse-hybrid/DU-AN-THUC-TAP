import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-008 | transfer dialog lists valid target and cancel preserves session',
  async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 Chromium only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX008',
      test_ref: 'S4-UX-008', checked_at: new Date().toISOString(),
      scope: 'QA3 Q3-1 owned SENT item/ticket, Q3-2 AVAILABLE: transfer dialog lists target, submit disabled until selection, Cancel sends no transfer; source/target/session/order/ticket/audit unchanged; owned cleanup. No transfer submission.',
      case_coverage: 'DIALOG_SELECTION_AND_CANCEL_ONLY',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], checks: {}, cleanup_pass: false,
    };
    const tokens: Record<string, string> = {};
    const own: { sourceId?: string; targetId?: string; sessionId?: string;
      orderId?: string; itemId?: string; menuId?: string } = {};
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, ...Object.values(tokens)])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      return value;
    };
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const beforeBuild = await build();
    test.skip(beforeBuild !== expected, 'PENDING_BUILD: staging SHA changed');
    report.staging_commit = beforeBuild;
    for (const [role, expectedRole] of [
      ['admin', 'SUPERVISOR'], ['waiter', 'WAITER'],
      ['cashier', 'CASHIER'], ['kitchen', 'KITCHEN'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username: 'qa3_' + role, password: pin }, timeout: 20_000,
      });
      expect(response.status(), 'login ' + role).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
      if (role === 'admin') report.qa3_outlet_id = body.staff.outlet_id;
      else expect(body.staff?.outlet_id).toBe(report.qa3_outlet_id);
      tokens[role] = body.access_token;
      expect(tokens[role]).toBeTruthy();
    }
    async function call(method: 'GET'|'POST', path: string, role: string,
      data?: object) {
      const response = await request.fetch(base + path, {
        method, headers: { Authorization: 'Bearer ' + tokens[role],
          ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) },
        ...(data === undefined ? {} : { data }), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET'|'POST', path: string, role: string,
      http: number, data?: object) {
      const result = await call(method, path, role, data);
      expect(result.http, method + ' ' + path).toBe(http);
      return result.body;
    }
    const table = (id: string) => checked('GET', '/api/v1/tables/' + id,
      'waiter', 200);
    const order = () => checked('GET', '/api/v1/orders/' + own.orderId,
      'cashier', 200);
    const queue = () => checked('GET', '/api/v1/kitchen/queue',
      'kitchen', 200) as Promise<any[]>;
    const audit = () => checked('GET', '/api/v1/audit-logs?entity_id=' +
      own.sessionId + '&entity_type=table_session&action=TABLE_TRANSFERRED&limit=100',
      'admin', 200) as Promise<any[]>;
    const tables = await checked('GET', '/api/v1/tables', 'waiter', 200) as any[];
    const source = tables.find(row => row.code === 'Q3-1');
    const target = tables.find(row => row.code === 'Q3-2');
    test.skip(!source || !target || source.status !== 'AVAILABLE' ||
      target.status !== 'AVAILABLE',
      'PENDING_FIXTURE: Q3-1 and Q3-2 must be AVAILABLE');
    const menu = await checked('GET', '/api/v1/menu?available_only=true',
      'waiter', 200) as any[];
    const starter = menu.find(row => row.is_available && row.station_id &&
      !row.has_modifiers && Number(row.price) > 0);
    test.skip(!starter, 'PENDING_FIXTURE: mapped menu item required');
    own.sourceId = source.id;
    own.targetId = target.id;
    own.menuId = starter.id;
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        report.ui_writes.push(req.method() + ' ' + path);
    });
    async function snapshot() {
      const [src, dest, bill, station, logs] = await Promise.all([
        table(own.sourceId!), table(own.targetId!), order(), queue(), audit(),
      ]);
      return {
        source: { status: src.status, session: src.current_session?.id },
        target: { status: dest.status, session: dest.current_session?.id },
        order: { id: bill.id, session: bill.table_session_id,
          status: bill.status, items: bill.items.map((row: any) => ({
            id: row.id, status: row.status, quantity: row.quantity })) },
        tickets: station.filter(row => row.order_id === own.orderId)
          .map(row => ({ id: row.id, station_id: row.station_id,
            order_item_id: row.order_item_id, status: row.status })),
        audit_count: logs.length,
      };
    }
    async function cleanup() {
      if (!own.sessionId) { report.cleanup_pass = true; return; }
      let src = await table(own.sourceId!);
      if (src.current_session?.id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: owned session moved');
      if (!own.orderId) {
        const rows = (src.orders || []).filter((row: any) =>
          row.table_session_id === own.sessionId);
        if (rows.length > 1) throw new Error('CLEANUP REQUIRED: ambiguous order');
        own.orderId = rows[0]?.id || (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
      }
      let bill = await order();
      if (bill.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (!bill.items.length) {
        await checked('POST', '/api/v1/orders/' + own.orderId + '/items',
          'waiter', 201, { items: [{ menu_item_id: own.menuId, quantity: 1,
            note: 'S4-UX-008 owned cleanup' }] });
        bill = await order();
      }
      if (bill.status === 'NEW' || bill.items.some((row: any) =>
        row.status === 'CREATED'))
        await checked('POST', '/api/v1/orders/' + own.orderId +
          '/send-to-kitchen', 'waiter', 200);
      for (const item of (await order()).items) {
        for (const [state, action, role] of [
          ['SENT','start-cooking','kitchen'],
          ['PREPARING','mark-ready','kitchen'],
          ['READY','pickup','waiter'],
          ['PICKED_UP','served','waiter'],
        ] as const) {
          if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST', '/api/v1/orders/' + own.orderId +
              '/items/' + item.id + '/' + action, role, 200);
        }
      }
      if (!['BILLING','PAID','CLOSED'].includes((await order()).status))
        await checked('POST', '/api/v1/orders/' + own.orderId +
          '/request-billing', 'waiter', 200);
      if ((await order()).status === 'BILLING')
        await checked('POST', '/api/v1/orders/' + own.orderId + '/pay',
          'cashier', 200);
      if ((await order()).status === 'PAID')
        await checked('POST', '/api/v1/orders/' + own.orderId + '/close',
          'cashier', 200);
      src = await table(own.sourceId!);
      if (src.status === 'CLEANING')
        await checked('POST', '/api/v1/tables/' + own.sourceId +
          '/mark-clean', 'waiter', 200);
      const [finalSource, finalTarget, finalOrder, finalQueue] = await Promise.all([
        table(own.sourceId!), table(own.targetId!), order(), queue(),
      ]);
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      report.cleanup_state = {
        source_available: finalSource.status === 'AVAILABLE' &&
          !finalSource.current_session,
        target_available: finalTarget.status === 'AVAILABLE' &&
          !finalTarget.current_session,
        order_closed: finalOrder.status === 'CLOSED',
        items_served: finalOrder.items.every((row: any) => row.status === 'SERVED'),
        ticket_done: done.some(row => row.order_id === own.orderId),
        no_active_ticket: !finalQueue.some(row => row.order_id === own.orderId),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final state mismatch');
      report.cleanup_pass = true;
    }
    let failure: unknown;
    let cleanupError: unknown;
    try {
      own.sessionId = (await checked('POST', '/api/v1/tables/' +
        own.sourceId + '/open-session', 'waiter', 201, { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders', 'waiter', 201,
        { table_session_id: own.sessionId })).id;
      const added = await checked('POST', '/api/v1/orders/' + own.orderId +
        '/items', 'waiter', 201, { items: [{ menu_item_id: own.menuId,
          quantity: 1, note: 'S4-UX-008 own' }] });
      own.itemId = added.items.find((row: any) =>
        row.note === 'S4-UX-008 own')?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', '/api/v1/orders/' + own.orderId +
        '/send-to-kitchen', 'waiter', 200);
      const before = await snapshot();
      expect(before.source).toEqual({ status: 'OCCUPIED', session: own.sessionId });
      expect(before.target).toEqual({ status: 'AVAILABLE', session: undefined });
      expect(before.tickets).toHaveLength(1);
      report.session_id = own.sessionId;
      report.order_id = own.orderId;
      console.log('[S4-UX-008] Own Q3-1 session ' + own.sessionId +
        ', order ' + own.orderId);
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto('/tables/' + own.sourceId,
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const open = page.getByRole('button', { name: 'Chuyển bàn Q3-1' });
      await expect(open).toBeVisible({ timeout: 15_000 });
      await open.click();
      const dialog = page.getByRole('dialog',
        { name: 'Chuyển bàn Q3-1 sang bàn khác' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Bàn Q3-2')).toBeVisible();
      const choice = dialog.getByRole('radio', { name: /Q3-2/ });
      await expect(choice).toBeEnabled();
      const submit = dialog.getByRole('button', { name: 'Chuyển bàn', exact: true });
      await expect(submit).toBeDisabled();
      report.dialog = { target_visible: true, submit_initially_disabled: true };
      await choice.check();
      await expect(submit).toBeEnabled();
      report.dialog.submit_enabled_after_choice = true;
      await testInfo.attach('S4_UX_008_dialog', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      await dialog.getByRole('button', { name: 'Hủy thao tác' }).click();
      await expect(dialog).toBeHidden();
      const after = await snapshot();
      report.checks = {
        valid_target_visible: report.dialog.target_visible,
        no_selection_submit_disabled: report.dialog.submit_initially_disabled,
        selection_enables_submit: report.dialog.submit_enabled_after_choice,
        cancel_closes_dialog: true,
        no_ui_transfer_post: !report.ui_writes.some((x: string) =>
          x.includes('/transfer')),
        no_ui_business_write: report.ui_writes.length === 0,
        source_target_order_tickets_unchanged:
          JSON.stringify(before) === JSON.stringify(after),
        transfer_audit_unchanged: before.audit_count === after.audit_count,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Transfer dialog/cancel mismatch: ' +
          JSON.stringify(report.checks));
      report.business_execution = 'EXECUTED_UI_NO_WRITE';
    } catch (error) { failure = error; }
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === beforeBuild;
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' : 'FAILED';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_008_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_008_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-008] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-008] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
