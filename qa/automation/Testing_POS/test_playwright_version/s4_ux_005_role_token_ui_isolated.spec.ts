import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-005 | stale staff tab loses access after role change and lock',
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
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX005',
      test_ref: 'S4-UX-005', checked_at: new Date().toISOString(),
      scope: 'Owned QA3 WAITER tab loses old token after SUPERVISOR role change; fresh CASHIER login has new permission; lock revokes fresh tab; no seed staff altered.',
      project: testInfo.project.name, secrets_recorded: false,
      checks: {}, ui_writes: [], cleanup_pass: false,
    };
    let adminToken = '', staffId = '', username = '', password = '';
    let oldToken = '', freshToken = '';
    const redact = (error: unknown) => {
      let value = String(error);
      for (const secret of [pin, adminToken, password, oldToken, freshToken])
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
    test.skip(before !== expected, 'PENDING_BUILD: staging SHA differs');
    report.staging_commit = before;
    async function api(method: 'GET' | 'POST' | 'PATCH', path: string,
      token?: string, data?: object) {
      const response = await request.fetch(base + path, {
        method,
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(method !== 'GET' && path !== '/api/v1/auth/login' ?
            { 'Idempotency-Key': randomUUID() } : {}),
        },
        ...(data ? { data } : {}), timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    async function login(name: string, secret: string) {
      return api('POST', '/api/v1/auth/login', undefined,
        { username: name, password: secret });
    }
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        report.ui_writes.push(req.method() + ' ' + path);
    });
    let failure: unknown;
    try {
      const admin = await login('qa3_admin', pin!);
      expect(admin.http).toBe(200);
      adminToken = admin.body?.access_token;
      expect(adminToken).toBeTruthy();
      const adminMe = await api('GET', '/api/v1/auth/me', adminToken);
      expect(adminMe.http).toBe(200);
      expect(adminMe.body?.role).toBe('SUPERVISOR');
      expect(adminMe.body?.outlet_id).toBeTruthy();
      username = 'qa_s4ux005_' + Date.now() + '_' + randomBytes(3).toString('hex');
      report.fixture_username = username;
      password = randomBytes(24).toString('hex');
      const created = await api('POST', '/api/v1/staff', adminToken,
        { username, password, full_name: 'QA S4UX005 isolated', role: 'WAITER' });
      staffId = created.body?.id || '';
      report.http = { create: created.http };
      expect(created.http).toBe(201);
      expect(staffId).toBeTruthy();
      expect(created.body?.outlet_id).toBe(adminMe.body.outlet_id);
      report.fixture_staff_id = staffId;

      await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill(username);
      await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
      const [oldLogin] = await Promise.all([
        page.waitForResponse(res => new URL(res.url()).pathname ===
          '/api/v1/auth/login' && res.request().method() === 'POST'),
        page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(),
      ]);
      expect(oldLogin.status()).toBe(200);
      oldToken = (await oldLogin.json()).access_token;
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const oldMe = await api('GET', '/api/v1/auth/me', oldToken);
      expect(oldMe.http).toBe(200);
      expect(oldMe.body?.role).toBe('WAITER');
      await testInfo.attach('S4_UX_005_waiter', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });

      const changed = await api('PATCH', '/api/v1/staff/' + staffId,
        adminToken, { role: 'CASHIER' });
      report.http.role_change = changed.http;
      expect(changed.http).toBe(200);
      expect(changed.body?.role).toBe('CASHIER');
      const oldAfter = await api('GET', '/api/v1/auth/me', oldToken);
      report.http.old_token_after_change = oldAfter.http;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/login(?:\?|$)/, { timeout: 15_000 });
      report.old_tab_after_change = new URL(page.url()).pathname;

      await page.getByLabel('Tên đăng nhập', { exact: true }).fill(username);
      await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
      const [newLogin] = await Promise.all([
        page.waitForResponse(res => new URL(res.url()).pathname ===
          '/api/v1/auth/login' && res.request().method() === 'POST'),
        page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(),
      ]);
      expect(newLogin.status()).toBe(200);
      freshToken = (await newLogin.json()).access_token;
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      const fresh = await api('GET', '/api/v1/auth/me', freshToken);
      report.http.fresh_me = fresh.http;
      report.fresh_role = fresh.body?.role;
      await page.goto(base + '/admin/roles', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
      report.cashier_roles_guard = true;
      report.checks = {
        old_token_revoked: oldAfter.http === 401,
        old_tab_returned_to_login: report.old_tab_after_change === '/login',
        fresh_cashier_role: fresh.http === 200 &&
          fresh.body?.id === staffId && fresh.body?.role === 'CASHIER' &&
          fresh.body?.outlet_id === adminMe.body.outlet_id &&
          fresh.body?.permissions?.includes('PROCESS_PAYMENT') === true,
        cashier_roles_denied: report.cashier_roles_guard,
        no_ui_business_write: report.ui_writes.length === 0,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Role change UI mismatch: ' + JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    if (!staffId && username && adminToken) {
      try {
        const listed = await api('GET', '/api/v1/staff', adminToken);
        const rows = Array.isArray(listed.body) ? listed.body : listed.body?.items || [];
        const matches = rows.filter((row: any) => row.username === username);
        if (matches.length === 1) staffId = matches[0].id;
      } catch { /* evidence will flag cleanup below */ }
    }
    if (staffId && adminToken) {
      try {
        const locked = await api('POST', '/api/v1/staff/' + staffId + '/lock', adminToken);
        const state = await api('GET', '/api/v1/staff/' + staffId, adminToken);
        const tokenAfterLock = freshToken ?
          await api('GET', '/api/v1/auth/me', freshToken) : null;
        report.http = { ...report.http, lock: locked.http, verify: state.http,
          token_after_lock: tokenAfterLock?.http };
        report.cleanup_pass = [200, 409].includes(locked.http) &&
          state.http === 200 && state.body?.is_active === false;
        if (freshToken) report.checks.lock_revokes_fresh_token =
          tokenAfterLock?.http === 401;
      } catch (error) { report.cleanup_required = redact(error); }
    }
    if (username && !report.cleanup_pass)
      report.cleanup_required = 'CLEANUP REQUIRED: lock owned staff ' +
        (staffId || username);
    if (report.cleanup_pass && freshToken) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/login(?:\?|$)/, { timeout: 15_000 });
        report.checks.locked_tab_returned_to_login = true;
      } catch (error) {
        report.checks.locked_tab_returned_to_login = false;
        failure ??= error;
      }
    }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = staffId ? 'EXECUTED' : 'NOT_EXECUTED';
    report.result = !failure && report.cleanup_pass && report.build_stable &&
      Object.values(report.checks).every(Boolean) ? 'PASSED' :
      !report.cleanup_pass ? 'INCONCLUSIVE' : 'FAILED';
    if (failure) report.error = redact(failure);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_005_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_005_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-005] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-005] Result: ' + JSON.stringify(report));
    if (report.cleanup_required) throw new Error(report.cleanup_required);
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
    expect(report.result).toBe('PASSED');
  });
