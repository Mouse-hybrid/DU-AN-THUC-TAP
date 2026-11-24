import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('S4-UX-035 | QA3 supervisor opens and refreshes audit history',
  async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    test.skip(testInfo.project.name !== 'chromium', 'Desktop Chromium scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base, 'QA3 staging only').toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[0-9a-f]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full pinned POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4UX035`,
      test_ref: 'S4-UX-035', checked_at: new Date().toISOString(),
      scope: 'QA3 SUPERVISOR opens 7-day audit UI, refreshes GET and checks visible count; QA2 outlet cannot read a QA3 entity; read-only, no export',
      project: testInfo.project.name, secrets_recorded: false,
      ui_writes: [], mutations: 0, checks: {},
    };
    const redact = (error: unknown, secrets: string[]) => {
      let value = String(error);
      for (const secret of secrets)
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
    const tokens: Record<string, string> = {};
    const outlets: Record<string, string> = {};
    for (const [key, username] of [['qa3', 'qa3_admin'], ['qa2', 'qa2_admin']]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status(), `${username} login`).toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe('SUPERVISOR');
      tokens[key] = body.access_token;
      outlets[key] = body.staff?.outlet_id;
      expect(tokens[key]).toBeTruthy();
      expect(outlets[key]).toBeTruthy();
    }
    expect(outlets.qa3).not.toBe(outlets.qa2);
    const ownGet = async (path: string, role: string) => {
      const response = await request.get(base + path, {
        headers: { Authorization: `Bearer ${tokens[role]}` }, timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    };
    const rowsOf = (body: any): any[] => Array.isArray(body) ? body :
      Array.isArray(body?.items) ? body.items : [];
    // Default audit sort is ascending; select recent QA3 orders for the outlet probe.
    const ownHistory = await ownGet('/api/v1/audit-logs?sort=desc&limit=100', 'qa3');
    expect(ownHistory.http).toBe(200);
    const ownRows = rowsOf(ownHistory.body);
    // An audit row can outlive its order. Scope the probe to an order
    // QA3 can still read, so a 404 from the filtered endpoint is meaningful.
    const candidates = [...new Set(ownRows
      .filter(row => row.entity_type === 'order' &&
        typeof row.entity_id === 'string' && row.entity_id.length > 0)
      .map(row => row.entity_id))].slice(0, 20);
    let marker: any;
    const orderProbes: Array<{ order_id: string; http: number }> = [];
    for (const id of candidates) {
      const candidate = await ownGet('/api/v1/orders/' + encodeURIComponent(id), 'qa3');
      orderProbes.push({ order_id: id, http: candidate.http });
      if (candidate.http === 200 && candidate.body?.id === id) {
        marker = ownRows.find(row => row.entity_id === id);
        break;
      }
    }
    report.outlet_probe = { qa3_rows: ownRows.length,
      candidate_count: candidates.length, order_probes: orderProbes,
      readable_order_found: !!marker, distinct_outlets: outlets.qa3 !== outlets.qa2 };
    const reads: Array<{status: number; path: string; createdFrom: string | null;
      rows: number | null}> = [];
    page.on('response', response => {
      if (response.request().method() !== 'GET') return;
      const url = new URL(response.url());
      if (url.pathname !== '/api/v1/audit-logs') return;
      const item = { status: response.status(), path: url.pathname,
        createdFrom: url.searchParams.get('created_from'), rows: null as number | null };
      reads.push(item);
      void response.json().then(body => { item.rows = rowsOf(body).length; })
        .catch(() => {});
    });
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/v1/') &&
          !['GET', 'HEAD'].includes(req.method()) &&
          path !== '/api/v1/auth/login')
        report.ui_writes.push(`${req.method()} ${path}`);
    });
    let failure: unknown;
    try {
      await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.getByLabel('Tên đăng nhập', { exact: true }).fill('qa3_admin');
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
      const [initial] = await Promise.all([
        page.waitForResponse(response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/audit-logs',
          { timeout: 20_000 }),
        page.goto('/admin/audit-logs',
          { waitUntil: 'domcontentloaded', timeout: 20_000 }),
      ]);
      expect(initial.status()).toBe(200);
      await expect(page).toHaveURL(/\/admin\/audit-logs$/);
      await expect(page.getByRole('heading', { name: 'Nhật ký hệ thống' }).first())
        .toBeVisible();
      await expect.poll(() => reads.length).toBeGreaterThan(0);
      const totalCard = page.getByText('Tổng thao tác', { exact: true }).locator('..');
      const initialTotalText = await totalCard.innerText();
      const initialTotal = Number(initialTotalText.match(/\d[\d.,]*/)?.[0]
        .replaceAll(/[.,]/g, '') ?? NaN);
      expect(Number.isFinite(initialTotal)).toBe(true);
      await testInfo.attach('S4_UX_035_initial', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      const beforeRefresh = reads.length;
      const refresh = page.getByRole('button',
        { name: 'Tải lại nhật ký hệ thống', exact: true });
      if (await refresh.count() !== 1) {
        report.refresh_controls = await page.locator('button').evaluateAll(rows =>
          rows.map(row => ({
            text: row.textContent?.trim().slice(0, 80),
            label: row.getAttribute('aria-label'),
            disabled: (row as HTMLButtonElement).disabled,
          })).filter(row => /làm mới/i.test((row.text || '') + ' ' + (row.label || ''))));
        throw new Error('PENDING_UI_SELECTOR: audit refresh button not uniquely identified');
      }
      await expect(refresh).toBeVisible({ timeout: 5_000 });
      const [refreshed] = await Promise.all([
        page.waitForResponse(response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/audit-logs',
          { timeout: 20_000 }),
        refresh.click({ timeout: 10_000 }),
      ]);
      expect(refreshed.status()).toBe(200);
      await expect.poll(() => reads.length).toBeGreaterThan(beforeRefresh);
      const refreshedTotalText = await totalCard.innerText();
      const refreshedTotal = Number(refreshedTotalText.match(/\d[\d.,]*/)?.[0]
        .replaceAll(/[.,]/g, '') ?? NaN);
      expect(Number.isFinite(refreshedTotal)).toBe(true);
      const tableRows = await page.locator('table tbody tr').count();
      report.ui = { initial_total: initialTotal, refreshed_total: refreshedTotal,
        visible_table_rows: tableRows, audit_gets: reads };
      if (!marker) throw new Error('PENDING_FIXTURE: no readable QA3 order among recent audit rows');
      const id = encodeURIComponent(marker.entity_id);
      const orderAuditPath = `/api/v1/audit-logs?order_id=${id}&limit=100`;
      const ownEntity = await ownGet(orderAuditPath, 'qa3');
      const foreignEntity = await ownGet(orderAuditPath, 'qa2');
      report.outlet_probe.filter = 'order_id';
      report.outlet_probe.order_id = marker.entity_id;
      report.outlet_probe.own_http = ownEntity.http;
      report.outlet_probe.own_rows = rowsOf(ownEntity.body).length;
      report.outlet_probe.foreign_http = foreignEntity.http;
      report.outlet_probe.foreign_rows = rowsOf(foreignEntity.body).length;
      report.outlet_probe.foreign_contains_order_id =
        JSON.stringify(foreignEntity.body).includes(marker.entity_id);
      report.checks = {
        audit_get_200: reads.length >= 2 && reads.every(row => row.status === 200),
        refresh_same_range: reads[0].createdFrom !== null &&
          reads[0].createdFrom === reads[reads.length - 1].createdFrom,
        visible_total_consistent: refreshedTotal >= tableRows &&
          (refreshedTotal > 0 || tableRows === 0),
        own_entity_visible: ownEntity.http === 200 &&
          rowsOf(ownEntity.body).some(row => row.entity_id === marker.entity_id),
        foreign_entity_isolated: foreignEntity.http === 404 &&
          report.outlet_probe.foreign_rows === 0 &&
          !report.outlet_probe.foreign_contains_order_id,
        no_ui_business_write: report.ui_writes.length === 0,
      };
      await testInfo.attach('S4_UX_035_refreshed', {
        body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
        contentType: 'image/png',
      });
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Audit UI/refresh/outlet mismatch: ' + JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.business_execution = reads.length ? 'EXECUTED_READ_ONLY' : 'NOT_EXECUTED';
    report.result = !failure && report.build_stable ? 'PASSED' :
      /PENDING_(FIXTURE|UI_SELECTOR)/.test(
        redact(failure, [pin!, ...Object.values(tokens)])) ?
        'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure, [pin!, ...Object.values(tokens)]);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = `S4_UX_035_${report.run_id}.json`;
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('S4_UX_035_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log(`[S4-UX-035] Evidence: .\\evidence\\${name}`);
    console.log('[S4-UX-035] Result: ' + JSON.stringify(report));
    if (failure) throw failure;
    expect(report.build_stable).toBe(true);
  });
