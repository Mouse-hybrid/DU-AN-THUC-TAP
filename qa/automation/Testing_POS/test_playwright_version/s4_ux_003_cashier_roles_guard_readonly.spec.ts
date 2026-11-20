import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-003 | QA3 cashier cannot open roles by menu or URL',
  async ({ page, request }, testInfo) => {
    test.setTimeout(75_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX003',
      test_ref: 'S4-UX-003', checked_at: new Date().toISOString(),
      scope: 'QA3 CASHIER roles menu hidden; direct /admin/roles denied twice and refresh stays safe; staff/permissions GET denied, no role matrix or UI business write; read-only.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], reads: [], checks: {}, mutations: 0,
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
      data: { username: 'qa3_cashier', password: pin }, timeout: 20_000,
    });
    expect(login.status()).toBe(200);
    const auth = await login.json();
    expect(auth.staff?.role).toBe('CASHIER');
    const token = auth.access_token as string;
    expect(token).toBeTruthy();
    async function guardedGet(path: string) {
      const response = await request.get(base + path, {
        headers: { Authorization: 'Bearer ' + token }, timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(),
        matrix_exposed: JSON.stringify(body).includes('STAFF_MANAGE') &&
          response.status() === 200 };
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
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_cashier');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const nav = page.getByRole('navigation');
      report.menu_roles_count = await nav.getByRole('link',
        { name: 'Vai trò', exact: true }).count();
      await testInfo.attach('S4_UX_003_cashier_menu', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      await page.goto('/admin/roles',
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      report.first_guard_path = new URL(page.url()).pathname;
      await page.goto('/admin/roles',
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      report.after_refresh_path = new URL(page.url()).pathname;
      report.roles_heading_count = await page.getByText('Vai trò & quyền',
        { exact: true }).count();
      await testInfo.attach('S4_UX_003_direct_and_refresh', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const permissions = await guardedGet('/api/v1/staff/permissions');
      const staff = await guardedGet('/api/v1/staff');
      report.http = { permissions: permissions.http, staff: staff.http };
      report.checks = {
        menu_hidden: report.menu_roles_count === 0,
        direct_route_denied: report.first_guard_path === '/tables',
        refresh_safe: report.after_refresh_path === '/tables' &&
          report.roles_heading_count === 0,
        permissions_api_denied: permissions.http === 403 &&
          staff.http === 403 && !permissions.matrix_exposed,
        no_protected_ui_read: !report.reads.some((row: any) =>
          row.path === '/api/v1/staff/permissions' && row.http === 200),
        no_ui_business_write: report.ui_writes.length === 0,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Cashier roles guard mismatch: ' +
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
    const name = 'S4_UX_003_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_003_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-003] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-003] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
