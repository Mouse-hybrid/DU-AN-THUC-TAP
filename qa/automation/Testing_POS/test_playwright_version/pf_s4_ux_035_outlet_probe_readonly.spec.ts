import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('PF-S4-UX-035-OUTLET | known QA3 order audit remains outlet scoped',
  async ({ request }, testInfo) => {
    test.setTimeout(90_000);
    test.skip(testInfo.project.name !== 'chromium', 'QA3 Chromium API scope');
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base).toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    const expected = process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin || !/^[a-f0-9]{40}$/.test(expected || ''),
      'S2_STAGING_PIN and full POS_EXPECTED_COMMIT required');
    const report: any = {
      run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-S4UX035OUTLET',
      test_ref: 'PF-S4-UX-035-OUTLET',
      checked_at: new Date().toISOString(),
      scope: 'Read-only QA3/QA2 audit filter for a known QA3 CLOSED order from S4-UX-015, S4-UX-007 or P2-AUD-004 evidence; complements S4-UX-035 UI refresh on the same staging SHA.',
      project: testInfo.project.name, secrets_recorded: false, mutations: 0,
      checks: {}, candidates: [], result: 'INCONCLUSIVE',
    };
    const tokens: Record<string, string> = {};
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
    test.skip(before !== expected, 'PENDING_BUILD: staging SHA differs');
    report.staging_commit = before;
    for (const [key, username] of [['qa3', 'qa3_admin'], ['qa2', 'qa2_admin']]) {
      const response = await request.post(base + '/api/v1/auth/login', {
        data: { username, password: pin }, timeout: 20_000,
      });
      expect(response.status(), username + ' login').toBe(200);
      const body = await response.json();
      expect(body.staff?.role).toBe('SUPERVISOR');
      tokens[key] = body.access_token;
      expect(tokens[key]).toBeTruthy();
    }
    async function get(path: string, role: string) {
      const response = await request.get(base + path, {
        headers: { Authorization: 'Bearer ' + tokens[role] },
        timeout: 20_000,
      });
      let body: any;
      try { body = await response.json(); } catch { body = null; }
      return { http: response.status(), body };
    }
    let failure: unknown;
    try {
      const ids = [
        '11756b2a-4d2e-431b-bb0f-ad8ae4eecba0', // S4-UX-015, SHA 7d732d...
        'c26a2f7e-3031-453a-bb8e-81e9b80d3992', // S4-UX-007, same SHA
        'dbfdbc88-07da-4a64-a49f-d788697f0a6c', // P2-AUD-004 earlier
      ];
      let selected: string | undefined;
      for (const id of ids) {
        const ownOrder = await get('/api/v1/orders/' + id, 'qa3');
        report.candidates.push({ order_id: id, qa3_order_http: ownOrder.http });
        if (ownOrder.http === 200 && ownOrder.body?.id === id) {
          selected = id;
          break;
        }
      }
      if (!selected)
        throw new Error('PENDING_FIXTURE: no known QA3 order remains readable');
      const path = '/api/v1/audit-logs?order_id=' + selected + '&limit=100';
      const qa3 = await get(path, 'qa3');
      const qa2 = await get(path, 'qa2');
      const rows = Array.isArray(qa3.body) ? qa3.body :
        Array.isArray(qa3.body?.items) ? qa3.body.items : [];
      report.selected_order_id = selected;
      report.http = { qa3_audit: qa3.http, qa2_audit: qa2.http };
      report.qa3_matching_rows = rows.filter((row: any) =>
        row.entity_id === selected || row.order_id === selected).length;
      report.qa2_contains_order_id = JSON.stringify(qa2.body).includes(selected);
      report.checks = {
        known_order_readable: true,
        qa3_audit_visible: qa3.http === 200 && report.qa3_matching_rows > 0,
        qa2_audit_isolated: qa2.http === 404 && !report.qa2_contains_order_id,
      };
      if (!Object.values(report.checks).every(Boolean))
        throw new Error('Audit outlet probe mismatch: ' + JSON.stringify(report.checks));
    } catch (error) { failure = error; }
    try { report.build_after = await build(); } catch { report.build_after = null; }
    report.build_stable = report.build_after === before;
    report.result = !failure && report.build_stable ? 'PASSED' :
      /PENDING_FIXTURE/.test(String(failure)) ? 'PENDING' : 'FAILED';
    if (failure) report.error = redact(failure);
    const evidence = JSON.stringify(report, null, 2) + '\n';
    mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
    const name = 'PF_S4_UX_035_OUTLET_' + report.run_id + '.json';
    writeFileSync(join(process.cwd(), 'evidence', name), evidence);
    await testInfo.attach('PF_S4_UX_035_OUTLET_evidence', {
      body: evidence, contentType: 'application/json',
    });
    console.log('[S4-UX-035-OUTLET] Evidence: .\\evidence\\' + name);
    console.log('[S4-UX-035-OUTLET] Result: ' + JSON.stringify(report));
    if (failure) throw new Error(redact(failure));
    expect(report.build_stable).toBe(true);
  });
