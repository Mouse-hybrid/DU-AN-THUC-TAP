import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', trace: 'off', screenshot: 'off' });

test('PF-S4-UX-028 | discover CASHIER customer search entry point',
  async ({ browser, request }, testInfo) => {
    test.setTimeout(70_000);
    test.skip(testInfo.project.name !== 'chromium', 'Chromium only');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN || process.env.P2_QA_SEED_PASSWORD;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'Private QA PIN and pinned full staging SHA required');
    const beforeResponse = await request.get(base + '/version');
    expect(beforeResponse.status()).toBe(200);
    const version = await beforeResponse.json();
    expect(version.environment).toBe('staging');
    test.skip(version.commit !== expected, 'PENDING_BUILD: staging SHA differs');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX028ROUTE',
      test_ref: 'PF-S4-UX-028-ROUTE', checked_at: new Date().toISOString(),
      scope: 'QA3 CASHIER/WAITER authenticated navigation inventory for customer lookup; read-only route discovery, no customer PII captured and no S4-UX-028 business result.',
      staging_commit: version.commit, secrets_recorded: false,
      phone_recorded: false, mutations: 0, ui_writes: [], roles: {},
    };
    const contexts = [];
    let failure: unknown;
    try {
      for (const [role, username] of [
        ['cashier', 'qa3_cashier'], ['waiter', 'qa3_waiter']]) {
        const context = await browser.newContext({ baseURL: base });
        contexts.push(context);
        const page = await context.newPage();
        page.on('request', req => {
          const path = new URL(req.url()).pathname;
          if (path.startsWith('/api/v1/') &&
              !['GET', 'HEAD'].includes(req.method()) &&
              path !== '/api/v1/auth/login')
            report.ui_writes.push(req.method() + ' ' + path);
        });
        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await page.getByLabel('Tên đăng nhập', { exact: true }).fill(username);
        await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
        const [login] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/v1/auth/login',
          { timeout: 15_000 }),
          page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(),
        ]);
        expect(login.status(), username + ' login').toBe(200);
        await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
        const nav = await page.locator('a[href]').evaluateAll(links => links
          .map(a => ({ label: a.getAttribute('aria-label') || a.textContent?.trim() || '',
            path: new URL((a as HTMLAnchorElement).href).pathname }))
          .filter(row => /khách|customer|reward|tích điểm|loyalty/i.test(
            row.label + ' ' + row.path))
          .map(row => ({ label: row.label.replace(/\d{4,}/g, '<NUMBER>').slice(0, 80),
            path: row.path })));
        const controls = await page.getByRole('button').evaluateAll(buttons => buttons
          .map(button => ({ label: button.getAttribute('aria-label') ||
            button.textContent?.trim() || '' }))
          .filter(row => /khách|customer|tích điểm|tra cứu/i.test(row.label))
          .map(row => row.label.replace(/\d{4,}/g, '<NUMBER>').slice(0, 80)));
        report.roles[role] = { route: new URL(page.url()).pathname,
          customer_nav: nav, customer_controls: controls };
      }
      report.result = 'READONLY_ROUTE_RECORDED';
    } catch (error) {
      failure = error;
      report.result = 'INCONCLUSIVE';
      report.error = String(error).replaceAll(pin!, '<REDACTED>');
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
    }
    const afterResponse = await request.get(base + '/version');
    report.build_after = afterResponse.status() === 200 ?
      (await afterResponse.json()).commit : null;
    report.build_stable = report.build_after === version.commit;
    report.no_ui_business_write = report.ui_writes.length === 0;
    if (!report.build_stable || !report.no_ui_business_write)
      report.result = 'INCONCLUSIVE';
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'PF_S4_UX_028_ROUTE_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_028_route_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-028] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-028] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.result).toBe('READONLY_ROUTE_RECORDED');
  });
