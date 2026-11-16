import { test, expect } from '@playwright/test';

// Anonymous route readiness only. Authenticated screen and Customer menu
// behavior have separate tests; a login redirect is not a business UI PASS.
const routes = [
  { ref: 'PF-UI-ROUTE-001', path: '/pos', heading: 'Chào mừng trở lại' },
  { ref: 'PF-UI-ROUTE-002', path: '/kitchen', heading: 'Sẵn sàng cho ca bếp' },
  { ref: 'PF-UI-ROUTE-003', path: '/customer', heading: 'Chào mừng trở lại' },
  { ref: 'PF-UI-ROUTE-004', path: '/admin', heading: 'Chào mừng trở lại' },
] as const;

test.describe('POS System | anonymous route guard smoke', () => {
  for (const { ref, path, heading } of routes) {
    test(`${ref} | ${path} redirects to login without a session`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Tên đăng nhập' })).toBeVisible();
      await expect(page.getByLabel('Mật khẩu', { exact: true })).toBeVisible();
    });
  }
});


// Authenticated mobile web smoke. The complete order → KDS → pay → clean
// business flow remains in s2_pr37_39_ui_lifecycle_isolated.spec.ts
// (S2-UI-BIZ-01 / QA3-REHEARSAL-01); this suite never creates an order.
// Local: set S2_STAGING_PIN securely and POS_EXPECTED_COMMIT to the live SHA.
// In CI without a PIN these cases are skipped and must not be counted as Pass.
test.describe('POS System | authenticated role navigation (read-only)', () => {
  for (const { ref, role, home, apiPath, nextPath } of [
    { ref: 'PF-UI-AUTH-001', role: 'waiter', home: '/tables',
      apiPath: '/api/v1/tables', nextPath: '/tables' },
    { ref: 'PF-UI-AUTH-002', role: 'kitchen', home: '/kitchen',
      apiPath: '/api/v1/kitchen/queue', nextPath: '/kitchen' },
    { ref: 'PF-UI-AUTH-003', role: 'admin', home: '/tables',
      apiPath: '/api/v1/staff', nextPath: '/admin/staff' },
  ] as const) {
    test(`${ref} | ${role} logs in and opens allowed screen`, async ({ page, request }, testInfo) => {
      test.setTimeout(60_000);
      const pin = process.env.S2_STAGING_PIN;
      test.skip(!pin, 'S2_STAGING_PIN required; authenticated UI was not executed');
      const baseUrl = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      expect(baseUrl, 'approved staging origin').toBe('http://160.191.47.17');
      const versionBefore = await request.get(baseUrl + '/version', { timeout: 20_000 });
      expect(versionBefore.status(), 'staging version before').toBe(200);
      const build = (await versionBefore.json()).commit as string;
      expect(build).toMatch(/^[0-9a-f]{40}$/);
      if (process.env.POS_EXPECTED_COMMIT) {
        expect(build, 'expected staging SHA').toBe(process.env.POS_EXPECTED_COMMIT);
      }

      const unexpectedWrites: string[] = [];
      const observedGets: Array<{ path: string; status: number }> = [];
      page.on('request', req => {
        const path = new URL(req.url()).pathname;
        if (path.startsWith('/api/v1/') &&
            !['GET', 'HEAD'].includes(req.method()) &&
            path !== '/api/v1/auth/login') unexpectedWrites.push(`${req.method()} ${path}`);
      });
      page.on('response', res => {
        if (res.request().method() !== 'GET') return;
        const path = new URL(res.url()).pathname;
        if (path.startsWith('/api/v1/')) observedGets.push({ path, status: res.status() });
      });

      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill(role);
      await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
      const [login] = await Promise.all([
        page.waitForResponse(res => new URL(res.url()).pathname === '/api/v1/auth/login' &&
          res.request().method() === 'POST', { timeout: 20_000 }),
        page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(),
      ]);
      expect(login.status(), `${role} login`).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${home}$`), { timeout: 15_000 });
      if (nextPath !== home) await page.goto(nextPath, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(new RegExp(`${nextPath}$`), { timeout: 15_000 });
      await expect.poll(() => observedGets.some(row =>
        row.path === apiPath && row.status === 200),
        { timeout: 15_000, message: `${role} should read ${apiPath}` }).toBe(true);
      expect(unexpectedWrites, 'no business mutation').toEqual([]);
      const versionAfter = await request.get(baseUrl + '/version', { timeout: 20_000 });
      expect(versionAfter.status(), 'staging version after').toBe(200);
      expect((await versionAfter.json()).commit, 'stable build').toBe(build);
      await testInfo.attach(`${ref}_screen`, {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      await testInfo.attach(`${ref}_readiness`, {
        body: JSON.stringify({
          test_ref: ref, role, build, project: testInfo.project.name, home, nextPath,
          observedGets, unexpectedWrites, scope: 'login and read-only role navigation',
        }, null, 2),
        contentType: 'application/json',
      });
    });
  }
});


// S4-UX-001: unauthenticated navigation stability beyond the one-shot PF route checks.
// One test, read-only, with no credentials or owned fixture required.
test('S4-UX-001 | anonymous tables remain protected after refresh and history', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
  expect(base, 'approved staging origin').toBe('http://160.191.47.17');
  const before = await request.get(base + '/version', { timeout: 20_000 });
  expect(before.status(), 'version before UI test').toBe(200);
  const build = (await before.json()).commit as string;
  expect(build).toMatch(/^[0-9a-f]{40}$/);
  if (process.env.POS_EXPECTED_COMMIT) {
    expect(build, 'pinned staging build').toBe(process.env.POS_EXPECTED_COMMIT);
  }

  const tableReads: Array<{ status: number }> = [];
  const businessWrites: string[] = [];
  page.on('response', response => {
    const u = new URL(response.url());
    if (u.origin === base && u.pathname === '/api/v1/tables' &&
        response.request().method() === 'GET') {
      tableReads.push({ status: response.status() });
    }
  });
  page.on('request', req => {
    const u = new URL(req.url());
    if (u.origin === base && u.pathname.startsWith('/api/v1/') &&
        !['GET', 'HEAD'].includes(req.method())) {
      businessWrites.push(req.method() + ' ' + u.pathname);
    }
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Mật khẩu', { exact: true })).toBeVisible();
  await page.goto('/tables', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
  await expect(page.getByLabel('Mật khẩu', { exact: true })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
  await expect(page.getByLabel('Mật khẩu', { exact: true })).toBeVisible();

  expect(tableReads.filter(x => x.status === 200), 'no table list was exposed').toEqual([]);
  expect(businessWrites, 'no API mutation').toEqual([]);
  const after = await request.get(base + '/version', { timeout: 20_000 });
  expect(after.status(), 'version after UI test').toBe(200);
  expect((await after.json()).commit, 'stable staging build').toBe(build);

  const evidence = {
    test_ref: 'S4-UX-001',
    result: 'PASSED',
    build,
    project: testInfo.project.name,
    scope: 'anonymous /tables redirect, refresh and Back/Forward; API reads and no writes',
    final_path: new URL(page.url()).pathname,
    table_get_statuses: tableReads.map(x => x.status),
    business_writes: businessWrites,
    secrets_recorded: false
  };
  await testInfo.attach('S4_UX_001_evidence', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json'
  });
  await testInfo.attach('S4_UX_001_login_screen', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png'
  });
  console.log('S4_UX_001_EVIDENCE=' + JSON.stringify(evidence));
});
