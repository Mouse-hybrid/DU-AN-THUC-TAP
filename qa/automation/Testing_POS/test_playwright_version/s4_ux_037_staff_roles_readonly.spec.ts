import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test('S4-UX-037 | QA3 supervisor reads staff and roles; cashier is denied',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(90_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base, 'QA3 staging only').toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full pinned POS_EXPECTED_COMMIT required');

    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX037`,
      test_ref: 'S4-UX-037', checked_at: new Date().toISOString(),
      scope: 'QA3 SUPERVISOR reads staff and permissions UI; QA3 CASHIER cannot access permissions UI/API; read-only, no staff mutation',
      project: testInfo.project.name, secrets_recorded: false,
      mutations: 0, ui_writes: [], checks: {},
      cleanup_pass: true, cleanup_required: false,
    };
    const tokens: Record<string, string> = {};
    const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];
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
    const before = await build();
    test.skip(before !== expected,
      `PENDING_BUILD: staging ${before} differs from pinned ${expected}`);
    report.staging_commit = before;

    const outlets: Record<string, string> = {};
    for (const [role, username, expectedRole] of [
      ['supervisor', 'qa3_admin', 'SUPERVISOR'],
      ['cashier', 'qa3_cashier', 'CASHIER'],
    ]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status(), `${username} login`).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe(expectedRole);
      tokens[role] = body.access_token;
      outlets[role] = body.staff?.outlet_id;
      expect(tokens[role]).toBeTruthy();
      expect(outlets[role]).toBeTruthy();
    }
    expect(outlets.supervisor).toBe(outlets.cashier);
    report.qa3_outlet_id = outlets.supervisor;

    const reads: Array<{ role: string; path: string; status: number }> = [];
    const watch = (page: Page, role: string) => {
      page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (response.request().method() === 'GET' &&
            path.startsWith('/api/v1/'))
          reads.push({ role, path, status: response.status() });
      });
      page.on('request', req => {
        const path = new URL(req.url()).pathname;
        if (path.startsWith('/api/v1/') &&
            !['GET', 'HEAD'].includes(req.method()) &&
            path !== '/api/v1/auth/login')
          report.ui_writes.push(`${req.method()} ${path}`);
      });
    };
    async function uiLogin(role: 'supervisor' | 'cashier', username: string) {
      const context = await browser.newContext({ baseURL: base });
      contexts.push(context);
      const page = await context.newPage();
      watch(page, role);
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill(username);
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      const [login] = await Promise.all([
        page.waitForResponse(response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/auth/login',
          { timeout: 20_000 }),
        page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(),
      ]);
      expect(login.status()).toBe(200);
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      return page;
    }
    async function get(path: string, role: string) {
      const response = await request.get(base + path, {
        headers: { Authorization: `Bearer ${tokens[role]}` },
        timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    let failure: unknown;
    try {
      const supervisor = await uiLogin('supervisor', 'qa3_admin');
      const [staffResponse] = await Promise.all([
        supervisor.waitForResponse(response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/staff',
          { timeout: 20_000 }),
        supervisor.goto('/admin/staff',
          { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      ]);
      await expect(supervisor).toHaveURL(/\/admin\/staff$/);
      await expect(supervisor.getByRole('heading',
        { name: 'Quản trị nhân viên' })).toBeVisible();
      const staffBody = await staffResponse.json();
      const staffRows: any[] = Array.isArray(staffBody) ? staffBody :
        Array.isArray(staffBody?.items) ? staffBody.items : [];
      await testInfo.attach('S4_UX_037_staff', {
        body: await supervisor.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const [rolesResponse] = await Promise.all([
        supervisor.waitForResponse(response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/staff/permissions',
          { timeout: 20_000 }),
        supervisor.goto('/admin/roles',
          { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      ]);
      await expect(supervisor).toHaveURL(/\/admin\/roles$/);
      await expect(supervisor.getByRole('heading').first()).toBeVisible();
      const rolesBody = await rolesResponse.json();
      await testInfo.attach('S4_UX_037_roles', {
        body: await supervisor.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });

      const cashier = await uiLogin('cashier', 'qa3_cashier');
      await cashier.goto('/admin/roles',
        { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await expect(cashier).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const cashierPermissions = await get('/api/v1/staff/permissions', 'cashier');
      const cashierStaff = await get('/api/v1/staff', 'cashier');
      report.http = {
        supervisor_staff: staffResponse.status(),
        supervisor_permissions: rolesResponse.status(),
        cashier_permissions: cashierPermissions.http,
        cashier_staff: cashierStaff.http,
      };
      report.staff_rows = staffRows.length;
      report.staff_outlet_ids_present = staffRows.filter(row => row?.outlet_id).length;
      report.roles_body_present = !!rolesBody &&
        (Array.isArray(rolesBody) ? rolesBody.length > 0 :
          Object.keys(rolesBody).length > 0);
      report.cashier_final_path = new URL(cashier.url()).pathname;
      report.reads = reads;
      report.checks = {
        supervisor_staff_get: staffResponse.status() === 200 &&
          staffRows.length > 0,
        staff_scoped_to_qa3: staffRows.length > 0 &&
          staffRows.every(row => row?.outlet_id === outlets.supervisor),
        supervisor_permissions_get: rolesResponse.status() === 200 &&
          report.roles_body_present,
        cashier_route_denied: report.cashier_final_path === '/tables' &&
          !reads.some(row => row.role === 'cashier' &&
            row.path === '/api/v1/staff/permissions' && row.status === 200),
        cashier_api_denied: cashierPermissions.http === 403 &&
          cashierStaff.http === 403,
        no_ui_business_write: report.ui_writes.length === 0,
      };
      await testInfo.attach('S4_UX_037_cashier_guard', {
        body: await cashier.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Staff/roles read-only mismatch: ' +
          JSON.stringify(report.checks));
    } catch (error) { failure = error; }

    for (const context of contexts) await context.close().catch(() => {});
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = reads.length ? 'EXECUTED_READ_ONLY' : 'NOT_EXECUTED';
    report.result = !failure && report.build_stable ? 'PASSED' : 'FAILED';
    if (failure) report.error = redact(failure);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `S4_UX_037_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_037_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-037] Evidence: .\\evidence\\${name}`);
    console.log('[S4-UX-037] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
