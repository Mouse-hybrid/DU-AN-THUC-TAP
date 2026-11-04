// P2-QR-007 preflight: invalid and overlong public tokens only.
// Never labels the full testcase Passed; expired/revoked branches need owned fixtures.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
const get = (path) => {
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const raw = execFileSync(command, ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', `${base}${path}`], { encoding: 'utf8' });
  const split = raw.lastIndexOf('\n');
  return { status: Number(raw.slice(split + 1)), body: raw.slice(0, split) };
};
const version = () => {
  const response = get('/version');
  if (response.status !== 200) throw new Error(`/version HTTP ${response.status}`);
  return JSON.parse(response.body).commit;
};

const before = version();
if (expected && !before.startsWith(expected)) throw new Error(`Unexpected staging SHA: ${before}`);
const specResponse = get('/openapi.json');
if (specResponse.status !== 200) throw new Error(`OpenAPI HTTP ${specResponse.status}`);
const spec = JSON.parse(specResponse.body);
const required = ['/api/v1/public/qr/{token}', '/api/v1/public/qr/{token}/menu', '/api/v1/public/qr/{token}/order'];
for (const path of required) if (!spec.paths?.[path]?.get) throw new Error(`Missing GET ${path}`);

const invalid = `qa-invalid-${randomUUID()}`;
const cases = [
  ...['', '/menu', '/order'].map(suffix => ({
    path: `/api/v1/public/qr/${invalid}${suffix}`, label: `GET /api/v1/public/qr/<INVALID_TOKEN>${suffix}`, expected_http: 401,
  })),
  { path: `/api/v1/public/qr/${'x'.repeat(256)}`, label: 'GET /api/v1/public/qr/<256-CHAR-TOKEN>', expected_http: 422 },
];
const checks = [];
for (const testCase of cases) {
  const response = get(testCase.path);
  checks.push({ operation: testCase.label, expected_http: testCase.expected_http, actual_http: response.status,
    result: response.status === testCase.expected_http ? 'PASSED' : 'FAILED' });
}
const after = version();
const result = {
  test_ref: 'PF-P2-QR-007', checked_at: new Date().toISOString(), build_before: before, build_after: after,
  build_stable: before === after, checks,
  result: before === after && checks.every(c => c.result === 'PASSED') ? 'PASSED' : 'FAILED',
  business_case: 'P2-QR-007 NOT_EXECUTED: expired and revoked token branches are not covered',
  mutations: 0, secrets_recorded: false,
};
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
if (result.result !== 'PASSED') process.exitCode = 1;
