import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-036 | audit date filters use distinct ranges',
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
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX036',
      test_ref: 'S4-UX-036', checked_at: new Date().toISOString(),
      scope: 'QA3 SUPERVISOR selects Today, 30 days, then 7 days in Audit UI; GET created_from, total and active button match each range; record GET and loading-settle timings without an SLA threshold; no UI business write, read-only.',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], ranges: [], checks: {}, cleanup_required: false,
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
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
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
      const [initial] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/audit-logs',
        { timeout: 20_000 }),
        page.goto('/admin/audit-logs', { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      ]);
      expect(initial.status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Nhật ký hệ thống' }).first())
        .toBeVisible();
      const auditReads: Array<{ created_from: string | null; status: number }> = [];
      page.on('response', response => {
        if (response.request().method() !== 'GET' ||
            new URL(response.url()).pathname !== '/api/v1/audit-logs') return;
        auditReads.push({
          created_from: new URL(response.url()).searchParams.get('created_from'),
          status: response.status(),
        });
      });
      const options = [
        { key: 'today', label: 'Hôm nay', ageMin: 0, ageMax: 1.5 },
        { key: 'thirty', label: '30 ngày', ageMin: 28, ageMax: 31.5 },
        { key: 'seven', label: '7 ngày', ageMin: 5.5, ageMax: 8.5 },
      ];
      const controls = options.map(option =>
        page.locator('button').filter({ hasText: new RegExp('^\\s*' +
          option.label + '\\s*$') }));
      for (const control of controls) await expect(control).toHaveCount(1);
      const totalCard = page.getByText('Tổng thao tác', { exact: true }).locator('..');
      const loading = page.getByText('Đang tải nhật ký', { exact: true });
      const buttonStates = () => Promise.all(controls.map(control =>
        control.evaluate(el => ({
          text: el.textContent?.trim(),
          ariaPressed: el.getAttribute('aria-pressed'),
          className: el.className,
          background: getComputedStyle(el).backgroundColor,
        }))));
      const selectedState = (buttons: Array<{ ariaPressed: string | null;
        className: string; background: string }>, index: number) =>
        buttons[index].ariaPressed === 'true' ||
        /(?:^|\s)(?:active|selected|is-active)(?:\s|$)/i.test(
          buttons[index].className) ||
        buttons.every((button, position) => position === index ||
          button.background !== buttons[index].background);
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const observedStart = auditReads.length;
        const clickedAt = Date.now();
        const match = page.waitForResponse(row => {
          if (row.request().method() !== 'GET' ||
              new URL(row.url()).pathname !== '/api/v1/audit-logs') return false;
          const created = new URL(row.url()).searchParams.get('created_from');
          const age = created ? (Date.now() - Date.parse(created)) / 86_400_000 : NaN;
          return row.status() === 200 && age >= option.ageMin &&
            age <= option.ageMax;
        }, { timeout: 10_000 }).catch(() => null);
        await controls[i].click({ timeout: 10_000 });
        const response = await match;
        const getMs = response ? Date.now() - clickedAt : null;
        await expect(loading).toBeHidden({ timeout: 30_000 })
          .catch(() => {});
        const loadingStillVisible = await loading.isVisible();
        const settleMs = loadingStillVisible ? null : Date.now() - clickedAt;
        await page.waitForLoadState('networkidle', { timeout: 8_000 })
          .catch(() => {});
        const createdFrom = response ?
          new URL(response.url()).searchParams.get('created_from') : null;
        await expect.poll(async () => selectedState(await buttonStates(), i),
          { timeout: 5_000 }).toBe(true).catch(() => {});
        await expect(totalCard).toBeVisible();
        const totalText = await totalCard.innerText();
        const total = Number(totalText.match(/\d[\d.,]*/)?.[0]
          .replaceAll(/[.,]/g, '') ?? NaN);
        const buttons = await buttonStates();
        const active = selectedState(buttons, i);
        const range = { key: option.key, label: option.label,
          http: response?.status() ?? null, created_from: createdFrom,
          total, active, buttons, observed_gets: auditReads.slice(observedStart),
          get_ms: getMs, ui_settle_ms: settleMs,
          loading_still_visible: loadingStillVisible };
        report.ranges.push(range);
        await testInfo.attach('S4_UX_036_' + option.key, {
          body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
          contentType: 'image/png',
        });
      }
      const [today, thirty, seven] = report.ranges;
      report.checks = {
        audit_get_200: report.ranges.length === 3 &&
          report.ranges.every((row: any) => row.http === 200),
        different_ordered_dates: report.ranges.every((row: any) =>
          row.created_from && Number.isFinite(Date.parse(row.created_from))) &&
          Date.parse(today.created_from) > Date.parse(seven.created_from) &&
          Date.parse(seven.created_from) > Date.parse(thirty.created_from),
        active_matches_range: report.ranges.every((row: any) => row.active),
        ui_settled: report.ranges.every((row: any) =>
          !row.loading_still_visible && Number.isFinite(row.ui_settle_ms)),
        totals_consistent: report.ranges.every((row: any) =>
          Number.isInteger(row.total) && row.total >= 0) &&
          today.total <= seven.total && seven.total <= thirty.total,
        no_ui_business_write: report.ui_writes.length === 0,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Audit date filter mismatch: ' + JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = report.ranges.length ? 'EXECUTED_READ_ONLY' :
      'NOT_EXECUTED';
    report.result = !failure && report.build_stable ? 'PASSED' : 'FAILED';
    if (failure) report.error = String(failure).replaceAll(pin!, '<REDACTED>');
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'S4_UX_036_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_036_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-036] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-036] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
