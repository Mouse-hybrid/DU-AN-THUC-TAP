import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-002 | QA3 waiter sees tables and cannot open administration',
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
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX002',
      test_ref: 'S4-UX-002', checked_at: new Date().toISOString(),
      scope: 'QA3 WAITER sees permitted Tables; staff, roles and audit menu and direct URLs denied, Back remains on permitted UI; protected GETs denied and no protected DOM or business write; read-only.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], reads: [], routes: [], checks: {}, mutations: 0,
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
    const login = await request.post(base + '/api/v1/auth/login', {
      data: { username: 'qa3_waiter', password: pin }, timeout: 20_000,
    });
    expect(login.status()).toBe(200);
    const auth = await login.json();
    expect(auth.staff?.role).toBe('WAITER');
    const token = auth.access_token as string;
    expect(token).toBeTruthy();
    async function guardedGet(path: string) {
      const response = await request.get(base + path, {
        headers: { Authorization: 'Bearer ' + token }, timeout: 20_000,
      });
      return response.status();
    }
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
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_waiter');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await expect(page.getByRole('navigation').getByRole('link',
        { name: 'Bàn', exact: true })).toBeVisible();
      const tableRead = await guardedGet('/api/v1/tables');
      const nav = page.getByRole('navigation');
      report.nav_hidden = {
        staff: await nav.getByRole('link', { name: 'Nhân viên', exact: true }).count() === 0,
        roles: await nav.getByRole('link', { name: 'Vai trò', exact: true }).count() === 0,
        audit: await nav.getByRole('link', { name: 'Nhật ký', exact: true }).count() === 0,
      };
      await testInfo.attach('S4_UX_002_waiter_tables', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      for (const route of ['/admin/staff', '/admin/roles', '/admin/audit-logs']) {
        await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
        report.routes.push({ attempted: route, landed: new URL(page.url()).pathname,
          protected_dom: (await page.getByRole('heading',
            { name: /Quản trị nhân viên|Vai trò & quyền|Nhật ký hệ thống/ }).count()) > 0 });
      }
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      report.back_path = new URL(page.url()).pathname;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      report.after_reload_path = new URL(page.url()).pathname;
      await testInfo.attach('S4_UX_002_denied_routes', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      report.http = {
        tables: tableRead,
        staff: await guardedGet('/api/v1/staff'),
        permissions: await guardedGet('/api/v1/staff/permissions'),
        audit: await guardedGet('/api/v1/audit-logs'),
      };
      report.checks = {
        tables_permitted: tableRead === 200,
        admin_menu_hidden: Object.values(report.nav_hidden).every(Boolean),
        direct_routes_denied: report.routes.length === 3 &&
          report.routes.every((row: any) => row.landed === '/tables'),
        back_and_reload_safe: report.back_path === '/tables' &&
          report.after_reload_path === '/tables',
        protected_api_denied: report.http.staff === 403 &&
          report.http.permissions === 403 && report.http.audit === 403,
        no_protected_dom_or_read: report.routes.every((row: any) => !row.protected_dom) &&
          !report.reads.some((row: any) =>
            ['/api/v1/staff', '/api/v1/staff/permissions', '/api/v1/audit-logs']
              .includes(row.path) && row.http === 200),
        no_ui_business_write: report.ui_writes.length === 0,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Waiter route guard mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = report.reads.length ? 'EXECUTED_READ_ONLY' :
      'PARTIAL_READ_ONLY';
    report.result = !failure && report.build_stable ? 'PASSED' : 'FAILED';
    if (failure) report.error = String(failure).replaceAll(pin!, '<REDACTED>')
      .replaceAll(token, '<REDACTED>');
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_002_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_002_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-002] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-002] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
