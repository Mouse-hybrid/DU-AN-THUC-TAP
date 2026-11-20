import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-006 | QA3 table list, detail and read states stay scoped',
  async ({ page, request }, testInfo) => {
    test.setTimeout(110_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX006',
      test_ref: 'S4-UX-006', checked_at: new Date().toISOString(),
      scope: 'QA3 WAITER table list and Q3-1 detail match server, refresh; simulated browser-only empty and failed GET show states, recovery shows QA3 data; QA2 table IDs absent; read-only, no fixture.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], checks: {}, mutations: 0, cleanup_required: false,
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
    async function login(username: string, role: string) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(role);
      expect(body.access_token).toBeTruthy();
      return body;
    }
    const qa3 = await login('qa3_waiter', 'WAITER');
    const qa2 = await login('qa2_admin', 'SUPERVISOR');
    expect(qa3.staff.outlet_id).not.toBe(qa2.staff.outlet_id);
    async function get(path: string, token: string) {
      const response = await request.get(base + path, {
        headers: { Authorization: 'Bearer ' + token }, timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    const a = await get('/api/v1/tables', qa3.access_token);
    const b = await get('/api/v1/tables', qa2.access_token);
    expect(a.http).toBe(200);
    expect(b.http).toBe(200);
    expect(Array.isArray(a.body) && Array.isArray(b.body)).toBe(true);
    const own = a.body as any[], foreign = b.body as any[];
    const q31 = own.find(row => row.code === 'Q3-1');
    test.skip(!q31 || q31.status !== 'AVAILABLE',
      'PENDING_FIXTURE: QA3 Q3-1 must be AVAILABLE');
    const detail = await get('/api/v1/tables/' + q31.id, qa3.access_token);
    expect(detail.http).toBe(200);
    report.server = { qa3_codes: own.map(row => row.code),
      qa2_table_count: foreign.length, q31_status: q31.status,
      detail_status: detail.body?.status };
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        report.ui_writes.push(req.method() + ' ' + path);
    });
    const tableListPath = /\/api\/v1\/tables(?:\?|$)/;
    const pathOf = (url: string) => new URL(url).pathname;
    let failure: unknown;
    try {
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_waiter');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      for (const table of own)
        await expect(page.getByText(table.code, { exact: true }).first())
          .toBeVisible({ timeout: 15_000 });
      const qa3Ids = new Set(own.map(row => row.id));
      report.checks.list_scoped = foreign.length > 0 &&
        foreign.every(row => !qa3Ids.has(row.id)) &&
        foreign.every(row => !own.some(x => x.code === row.code));
      for (const table of foreign)
        expect(await page.getByText(table.code, { exact: true }).count()).toBe(0);
      await testInfo.attach('S4_UX_006_table_list', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const [detailResponse] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'GET' &&
          pathOf(response.url()) === '/api/v1/tables/' + q31.id,
        { timeout: 15_000 }),
        page.goto('/tables/' + q31.id,
          { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      ]);
      await expect(page.getByRole('heading', { name: 'Bàn Q3-1' }).first())
        .toBeVisible({ timeout: 15_000 });
      report.checks.detail_matches_server = detailResponse.status() === 200 &&
        detail.body?.id === q31.id && detail.body?.status === q31.status;
      await testInfo.attach('S4_UX_006_detail', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      let releaseList!: () => void;
      const listGate = new Promise<void>(resolve => { releaseList = resolve; });
      await page.route(tableListPath, async route => {
        await listGate;
        await route.continue().catch(() => {});
      });
      try {
        const refreshed = page.waitForResponse(response =>
          response.request().method() === 'GET' &&
          pathOf(response.url()) === '/api/v1/tables', { timeout: 15_000 });
        await page.goto('/tables', { waitUntil: 'domcontentloaded', timeout: 20_000 });
        const loading = page.getByText(/đang tải|đang lấy/i).first();
        await expect(loading).toBeVisible({ timeout: 8_000 });
        report.checks.loading_state = true;
        releaseList();
        expect((await refreshed).status()).toBe(200);
      } finally { releaseList(); await page.unroute(tableListPath); }
      await expect(page.getByText('Q3-1', { exact: true }).first()).toBeVisible();
      report.checks.refresh_matches_server = true;

      await page.route(tableListPath, route => route.fulfill({
        status: 200, contentType: 'application/json', body: '[]',
      }));
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        await expect(page.getByText('Q3-1', { exact: true })).toHaveCount(0);
        const empty = page.getByText(/chưa có bàn|không có bàn|không tìm thấy bàn/i).first();
        await expect(empty).toBeVisible({ timeout: 12_000 });
        report.empty_message = await empty.innerText();
        report.checks.empty_state = true;
        await testInfo.attach('S4_UX_006_empty', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
      } finally { await page.unroute(tableListPath); }

      await page.route(tableListPath, route => route.fulfill({
        status: 503, contentType: 'application/json',
        body: '{"detail":"QA read failure"}',
      }));
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
        const error = page.getByText(/không thể tải|lỗi tải|thử lại|không thể lấy/i).first();
        await expect(error).toBeVisible({ timeout: 15_000 });
        report.error_message = await error.innerText();
        report.checks.error_state = true;
        await testInfo.attach('S4_UX_006_error', {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
      } finally { await page.unroute(tableListPath); }

      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page.getByText('Q3-1', { exact: true }).first())
        .toBeVisible({ timeout: 15_000 });
      report.checks.recovered = true;
      report.checks.no_ui_business_write = report.ui_writes.length === 0;
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Table list/read states mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) {
      failure = error;
      report.ui_probe = {
        path: new URL(page.url()).pathname,
        headings: await page.getByRole('heading').allTextContents().catch(() => []),
        buttons: await page.getByRole('button').allTextContents().catch(() => []),
      };
    }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = 'EXECUTED_READ_ONLY';
    report.result = !failure && report.build_stable ? 'PASSED' : 'FAILED';
    if (failure) report.error = String(failure)
      .replaceAll(pin!, '<REDACTED>')
      .replaceAll(qa3.access_token, '<REDACTED>')
      .replaceAll(qa2.access_token, '<REDACTED>');
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_006_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_006_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-006] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-006] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
