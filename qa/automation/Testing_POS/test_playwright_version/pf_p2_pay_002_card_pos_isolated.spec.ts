import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// QA3 isolated CARD contract preflight; no gateway, PAN or CVV.
test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('PF-P2-PAY-002-CARD-POS | QA3 cashier records CARD confirmed on POS (contract preflight)',
  async ({ request }, testInfo) => {
    test.setTimeout(90_000);
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base, 'QA3 staging only').toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full pinned POS_EXPECTED_COMMIT required');
    const tokens: Record<string, string> = {};
    const own: { tableId?: string; tableCode?: string; sessionId?: string;
      orderId?: string; itemId?: string; menuId?: string; paymentId?: string } = {};
    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-PFP2PAY002`,
      test_ref: 'PF-P2-PAY-002-CARD-POS',
      business_case: 'P2-PAY-002 NOT_EXECUTED: external CARD gateway/callback not implemented; PO contract review required', checked_at: new Date().toISOString(),
      scope: 'QA3 CARD POS-terminal acknowledgement: cashier records one full bill, checks ledger, audit and owned cleanup. Gateway/card sandbox and callback not covered; P2-PAY-002 remains pending PO contract',
      project: testInfo.project.name, secrets_recorded: false,
      card_recorded: false, signed_url_recorded: false,
      checks: {}, cleanup_pass: false, business_execution: 'NOT_EXECUTED',
    };
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, ...Object.values(tokens)])
        if (secret) value = value.replaceAll(secret, '<REDACTED>');
      value = value.replace(/https?:\/\/[^\s"'<>]+vnp_SecureHash[^\s"'<>]*/gi,
        '<REDACTED_SIGNED_URL>');
      return value;
    };
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const before = await build();
    test.skip(before !== expected,
      `PENDING_BUILD: staging ${before} differs from pinned ${expected}`);
    report.staging_commit = before;
    const contract = await request.get(base + '/openapi.json', { timeout: 20_000 });
    expect(contract.status()).toBe(200);
    const spec = await contract.json();
    for (const [path, method] of [
      ['/api/v1/orders/{order_id}/payments', 'post'],
      ['/api/v1/orders/{order_id}/payments', 'get'],
    ] as const) expect(spec.paths?.[path]?.[method], `${method} ${path}`).toBeTruthy();
    for (const [role, username, expectedRole] of [
      ['waiter', 'qa3_waiter', 'WAITER'],
      ['cashier', 'qa3_cashier', 'CASHIER'],
      ['kitchen', 'qa3_kitchen', 'KITCHEN'],
      ['admin', 'qa3_admin', 'SUPERVISOR'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status(), `${username} login`).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
      tokens[role] = body.access_token;
      expect(tokens[role]).toBeTruthy();
      if (role === 'waiter') report.qa3_outlet_id = body.staff?.outlet_id;
      else expect(body.staff?.outlet_id).toBe(report.qa3_outlet_id);
    }
    async function call(method: 'GET' | 'POST', path: string, role: string,
      data?: object, key?: string) {
      const response = await request.fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${tokens[role]}`,
          ...(method === 'POST' ? { 'Idempotency-Key': key || randomUUID() } : {}) },
        ...(data !== undefined ? { data } : {}),
        timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function checked(method: 'GET' | 'POST', path: string, role: string,
      http: number, data?: object) {
      const result = await call(method, path, role, data);
      expect(result.http, `${method} ${path}`).toBe(http);
      return result.body;
    }
    const order = () => checked('GET', `/api/v1/orders/${own.orderId}`,
      'cashier', 200);
    const table = () => checked('GET', `/api/v1/tables/${own.tableId}`,
      'waiter', 200);
    const ledger = () => checked('GET',
      `/api/v1/orders/${own.orderId}/payments`, 'cashier', 200);

    async function cleanup() {
      if (!own.sessionId) { report.cleanup_pass = true; return; }
      const t = await table();
      if (t.current_session?.id !== own.sessionId &&
          !(t.status === 'CLEANING' && own.orderId &&
            ['PAID', 'CLOSED'].includes((await order()).status)))
        throw new Error('CLEANUP REQUIRED: QA3 table/session ownership changed');
      if (!own.orderId) {
        const matches = (t.orders || []).filter((row: any) =>
          row.table_session_id === own.sessionId);
        if (matches.length > 1) throw new Error('CLEANUP REQUIRED: ambiguous order');
        own.orderId = matches[0]?.id || (await checked('POST', '/api/v1/orders',
          'waiter', 201, { table_session_id: own.sessionId })).id;
      }
      let current = await order();
      if (current.table_session_id !== own.sessionId)
        throw new Error('CLEANUP REQUIRED: order/session mismatch');
      if (!current.items.length) {
        await checked('POST', `/api/v1/orders/${own.orderId}/items`, 'waiter', 201,
          { items: [{ menu_item_id: own.menuId, quantity: 1,
            note: 'PF-P2-PAY-002-CARD-POS owned cleanup' }] });
        current = await order();
      }
      if (current.status === 'NEW')
        await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
          'waiter', 200);
      for (const item of (await order()).items) {
        for (const [state, action, role] of [
          ['SENT', 'start-cooking', 'kitchen'],
          ['PREPARING', 'mark-ready', 'kitchen'],
          ['READY', 'pickup', 'waiter'],
          ['PICKED_UP', 'served', 'waiter'],
        ] as const) {
          if ((await order()).items.find((row: any) => row.id === item.id)?.status === state)
            await checked('POST',
              `/api/v1/orders/${own.orderId}/items/${item.id}/${action}`,
              role, 200);
        }
      }
      current = await order();
      if (current.items.some((item: any) => item.status !== 'SERVED'))
        throw new Error('CLEANUP REQUIRED: item not SERVED');
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
          'waiter', 200);
      if ((await order()).status === 'BILLING') {
        if (own.paymentId) {
          const payment = (await ledger()).payments?.find(
            (row: any) => row.id === own.paymentId);
          if (['PENDING', 'UNKNOWN'].includes(payment?.status)) {
            const cancelled = await call('POST',
              `/api/v1/payments/${own.paymentId}/cancel`, 'cashier',
              { reason: 'QA owned cleanup after incomplete sandbox run' });
            expect(cancelled.http, 'cancel own pending link').toBe(200);
          }
        }
        await checked('POST', `/api/v1/orders/${own.orderId}/pay`,
          'cashier', 200);
      }
      if ((await order()).status === 'PAID')
        await checked('POST', `/api/v1/orders/${own.orderId}/close`,
          'cashier', 200);
      if ((await table()).status === 'CLEANING')
        await checked('POST', `/api/v1/tables/${own.tableId}/mark-clean`,
          'waiter', 200);
      const finalOrder = await order(), finalTable = await table();
      const done = await checked('GET', '/api/v1/kitchen/queue?status=DONE',
        'kitchen', 200) as any[];
      const active = await checked('GET', '/api/v1/kitchen/queue',
        'kitchen', 200) as any[];
      report.cleanup_state = {
        order_closed: finalOrder.status === 'CLOSED',
        table_available: finalTable.status === 'AVAILABLE' &&
          !finalTable.current_session,
        items_served: finalOrder.items.every((item: any) => item.status === 'SERVED'),
        ticket_done: done.some(row => row.order_id === own.orderId),
        no_active_ticket: !active.some(row => row.order_id === own.orderId),
      };
      if (!Object.values(report.cleanup_state).every(Boolean))
        throw new Error('CLEANUP REQUIRED: final state mismatch');
      report.cleanup_pass = true;
    }

    let failure: unknown, cleanupError: unknown;
    try {
      const tables = await checked('GET', '/api/v1/tables',
        'waiter', 200) as any[];
      const source = tables.find(row => row.code === 'Q3-1' &&
        row.status === 'AVAILABLE');
      if (!source) throw new Error('PENDING_FIXTURE: Q3-1 must be AVAILABLE');
      own.tableId = source.id; own.tableCode = source.code;
      const menu = await checked('GET', '/api/v1/menu?available_only=true',
        'waiter', 200) as any[];
      const starter = menu.find(row => row.is_available && row.station_id &&
        !row.has_modifiers && Number(row.price) === 50_000);
      if (!starter) throw new Error('PENDING_FIXTURE: mapped 50,000 VND item required');
      own.menuId = starter.id;
      own.sessionId = (await checked('POST',
        `/api/v1/tables/${own.tableId}/open-session`, 'waiter', 201,
        { guest_count: 1 })).id;
      own.orderId = (await checked('POST', '/api/v1/orders',
        'waiter', 201, { table_session_id: own.sessionId })).id;
      const added = await checked('POST',
        `/api/v1/orders/${own.orderId}/items`, 'waiter', 201,
        { items: [{ menu_item_id: own.menuId, quantity: 1,
          note: 'PF-P2-PAY-002-CARD-POS QA3 own' }] });
      own.itemId = added.items.find((item: any) =>
        item.menu_item_id === own.menuId)?.id;
      expect(own.itemId).toBeTruthy();
      await checked('POST', `/api/v1/orders/${own.orderId}/send-to-kitchen`,
        'waiter', 200);
      for (const [action, role] of [
        ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
        ['pickup', 'waiter'], ['served', 'waiter'],
      ] as const) await checked('POST',
        `/api/v1/orders/${own.orderId}/items/${own.itemId}/${action}`,
        role, 200);
      await checked('POST', `/api/v1/orders/${own.orderId}/request-billing`,
        'waiter', 200);
      const beforeOrder = await order(), beforeLedger = await ledger();
      expect(beforeOrder.status).toBe('BILLING');
      expect(Number(beforeOrder.amount_due)).toBe(50_000);
      expect(beforeLedger.payments).toHaveLength(0);
      report.table_code = own.tableCode; report.order_id = own.orderId;
      const created = await call('POST',
        `/api/v1/orders/${own.orderId}/payments`, 'cashier',
        { method: 'CARD', amount: '50000.00',
          provider_ref: `QA-CARD-POS-${report.run_id}` });
      report.payment_http = created.http;
      const afterOrder = await order(), afterLedger = await ledger();
      const afterTable = await table();
      const audit = await checked('GET',
        `/api/v1/audit-logs?order_id=${own.orderId}&limit=100`,
        'admin', 200) as any[];
      report.payment_id = created.body?.payment?.id;
      report.order_id = own.orderId;
      report.table_code = own.tableCode;
      report.audit_counts = {
        recorded: audit.filter(row => row.action === 'PAYMENT_RECORDED').length,
        paid: audit.filter(row => row.action === 'ORDER_PAID').length,
      };
      report.checks = {
        payment_created: created.http === 201 &&
          created.body?.payment?.method === 'CARD' &&
          created.body?.payment?.status === 'SUCCEEDED' &&
          Number(created.body?.payment?.amount) === 50_000,
        one_ledger_payment: afterLedger.payments?.length === 1 &&
          afterLedger.payments[0]?.id === report.payment_id &&
          afterLedger.payments[0]?.method === 'CARD',
        exact_paid_bill: afterOrder.status === 'PAID' &&
          Number(afterLedger.summary?.paid) === 50_000 &&
          Number(afterLedger.summary?.remaining) === 0 &&
          afterTable.status === 'CLEANING',
        audit_once: report.audit_counts.recorded === 1 &&
          report.audit_counts.paid === 1,
      };
      report.business_execution = 'CARD_POS_ACK_EXECUTED';
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('CARD POS-terminal contract preflight mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { await cleanup(); } catch (error) { cleanupError = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.result = !failure && !cleanupError && report.cleanup_pass &&
      report.build_stable ? 'PASSED' : cleanupError ? 'INCONCLUSIVE' :
      redact(failure).includes('PENDING_FIXTURE') ? 'PENDING' : 'FAILED';
    report.full_case_status = 'PENDING_PO_CARD_GATEWAY_CONTRACT';
    if (failure) report.error = redact(failure);
    if (cleanupError) report.cleanup_required = redact(cleanupError);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `PF_P2_PAY_002_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('PF_P2_PAY_002_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[PF-P2-PAY-002-CARD-POS] Evidence: .\\evidence\\${name}`);
    console.log('[PF-P2-PAY-002-CARD-POS] Result: ' + JSON.stringify(report));
    if (cleanupError) throw new Error(redact(cleanupError));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
