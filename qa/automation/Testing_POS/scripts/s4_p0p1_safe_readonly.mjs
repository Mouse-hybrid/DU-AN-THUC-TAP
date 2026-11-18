// Fixture-free Phase 1 P0/P1 regression on one pinned staging build.
// No credentials, customer data, or business mutations.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const expected = process.env.POS_EXPECTED_COMMIT;
if (!/^[0-9a-f]{40}$/.test(expected || '')) {
  console.error('Set POS_EXPECTED_COMMIT to the full verified staging SHA.');
  process.exit(2);
}
const timeout = 15000;
async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  return { status: response.status, body };
}
async function version() {
  const result = await call('/version');
  if (result.status !== 200 || result.body?.environment !== 'staging')
    throw new Error('Staging /version unavailable');
  return result.body.commit;
}
const report = {
  run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-S4P0P1SAFE`,
  checked_at: new Date().toISOString(),
  scope: 'Fixture-free Phase 1 TC_EXT_009 and TC_API_01_003 only; no Sprint 4 business execution',
  environment: 'staging',
  expected_commit: expected,
  secrets_recorded: false,
  mutations: 0,
  business_regression: [],
};
let failure;
try {
  report.build_before = await version();
  if (report.build_before !== expected)
    throw new Error('PENDING_BUILD: staging SHA differs from pinned SHA');
  const health = await call('/health');
  const openapi = await call('/openapi.json');
  if (health.status !== 200 || openapi.status !== 200 || !openapi.body?.paths)
    throw new Error('Preflight /health or /openapi.json failed');
  report.preflight = {
    version_http: 200, health_http: health.status, openapi_http: openapi.status,
    path_count: Object.keys(openapi.body.paths).length,
  };
  const anonymous = await call('/api/v1/tables');
  report.business_regression.push({
    tc_id: 'TC_EXT_009', priority: 'Critical / P0',
    expected_http: 401, actual_http: anonymous.status,
    assertion: 'No Authorization; no table list',
    result: anonymous.status === 401 && !Array.isArray(anonymous.body) ? 'PASSED' : 'FAILED',
  });
  const invalid = await call('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'qa-invalid-placeholder' }),
  });
  report.business_regression.push({
    tc_id: 'TC_API_01_003', priority: 'High / P1',
    expected_http: 422, actual_http: invalid.status,
    assertion: 'Required username missing; no access_token',
    result: invalid.status === 422 && !invalid.body?.access_token ? 'PASSED' : 'FAILED',
  });
} catch (error) { failure = String(error); }
try { report.build_after = await version(); } catch { report.build_after = null; }
report.build_stable = report.build_after === report.build_before &&
  report.build_before === expected;
report.result = !failure && report.build_stable &&
  report.business_regression.length === 2 &&
  report.business_regression.every(row => row.result === 'PASSED') ? 'PASSED' :
  failure?.startsWith('Error: PENDING_BUILD') ? 'PENDING' : 'FAILED';
if (failure) report.error = failure;
mkdirSync(join(process.cwd(), 'evidence', 'REGRESSION'), { recursive: true });
const output = join(process.cwd(), 'evidence', 'REGRESSION',
  `P0P1_SAFE_${report.run_id}.json`);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, result: report.result,
  build_stable: report.build_stable, business_regression: report.business_regression,
  error: report.error }, null, 2));
if (report.result === 'FAILED') process.exitCode = 1;
if (report.result === 'PENDING') process.exitCode = 2;
