import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-004 | QA3 kitchen stays in KDS and cannot open payment or staff',
  async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX004',
      test_ref: 'S4-UX-004', checked_at: new Date().toISOString(),
      scope: 'QA3 KITCHEN reads KDS tabs and stations; payment and staff routes and protected API denied, no order or ledger write; existing queue may be empty; read-only.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], reads: [], tabs: [], routes: [], checks: {},
      mutations: 0, cleanup_required: false,
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
    const kitchen = await login('qa3_kitchen', 'KITCHEN');
    const supervisor = await login('qa3_admin', 'SUPERVISOR');
    expect(kitchen.staff.outlet_id).toBe(supervisor.staff.outlet_id);
    report.qa3_outlet_id = kitchen.staff.outlet_id;
    const token = kitchen.access_token as string;
    async function get(path: string, authToken = token) {
      const response = await request.get(base + path, {
        headers: { Authorization: 'Bearer ' + authToken }, timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    const tables = await get('/api/v1/tables', supervisor.access_token);
    expect(tables.http).toBe(200);
    const qa3Table = (tables.body as any[]).find(row => row.code === 'Q3-1');
    expect(qa3Table?.id).toBeTruthy();
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.request().method() === 'GET' && path.startsWith('/api/v1/'))
        report.reads.push({ path, http: response.status() });
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
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_kitchen');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/kitchen$/, { timeout: 15_000 });
      const nav = page.getByRole('navigation');
      report.nav = {
        kds_visible: await nav.getByRole('link', { name: 'Bếp', exact: true }).isVisible(),
        tables_hidden: await nav.getByRole('link', { name: 'Bàn', exact: true }).count() === 0,
        staff_hidden: await nav.getByRole('link', { name: 'Nhân viên', exact: true }).count() === 0,
      };
      const labels = ['Món mới', 'Đang chế biến', 'Món trễ', 'Sẵn sàng'];
      for (const label of labels) {
        const tab = page.getByRole('tab', { name: label, exact: true });
        await expect(tab).toBeVisible();
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        report.tabs.push(label);
      }
      const stations = await get('/api/v1/kitchen/stations');
      const queue = await get('/api/v1/kitchen/queue');
      report.http = { stations: stations.http, queue: queue.http };
      report.station_count = Array.isArray(stations.body) ? stations.body.length : null;
      report.queue_count = Array.isArray(queue.body) ? queue.body.length : null;
      await expect(page.getByLabel('Trạm bếp')).toBeVisible();
      await testInfo.attach('S4_UX_004_kds', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      for (const route of [
        '/tables/' + qa3Table.id + '/summary', '/admin/staff', '/tables',
      ]) {
        await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await expect(page).toHaveURL(/\/kitchen$/, { timeout: 15_000 });
        report.routes.push({ attempted: route,
          landed: new URL(page.url()).pathname,
          protected_dom: (await page.getByRole('heading',
            { name: /Quản trị nhân viên|Thanh toán|Bàn Q3-1/ }).count()) > 0 });
      }
      report.http.staff = (await get('/api/v1/staff')).http;
      report.http.tables = (await get('/api/v1/tables')).http;
      report.checks = {
        kds_only_nav: Object.values(report.nav).every(Boolean),
        kds_tabs: report.tabs.length === 4,
        kds_reads: report.http.stations === 200 &&
          report.http.queue === 200 && report.station_count !== null &&
          report.queue_count !== null,
        payment_and_staff_route_denied: report.routes.length === 3 &&
          report.routes.every((row: any) => row.landed === '/kitchen' &&
            !row.protected_dom),
        protected_api_denied: report.http.staff === 403 &&
          report.http.tables === 403,
        no_protected_ui_read: !report.reads.some((row: any) =>
          ['/api/v1/staff', '/api/v1/tables'].includes(row.path) && row.http === 200),
        no_ui_business_write: report.ui_writes.length === 0,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Kitchen navigation guard mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = report.reads.length ? 'EXECUTED_READ_ONLY' :
      'PARTIAL_READ_ONLY';
    report.result = !failure && report.build_stable ? 'PASSED' : 'FAILED';
    if (failure) report.error = String(failure).replaceAll(pin!, '<REDACTED>')
      .replaceAll(token, '<REDACTED>')
      .replaceAll(supervisor.access_token, '<REDACTED>');
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_004_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_004_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-004] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-004] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
