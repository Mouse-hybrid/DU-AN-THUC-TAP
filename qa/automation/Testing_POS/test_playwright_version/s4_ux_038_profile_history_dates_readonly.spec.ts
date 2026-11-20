import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-038 | QA3 profile and history date ranges remain scoped',
  async ({ page, request }, testInfo) => {
    test.setTimeout(100_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX038',
      test_ref: 'S4-UX-038', checked_at: new Date().toISOString(),
      scope: 'QA3 SUPERVISOR reads own profile and history UI, switches Today/7/30-day GET ranges; server order list scoped to QA3 tables, QA2 cannot read one QA3 closed order; no UI business write.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], ranges: [], checks: {}, mutations: 0,
      cleanup_required: false,
    };
    async function build() {
      const response = await request.get(base + '/version', { timeout: 20_000 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.environment).toBe('staging');
      return body.commit as string;
    }
    const before = await build();
    test.skip(before !== expected, 'PENDING_BUILD: staging SHA changed');
    report.staging_commit = before;
    const tokens: Record<string, string> = {};
    const outlets: Record<string, string> = {};
    for (const [key, username] of [['qa3', 'qa3_admin'], ['qa2', 'qa2_admin']]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status(), username + ' login').toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe('SUPERVISOR');
      tokens[key] = body.access_token;
      outlets[key] = body.staff?.outlet_id;
      expect(tokens[key]).toBeTruthy();
    }
    expect(outlets.qa3).not.toBe(outlets.qa2);
    async function get(path: string, role: string) {
      const response = await request.get(base + path, {
        headers: { Authorization: 'Bearer ' + tokens[role] }, timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status(), body };
    }
    const ownTables = await get('/api/v1/tables', 'qa3');
    expect(ownTables.status).toBe(200);
    const tableIds = new Set((ownTables.body as any[]).map(row => row.id));
    expect(tableIds.size).toBeGreaterThan(0);
    const recent = await get('/api/v1/orders?status=CLOSED&limit=200', 'qa3');
    expect(recent.status).toBe(200);
    const ownClosed = (recent.body as any[]).find(row => tableIds.has(row.table_id));
    test.skip(!ownClosed, 'PENDING_FIXTURE: QA3 CLOSED order required');
    const ownEntity = await get('/api/v1/orders/' + ownClosed.id, 'qa3');
    const foreign = await get('/api/v1/orders/' + ownClosed.id, 'qa2');
    report.outlet_probe = { qa3_closed_order_id: ownClosed.id,
      qa3_table_count: tableIds.size, qa3_order_http: ownEntity.status,
      qa2_order_http: foreign.status,
      qa2_contains_order_id: JSON.stringify(foreign.body).includes(ownClosed.id) };
    const uiReads: Array<{ path: string; status: number }> = [];
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.request().method() === 'GET' && path.startsWith('/api/v1/'))
        uiReads.push({ path, status: response.status() });
    });
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        report.ui_writes.push(req.method() + ' ' + path);
    });
    let failure: unknown;
    try {
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.goto('/profile', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page.getByRole('heading', { name: 'Hồ sơ của tôi' })).toBeVisible();
      await expect(page.locator('.nova-profile-list dd').first())
        .toHaveText('qa3_admin', { timeout: 15_000 });
      report.checks.own_profile = true;
      await testInfo.attach('S4_UX_038_profile', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const first = page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' &&
          url.pathname === '/api/v1/orders' &&
          url.searchParams.get('offset') === '0';
      }, { timeout: 20_000 });
      await page.goto('/history', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const today = await first;
      await expect(page.getByRole('heading', { name: 'Lịch sử đơn hàng' }))
        .toBeVisible();
      await expect(page.getByRole('searchbox',
        { name: 'Tìm theo mã đơn hoặc bàn' })).toBeVisible();
      const capture = async (label: string, response: typeof today) => {
        const url = new URL(response.url());
        const rows = await response.json() as any[];
        const control = page.getByRole('button', { name: label, exact: true });
        await expect(control).toHaveAttribute('aria-pressed', 'true');
        const result = { label, status: response.status(),
          created_from: url.searchParams.get('created_from'),
          rows: rows.length,
          all_rows_scoped: rows.every(row => tableIds.has(row.table_id)) };
        report.ranges.push(result);
        await testInfo.attach('S4_UX_038_' + label.replaceAll(' ', '_'), {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
      };
      await capture('Hôm nay', today);
      for (const [label, min, max] of [
        ['7 ngày', 5.5, 8.5], ['30 ngày', 28, 31.5],
      ] as const) {
        const responsePromise = page.waitForResponse(response => {
          const url = new URL(response.url());
          const created = url.searchParams.get('created_from');
          const age = created ? (Date.now() - Date.parse(created)) / 86_400_000 : NaN;
          return response.request().method() === 'GET' &&
            url.pathname === '/api/v1/orders' &&
            url.searchParams.get('offset') === '0' &&
            age >= min && age <= max;
        }, { timeout: 20_000 });
        await page.getByRole('button', { name: label, exact: true }).click();
        await capture(label, await responsePromise);
      }
      const [day, week, month] = report.ranges;
      report.checks = {
        own_profile: report.checks.own_profile &&
          uiReads.some(row => row.path === '/api/v1/auth/me' && row.status === 200),
        history_ranges: report.ranges.length === 3 && day.rows > 0 &&
          report.ranges.every((row: any) => row.status === 200 &&
            row.created_from && Number.isFinite(Date.parse(row.created_from)) &&
            row.all_rows_scoped) &&
          Date.parse(day.created_from) > Date.parse(week.created_from) &&
          Date.parse(week.created_from) > Date.parse(month.created_from),
        foreign_order_isolated: ownEntity.status === 200 &&
          [403, 404].includes(foreign.status) &&
          !report.outlet_probe.qa2_contains_order_id,
        no_ui_business_write: report.ui_writes.length === 0,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Profile/history scope mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = report.ranges.length ? 'EXECUTED_READ_ONLY' :
      'PARTIAL_READ_ONLY';
    report.result = !failure && report.build_stable ? 'PASSED' : 'FAILED';
    if (failure) {
      let message = String(failure).replaceAll(pin!, '<REDACTED>');
      for (const token of Object.values(tokens))
        if (token) message = message.replaceAll(token, '<REDACTED>');
      report.error = message;
    }
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_038_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_038_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-038] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-038] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
