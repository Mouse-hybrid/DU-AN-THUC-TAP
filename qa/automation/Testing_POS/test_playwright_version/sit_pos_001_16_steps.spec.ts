import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The QR token, signed payment URL, test card and OTP must never enter automatic artifacts.
test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('SIT-POS-001 | one owned POS flow through all 16 steps', async ({ browser, request }) => {
  test.setTimeout(8 * 60_000);
  const base = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const pin = process.env.S2_STAGING_PIN;
  const expected = process.env.POS_EXPECTED_COMMIT;
  const report: any = {
    test_ref: 'SIT-POS-001', checked_at: new Date().toISOString(),
    run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-SITPOS001`,
    result: 'INCONCLUSIVE', steps: Array.from({ length: 16 }, (_, i) => ({
      id: `SIT-POS-001-${String(i + 1).padStart(2, '0')}`, status: 'NOT_EXECUTED',
    })), cleanup_pass: false, secrets_recorded: false, token_recorded: false,
    phone_recorded: false, signed_url_recorded: false, card_recorded: false,
  };
  const tokens: Record<string, string> = {};
  const evidenceDir = join(process.cwd(), 'evidence', 'sit-pos-001');
  mkdirSync(evidenceDir, { recursive: true });
  const imagePath = (name: string) => join(evidenceDir, `${report.run_id}_${name}.png`);
  const own: any = { tables: {}, sessions: {}, orders: {}, itemIds: [],
    token: null, qrIssued: false, paymentId: null, rewardId: null,
    customerId: null, phone: null, marker: randomUUID().slice(0, 8) };
  const safe = (value: unknown) => {
    let text = String(value instanceof Error ? value.message : value);
    for (const secret of [pin, own.token, own.phone, own.paymentUrl,
      '9704198526191432198', '123456', ...Object.values(tokens)])
      if (secret) text = text.replaceAll(secret, '<REDACTED>');
    return text.replace(/https?:\/\/[^\s]+vnp_SecureHash[^\s]+/gi, '<REDACTED_SIGNED_URL>')
      .replace(/\/api\/v1\/public\/qr\/[^\s/'"?]+/g, '/api/v1/public/qr/<TOKEN>');
  };
  const checked = (ok: unknown, message: string) => expect(Boolean(ok), message).toBe(true);
  async function raw(method: string, path: string, role?: string, data?: unknown) {
    const response = await request.fetch(base + path, {
      method, headers: {
        ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
        ...(method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }),
      }, ...(data !== undefined ? { data } : {}), timeout: 30_000,
    });
    let body: any = null;
    try { body = await response.json(); } catch { /* CSV and empty responses */ }
    return { status: response.status(), body, response };
  }
  async function api(method: string, path: string, status: number, role?: string, data?: unknown) {
    const result = await raw(method, path, role, data);
    expect(result.status, `${method} ${path.replace(/\/public\/qr\/[^/]+/, '/public/qr/<TOKEN>')}`).toBe(status);
    return result.body;
  }
  const order = () => api('GET', `/api/v1/orders/${own.orders.main}`, 200, 'cashier');
  const table = (key: string) => api('GET', `/api/v1/tables/${own.tables[key]?.id}`, 200, 'waiter');
  const ledger = () => api('GET', `/api/v1/orders/${own.orders.main}/payments`, 200, 'cashier');
  const audit = () => api('GET', `/api/v1/audit-logs?order_id=${own.orders.main}&limit=200`, 200, 'admin');
  const money = (value: unknown) => Math.round(Number(value) * 100);
  const version = async () => (await api('GET', '/version', 200)).commit as string;
  async function step(number: number, label: string, action: () => Promise<void>) {
    const row = report.steps[number - 1];
    await test.step(`${row.id} ${label}`, async () => {
      row.status = 'RUNNING';
      try { await action(); row.status = 'PASSED'; }
      catch (error) {
        row.error = safe(error);
        row.status = row.error.includes('BLOCKED_ENV:') ? 'BLOCKED' : 'FAILED';
        throw new Error(row.error);
      }
    });
  }
  async function login(username: string) {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1366, height: 768 },
      recordVideo: undefined });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Tên đăng nhập', { exact: true }).fill(username);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await expect(page).toHaveURL(username.endsWith('_kitchen') ? /\/kitchen$/ : /\/tables$/,
      { timeout: 15_000 });
    return { page, context };
  }
  async function serve(id: string, orderId = own.orders.main) {
    for (const [action, role] of [
      ['start-cooking', 'kitchen'], ['mark-ready', 'kitchen'],
      ['pickup', 'waiter'], ['served', 'waiter'],
    ]) {
      const current = await api('GET', `/api/v1/orders/${orderId}`, 200, 'cashier');
      const item = current.items?.find((row: any) => row.id === id);
      if (!item) throw new Error('Owned item no longer belongs to order');
      const from = { 'start-cooking': 'SENT', 'mark-ready': 'PREPARING',
        pickup: 'READY', served: 'PICKED_UP' }[action] as string;
      if (item.status === from) await api('POST',
        `/api/v1/orders/${orderId}/items/${id}/${action}`, 200, role);
    }
  }
  async function cleanup() {
    if (!own.sessions.main) { report.cleanup_pass = true; return; }
    if (own.qrIssued) {
      const revoked = await raw('DELETE', `/api/v1/tables/${own.tables.target.id}/qr-session`, 'waiter');
      checked([204, 404].includes(revoked.status), 'Owned QR revoke');
      own.qrIssued = false;
    }
    for (const [name, session, key] of [
      ['main', own.sessions.main, own.tables.target &&
        (await table('target')).current_session?.id === own.sessions.main ? 'target' : 'source'],
      ['secondary', own.sessions.secondary, 'secondary'],
    ] as const) {
      if (!session || own.orders[name]) continue;
      const observed = await table(key);
      const matches = (observed.orders || []).filter((o: any) => o.table_session_id === session);
      if (matches.length > 1) throw new Error('CLEANUP REQUIRED: ambiguous owned order');
      own.orders[name] = matches[0]?.id || (await api('POST', '/api/v1/orders', 201,
        'waiter', { table_session_id: session })).id;
    }
    for (const id of [own.orders.main, own.orders.secondary].filter(Boolean)) {
      let current = await api('GET', `/api/v1/orders/${id}`, 200, 'cashier');
      if (current.status === 'CLOSED') continue;
      if (!current.items?.length && current.status === 'NEW') {
        const cleanupMenu = own.menu.find((m: any) => m.is_available && m.station_id &&
          !m.has_modifiers);
        checked(cleanupMenu, 'CLEANUP REQUIRED: mapped item unavailable');
        const added = await api('POST', `/api/v1/orders/${id}/items`, 201, 'waiter',
          { items: [{ menu_item_id: cleanupMenu.id, quantity: 1, note: 'SIT owned cleanup' }] });
        current = added;
      }
      if (current.status === 'NEW') await api('POST', `/api/v1/orders/${id}/send-to-kitchen`, 200, 'waiter');
      current = await api('GET', `/api/v1/orders/${id}`, 200, 'cashier');
      for (const item of current.items || []) await serve(item.id, id);
      current = await api('GET', `/api/v1/orders/${id}`, 200, 'cashier');
      if (!['BILLING', 'PAID', 'CLOSED'].includes(current.status))
        await api('POST', `/api/v1/orders/${id}/request-billing`, 200, 'waiter');
      if (id === own.orders.main && own.paymentId) {
        const payment = (await ledger()).payments?.find((p: any) => p.id === own.paymentId);
        if (['PENDING', 'UNKNOWN'].includes(payment?.status))
          await api('POST', `/api/v1/payments/${own.paymentId}/cancel`, 200, 'cashier',
            { reason: 'SIT owned cleanup' });
      }
      current = await api('GET', `/api/v1/orders/${id}`, 200, 'cashier');
      if (current.status === 'BILLING' && Number(current.amount_due) > 0) {
        const due = Number(current.amount_due).toFixed(2);
        await api('POST', `/api/v1/orders/${id}/payments`, 201, 'cashier',
          { method: 'CASH', amount: due, cash_received: due });
      }
      current = await api('GET', `/api/v1/orders/${id}`, 200, 'cashier');
      if (current.status === 'PAID') await api('POST', `/api/v1/orders/${id}/close`, 200, 'cashier');
    }
    for (const key of ['source', 'target', 'secondary']) {
      if (!own.tables[key]) continue;
      const current = await table(key);
      if (current.status === 'CLEANING')
        await api('POST', `/api/v1/tables/${own.tables[key].id}/mark-clean`, 200, 'waiter');
    }
    if (own.rewardId) await api('PATCH', `/api/v1/rewards/${own.rewardId}`, 200,
      'admin', { is_active: false });
    if (own.customerId) await api('PATCH', `/api/v1/customers/${own.customerId}`, 200,
      'admin', { is_active: false });
    const tables = await Promise.all(['source', 'target', 'secondary'].filter(key => own.tables[key]).map(table));
    report.cleanup_pass = tables.every(t => t.status === 'AVAILABLE' && !t.current_session) &&
      (await order()).status === 'CLOSED';
    checked(report.cleanup_pass, 'Owned sessions and tables must be released');
  }

  let failure: unknown, cleanupError: unknown, before: string | undefined;
  let staffPage: Page | undefined, staffContext: any;
  try {
    checked(base === 'http://160.191.47.17', 'Approved staging origin only');
    checked(!!pin && /^[a-f0-9]{40}$/.test(expected || ''), 'PIN and full SHA required');
    before = await version(); report.staging_commit = before;
    checked(before === expected, 'Staging build must match pinned SHA');
    for (const [role, username, expectedRole] of [
      ['waiter', 'qa3_waiter', 'WAITER'], ['cashier', 'qa3_cashier', 'CASHIER'],
      ['kitchen', 'qa3_kitchen', 'KITCHEN'], ['admin', 'qa3_admin', 'SUPERVISOR'],
    ]) {
      const auth = await api('POST', '/api/v1/auth/login', 200, undefined,
        { username, password: pin });
      checked(auth.staff?.role === expectedRole && auth.access_token, `${role} auth`);
      tokens[role] = auth.access_token;
      if (role === 'waiter') report.outlet_id = auth.staff.outlet_id;
      else checked(auth.staff.outlet_id === report.outlet_id, 'Same owned QA3 outlet');
    }
    const available = await api('GET', '/api/v1/tables', 200, 'waiter');
    for (const [key, code] of [['source', 'Q3-1'], ['secondary', 'Q3-2'], ['target', 'Q3-3']]) {
      own.tables[key] = available.find((t: any) => t.code === code && t.status === 'AVAILABLE');
      checked(own.tables[key], `${code} must be AVAILABLE`);
    }
    checked(Number(own.tables.source.seats) >= 4 && Number(own.tables.target.seats) <= 2,
    'Owned table capacity fixture 4 -> 2 required');
    own.menu = await api('GET', '/api/v1/menu?available_only=true', 200, 'cashier');
    checked(Array.isArray(own.menu) && own.menu.length >= 3, 'Mapped QA3 menu required');

    await step(1, 'Table map', async () => {
      const loginResult = await login('qa3_waiter');
      staffPage = loginResult.page; staffContext = loginResult.context;
      await expect(staffPage.getByRole('button', { name: /^Bàn Q3-1,/ })).toBeVisible();
      await expect(staffPage.getByRole('button', { name: /^Bàn Q3-2,/ })).toBeVisible();
    });
    await step(2, 'Open table above capacity', async () => {
      const result = await api('POST', `/api/v1/tables/${own.tables.source.id}/open-session`, 201,
        'waiter', { guest_count: 5 });
      own.sessions.main = result.id;
      checked(result.guest_count === 5 && (await table('source')).status === 'OCCUPIED',
        'Five guests in one session');
    });
    await step(3, 'POS modifier and send', async () => {
      const modifierItem = own.menu.find((m: any) => m.is_available && m.station_id && m.has_modifiers);
      const plain = own.menu.filter((m: any) => m.is_available && m.station_id && !m.has_modifiers);
      checked(modifierItem && plain.length >= 2, 'One mapped modifier item and two plain items required');
      const groups = await api('GET', `/api/v1/menu/${modifierItem.id}/modifiers?active_only=true`,
        200, 'cashier');
      const options = groups.flatMap((g: any) => (g.options || []).filter((o: any) => o.is_available)
        .slice(0, Math.max(g.min_select, 1)));
      checked(options.length > 0, 'Active modifier option required');
      own.menu = [modifierItem, ...plain];
      const created = await api('POST', '/api/v1/orders', 201, 'waiter',
        { table_session_id: own.sessions.main });
      own.orders.main = created.id;
      const added = await api('POST', `/api/v1/orders/${own.orders.main}/items`, 201, 'waiter',
        { items: [{ menu_item_id: modifierItem.id, quantity: 1,
          modifier_option_ids: options.map((o: any) => o.id) },
        ...plain.slice(0, 2).map((m: any) => ({ menu_item_id: m.id, quantity: 1 }))] });
      own.itemIds = added.items.map((i: any) => i.id);
      await api('POST', `/api/v1/orders/${own.orders.main}/send-to-kitchen`, 200, 'waiter');
      checked((await order()).items.length === 3, 'Three sent POS lines');
    });
    await step(4, 'KDS routed tickets', async () => {
      const queue = await api('GET', '/api/v1/kitchen/queue?status=QUEUED', 200, 'kitchen');
      checked(own.itemIds.every((id: string) => queue.some((t: any) => t.order_item_id === id && t.station_id)),
        'One mapped ticket per item');
      await staffContext.close();
      const kitchen = await login('qa3_kitchen'); staffPage = kitchen.page; staffContext = kitchen.context;
      await staffPage.goto('/kitchen', { waitUntil: 'domcontentloaded' });
      await expect(staffPage.locator('.nova-kds-ticket').first()).toBeVisible();
    });
    await step(5, 'Ready and pickup', async () => {
      for (const id of own.itemIds) await serve(id);
      checked((await order()).items.every((i: any) => i.status === 'SERVED'), 'POS items served');
    });
    await step(6, 'Transfer with capacity reason', async () => {
      const path = `/api/v1/tables/${own.tables.source.id}/transfer`;
      const denied = await raw('POST', path, 'waiter', { target_table_id: own.tables.target.id });
      expect(denied.status, 'Over-capacity transfer without reason').toBe(409);
      const transferred = await api('POST', path, 200, 'admin',
        { target_table_id: own.tables.target.id,
          capacity_override_reason: `SIT QA extra chairs ${own.marker}` });
      checked(transferred.table_session_id === own.sessions.main &&
        (await table('target')).current_session?.id === own.sessions.main, 'Session retained');
    });
    await step(7, 'Merge second active table', async () => {
      own.sessions.secondary = (await api('POST',
        `/api/v1/tables/${own.tables.secondary.id}/open-session`, 201, 'waiter',
        { guest_count: 1 })).id;
      own.orders.secondary = (await api('POST', '/api/v1/orders', 201, 'waiter',
        { table_session_id: own.sessions.secondary })).id;
      const added = await api('POST', `/api/v1/orders/${own.orders.secondary}/items`, 201,
        'waiter', { items: [{ menu_item_id: own.menu[1].id, quantity: 1 }] });
      own.secondaryItemId = added.items[0]?.id;
      await api('POST', `/api/v1/orders/${own.orders.secondary}/send-to-kitchen`, 200, 'waiter');
      const merged = await api('POST', `/api/v1/tables/${own.tables.target.id}/merge`, 200,
        'waiter', { table_ids: [own.tables.secondary.id] });
      checked(merged.order_id === own.orders.main &&
        (await order()).items.some((i: any) => i.id === own.secondaryItemId),
        'Secondary item follows master bill');
      await serve(own.secondaryItemId);
    });
    await step(8, 'Issue session QR', async () => {
      const issued = await api('POST', `/api/v1/tables/${own.tables.target.id}/qr-session`, 201,
        'waiter');
      own.token = issued.token; own.qrIssued = true;
      checked(own.token && issued.table_session_id === own.sessions.main &&
        issued.path === `/qr/${own.token}`, 'QR scoped to merged master session');
      const info = await api('GET', `/api/v1/public/qr/${own.token}`, 200);
      expect(info.send_mode).toBe('DIRECT');
    });
    await step(9, 'Anonymous QR order', async () => {
      await staffContext.close();
      const anonymous = await browser.newContext({ viewport: { width: 375, height: 812 } });
      staffContext = anonymous; staffPage = await anonymous.newPage();
      await staffPage.goto(base + `/qr/${own.token}`, { waitUntil: 'domcontentloaded' });
      await expect(staffPage.getByTestId('qr-table')).toHaveText(`Bàn ${own.tables.target.code}`);
      const item = own.menu.find((m: any) => m.name === 'Gỏi cuốn') || own.menu[1];
      own.qrMenuId = item.id; own.note = `SIT kitchen ${own.marker}`;
      const row = staffPage.getByTestId('qr-menu-item').filter({ hasText: item.name });
      await row.getByRole('button', { name: `Thêm ${item.name}` }).click();
      await staffPage.getByRole('textbox', { name: `Ghi chú cho ${item.name}` }).fill(own.note);
      const responsePromise = staffPage.waitForResponse(r => r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/api/v1/public/qr/${own.token}/orders`);
      await staffPage.getByRole('button', { name: 'Gửi món vào bếp' }).click();
      await staffPage.getByRole('dialog').getByRole('button',
        { name: `Đúng, bàn ${own.tables.target.code}` }).click();
      const submitted = await responsePromise; expect(submitted.status()).toBe(201);
      await expect(staffPage.getByTestId('qr-placed')).toContainText(own.note);
      const current = await order();
      own.qrItemId = current.items.find((i: any) => i.source === 'QR' &&
        i.menu_item_id === item.id)?.id;
      checked(own.qrItemId && current.table_session_id === own.sessions.main, 'QR shares master bill');
      await staffPage.getByTestId('qr-placed').screenshot({ path: imagePath('qr_receipt') });
    });
    await step(10, 'Member, QR ticket and request bill', async () => {
      await serve(own.qrItemId);
      own.phone = '09' + String(randomInt(0, 100_000_000)).padStart(8, '0');
      const customer = await api('POST', '/api/v1/customers', 201, 'cashier',
        { phone: own.phone, full_name: `SIT QA ${own.marker}`, consent: true });
      own.customerId = customer.id;
      const member = await api('POST', `/api/v1/public/qr/${own.token}/member`, 200,
        undefined, { phone: own.phone });
      checked(member, 'Member attached via customer token');
      await api('POST', `/api/v1/public/qr/${own.token}/request-bill`, 200);
      checked((await order()).status === 'BILLING', 'Customer requested bill');
    });
    await step(11, 'Billing table UI', async () => {
      await staffContext.close();
      const cashier = await login('qa3_cashier'); staffContext = cashier.context; staffPage = cashier.page;
      await staffPage.goto(`/tables/${own.tables.target.id}/summary`, { waitUntil: 'domcontentloaded' });
      await expect(staffPage.getByText(/Chờ thanh toán/i).first()).toBeVisible();
      checked((await table('target')).status === 'BILLING', 'Table in BILLING');
    });
    await step(12, 'Apply 10% reward and live payment total', async () => {
      const reward = await api('POST', '/api/v1/rewards', 201, 'admin',
        { name: `SIT QA 10 percent ${own.marker}`, reward_type: 'PERCENT',
          value: '10.00', min_order_amount: '0' });
      own.rewardId = reward.id;
      await staffPage!.reload({ waitUntil: 'domcontentloaded' });
      const attachMember = staffPage!.getByRole('button', {
        name: 'Gắn hội viên khách đã nhập trên QR', exact: true });
      // Existing members are linked by the public QR endpoint immediately;
      // the cashier button is present only for a pending member.
      if ((await order()).customer_id !== own.customerId) {
        await expect(attachMember).toBeVisible();
        await attachMember.click();
      }
      checked((await order()).customer_id === own.customerId, 'Cashier linked QR member');
      const initialBill = await order();
      const page = staffPage!;
      const panelAmounts = async () => {
        const value = async (id: string) => {
          const label = (await page.getByTestId(id).innerText({ timeout: 5_000 })).trim();
          const digits = label.replace(/[.\s₫đ]/g, '');
          if (!/^\d+$/.test(digits)) throw new Error('Expected whole VND in payment panel');
          return Number(digits);
        };
        return { total: await value('pay-total'), remaining: await value('pay-remaining') };
      };
      const initialUi = await panelAmounts();
      const expectedBefore = Number(initialBill.amount_due);
      expect(initialUi).toEqual({ total: expectedBefore, remaining: expectedBefore });
      const row = staffPage!.getByTestId('reward-row').filter({ hasText: reward.name });
      await expect(row).toBeVisible();
      const appliedResponse = staffPage!.waitForResponse(r => r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/api/v1/orders/${own.orders.main}/rewards`);
      await row.getByRole('button', { name: /^(Áp dụng(?: ưu đãi)?|Áp ưu đãi|Sử dụng)/i }).click();
      expect((await appliedResponse).status()).toBe(201);
      const current = await order();
      checked(current.applied_reward?.reward_id === own.rewardId, 'One owned reward applied');
      const liveLedger = await ledger();
      const discountedDue = Number(current.amount_due);
      const expectedAmounts = { total: discountedDue, remaining: discountedDue };
      const apiAmounts = { total: Number(liveLedger.summary.total),
        remaining: Number(liveLedger.summary.remaining) };
      report.discount = { before_ui_vnd: initialUi, before_due_vnd: expectedBefore,
        order_due_vnd: discountedDue, payment_api_vnd: apiAmounts, ui_stale: false };
      expect(discountedDue).toBeCloseTo(expectedBefore * 0.9, 2);
      expect(apiAmounts, 'Payment ledger agrees with discounted order').toEqual(expectedAmounts);
      const formatted = Number(current.amount_due).toLocaleString('vi-VN');
      await expect(staffPage!.locator('aside[aria-label="Tổng tiền"]')).toContainText(formatted,
        { timeout: 5_000 });
      // No reload: a stale payment total is an SIT failure, as BE acknowledged.
      const paymentTotal = staffPage!.getByTestId('pay-total');
      await expect(paymentTotal).toBeVisible();
      try {
        await expect.poll(panelAmounts, { timeout: 5_000,
          message: 'Payment panel must match discounted ledger without reloading' }).toEqual(expectedAmounts);
      } catch (error) {
        report.discount.after_apply_ui_vnd = await panelAmounts();
        report.discount.ui_stale = report.discount.after_apply_ui_vnd.total !== discountedDue ||
          report.discount.after_apply_ui_vnd.remaining !== discountedDue;
        await page.locator('.nova-payment-totals').screenshot({ path: imagePath('payment_totals') });
        if (report.discount.ui_stale) {
          // Verify BE's workaround only after the no-reload assertion has failed.
          await page.reload({ waitUntil: 'domcontentloaded' });
          report.discount.after_reload_ui_vnd = await panelAmounts();
        }
        throw error;
      }
      report.discount.after_apply_ui_vnd = await panelAmounts();
      await page.locator('.nova-payment-totals').screenshot({ path: imagePath('payment_totals') });
    });
    await step(13, 'Partial CASH and pending VNPay', async () => {
      const due = Number((await order()).amount_due);
      const cash = Math.floor(due / 2);
      checked(cash > 0, 'Positive partial cash amount');
      const amount = cash.toFixed(2);
      const first = await api('POST', `/api/v1/orders/${own.orders.main}/payments`, 201,
        'cashier', { method: 'CASH', amount, cash_received: amount });
      own.cashPaymentId = first.payment?.id;
      const link = await api('POST', `/api/v1/orders/${own.orders.main}/payments`, 201,
        'cashier', { method: 'VNPAY' });
      own.paymentId = link.payment?.id;
      own.paymentUrl = link.payment?.payment_url;
      checked(own.paymentId && link.payment?.status === 'PENDING' &&
        new URL(own.paymentUrl).origin === 'https://sandbox.vnpayment.vn', 'Pending signed sandbox link');
      expect(Number(first.payment?.amount)).toBe(cash);
      expect(first.payment?.status).toBe('SUCCEEDED');
      expect(Number(link.payment?.amount)).toBe(due - cash);
      report.payment = { cash_vnd: cash, vnpay_vnd: Number(link.payment.amount),
        vnpay_initial_status: link.payment.status };
      checked((await order()).status === 'BILLING', 'Bill remains unpaid while VNPay pending');
    });
    await step(14, 'Signed sandbox Return settles remainder', async () => {
      // VNPay publishes this NCB card/OTP strictly for sandbox use.
      const payment = await browser.newContext({ acceptDownloads: false });
      const page = await payment.newPage();
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(30_000);
      const navigation = { request_started: false, document_http: [] as number[],
        page_committed: false, signed_return_seen: false };
      report.vnpay_navigation = navigation;
      report.sandbox_runtime = { page_errors: [], failed_resources: [], posts: [], dialogs: [] };
      page.on('pageerror', error => report.sandbox_runtime.page_errors.push(safe(error)));
      page.on('requestfailed', req => report.sandbox_runtime.failed_resources.push({
        path: new URL(req.url()).pathname, error: req.failure()?.errorText }));
      page.on('response', res => {
        if (res.request().method() === 'POST') report.sandbox_runtime.posts.push({
          path: new URL(res.url()).pathname, status: res.status() });
      });
      page.on('dialog', async dialog => {
        report.sandbox_runtime.dialogs.push({ type: dialog.type(), message: safe(dialog.message()) });
        await dialog.accept();
      });
      page.on('request', req => {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() &&
          new URL(req.url()).origin === 'https://sandbox.vnpayment.vn') navigation.request_started = true;
      });
      page.on('response', res => {
        if (res.request().isNavigationRequest() && res.request().frame() === page.mainFrame() &&
          new URL(res.url()).origin === 'https://sandbox.vnpayment.vn') navigation.document_http.push(res.status());
      });
      try {
        // The sandbox can keep subresources open; wait for the response commit,
        // then let each visible control establish UI readiness.
        await page.goto(own.paymentUrl, { waitUntil: 'commit', timeout: 60_000 });
        navigation.page_committed = true;
        await page.getByText('Thẻ nội địa và tài khoản ngân hàng').click();
        const bankMethods = page.locator('button[name="paymethod"]');
        const bankCodes = await bankMethods.evaluateAll(nodes =>
          nodes.map(node => node.getAttribute('value')));
        report.sandbox_bank_codes = bankCodes;
        expect(bankCodes.filter(code => code === 'NCB'), 'Exactly one NCB form method').toHaveLength(1);
        await page.locator('button[name="paymethod"][value="NCB"]').click();
        await page.locator('#card_number_mask').pressSequentially('9704198526191432198');
        await page.getByRole('textbox', { name: /tên chủ thẻ/i }).fill('NGUYEN VAN A');
        await page.locator('#cardDate').pressSequentially('0715');
        report.sandbox_field_states = await page.locator('input')
          .evaluateAll(nodes => nodes.filter(node => /card/i.test(node.name || node.id))
            .map(node => ({name: node.name, id: node.id, type: node.type,
              filled: node.value.length > 0, length: node.value.length, valid: node.validity.valid})));
        report.sandbox_action_labels = await page.locator('button:visible, a:visible, input[type="submit"]:visible')
          .evaluateAll(nodes => nodes.map(node => ({tag: node.tagName,
            label: node.textContent?.trim().slice(0, 80), id: node.getAttribute('id')})))
          .then(rows => JSON.parse(safe(JSON.stringify(rows))));
        report.sandbox_continue = await page.locator('#btnContinue').evaluate(node => ({
          tag: node.tagName, onclick: node.getAttribute('onclick'),
          disabled: node.getAttribute('disabled'), class: node.getAttribute('class') }));
        await page.locator('#btnContinue').click();
        await page.getByRole('textbox', { name: /OTP|mã xác thực/i }).fill('123456');
        await page.getByText(/^(Xác nhận|Thanh toán)$/i).click();
        await page.waitForURL(url => url.origin === base &&
          url.pathname === '/api/v1/payments/vnpay/return', { timeout: 120_000 });
        navigation.signed_return_seen = true;
        checked(/Thanh toán thành công/i.test(await page.locator('body').innerText()),
          'Signed VNPay Return succeeded');
      } catch (error) {
        report.sandbox_page_text = await page.locator('body').innerText()
          .then(text => safe(text).replace(/\d{6,}/g, '<NUMBER>').slice(0, 5000)).catch(() => '');
        report.sandbox_validation = await page.locator('[role="alert"], .field-validation-error, .invalid-feedback, .text-danger, .error')
          .allTextContents().then(rows => rows.filter(text => text.trim()).map(text => safe(text.trim()).slice(0, 200)))
          .catch(() => []);
        report.sandbox_controls = await page.locator('input:not([type="hidden"]):visible, button:visible, select:visible, img:visible')
          .evaluateAll(nodes => nodes.slice(0, 30).map(node => ({
            tag: node.tagName, type: node.getAttribute('type'),
            alt: node.getAttribute('alt'), title: node.getAttribute('title'),
            name: node.getAttribute('name'), id: node.getAttribute('id'),
            method_value: node.tagName === 'BUTTON' && node.getAttribute('name') === 'paymethod' ? node.getAttribute('value') : null,
            label: node.getAttribute('aria-label'),
            placeholder: node.getAttribute('placeholder'),
            text: node.tagName === 'BUTTON' ? node.textContent?.trim().slice(0, 60) : null,
          }))).then(rows => JSON.parse(safe(JSON.stringify(rows))))
          .catch(() => []);
        const paymentBeforeCleanup = (await ledger()).payments?.find((p: any) => p.id === own.paymentId);
        report.payment.vnpay_before_cleanup = paymentBeforeCleanup?.status ?? null;
        if (!navigation.page_committed && error instanceof Error && error.name === 'TimeoutError')
          throw new Error('BLOCKED_ENV: VNPay sandbox navigation timed out before page commit (60000ms).');
        throw error;
      } finally { await payment.close(); }
      const bill = await order(), payments = await ledger();
      checked(bill.status === 'PAID' && payments.payments.filter((p: any) =>
        [own.cashPaymentId, own.paymentId].includes(p.id) && p.status === 'SUCCEEDED').length === 2 &&
        money(payments.summary.remaining) === 0, 'Exactly two successful payments settle bill');
    });
    await step(15, 'Loyalty earn once', async () => {
      const points = await api('GET', `/api/v1/customers/${own.customerId}/points?limit=200`,
        200, 'cashier');
      checked(points.filter((p: any) => p.order_id === own.orders.main &&
        p.entry_type === 'EARN').length === 1, 'One EARN for paid master order');
    });
    await step(16, 'Audit and filtered CSV export', async () => {
      const rows = await audit();
      const transfer = await api('GET', `/api/v1/audit-logs?entity_id=${own.sessions.main}` +
        '&entity_type=table_session&action=TABLE_TRANSFERRED&limit=100', 200, 'admin');
      checked(transfer.filter((r: any) => r.action === 'TABLE_TRANSFERRED').length === 1 &&
        rows.some((r: any) => r.action === 'ORDER_PAID') &&
        rows.every((r: any) => r.action && r.created_at), 'Actor and time audit coverage');
      const exported = await raw('GET', `/api/v1/audit-logs/export?order_id=${own.orders.main}`,
        'admin');
      expect(exported.status).toBe(200);
      checked(/csv/i.test(exported.response.headers()['content-type'] || ''), 'Filtered audit CSV');
    });
  } catch (error) { failure = error; }
  await staffContext?.close().catch(() => {});
  try { if (tokens.waiter && own.menu) await cleanup(); }
  catch (error) { cleanupError = error; }
  try { report.build_after = await version(); } catch { report.build_after = null; }
  report.build_stable = !!before && before === report.build_after;
  report.result = !failure && !cleanupError && report.cleanup_pass && report.build_stable &&
    report.steps.every((s: any) => s.status === 'PASSED') ? 'PASSED' :
    cleanupError || report.steps.some((s: any) => s.status === 'BLOCKED') ? 'INCONCLUSIVE' : 'FAILED';
  report.blocked_steps = report.steps.filter((s: any) => s.status === 'BLOCKED').map((s: any) => s.id);
  report.not_executed_steps = report.steps.filter((s: any) => s.status === 'NOT_EXECUTED').map((s: any) => s.id);
  report.failed_steps = report.steps.filter((s: any) => s.status === 'FAILED').map((s: any) => s.id);
  if (failure) report.error = safe(failure);
  if (cleanupError) report.cleanup_required = safe(cleanupError);
  delete own.paymentUrl;
  const evidence = JSON.stringify(report, null, 2) + '\n';
  const filename = `SIT_POS_001_${report.run_id}.json`;
  writeFileSync(join(evidenceDir, filename), evidence);
  console.log(`[SIT-POS-001] Evidence: evidence/sit-pos-001/${filename}; result=${report.result}; ` +
    `passed_steps=${report.steps.filter((s: any) => s.status === 'PASSED').length}/16`);
  if (cleanupError) throw new Error(safe(cleanupError));
  if (failure) throw new Error(safe(failure));
  expect(report.result).toBe('PASSED');
});
