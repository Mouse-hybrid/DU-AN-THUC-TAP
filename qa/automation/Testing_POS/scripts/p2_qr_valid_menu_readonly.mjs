// Read-only QR fixture gate for P2-QR-001/002. Requires a valid QA 3 token
// issued by the Waiter for an owned, open table. Never prints or saves it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const token = process.env.P2_QR_TOKEN;
const expected = process.env.POS_EXPECTED_COMMIT;
const tableCode = process.env.P2_QR_TABLE_CODE;
const output = process.argv[2];
if (!token || !tableCode || !/^Q3-[123]$/.test(tableCode)) {
  console.error('PENDING_FIXTURE: Set P2_QR_TOKEN and P2_QR_TABLE_CODE=Q3-1|Q3-2|Q3-3 for an owned open QA 3 session. No request sent.');
  process.exit(2);
}
if (!/^[A-Za-z0-9_-]{1,255}$/.test(token)) throw new Error('Invalid token format; no request sent');
const get = path => {
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const raw = execFileSync(command, ['--max-time', '30', '--silent', '--show-error', '--write-out', '\n%{http_code}', `${base}${path}`], { encoding: 'utf8' });
  const last = raw.lastIndexOf('\n');
  return { http: Number(raw.slice(last + 1)), body: raw.slice(0, last) };
};
const ver = () => {
  const r = get('/version');
  if (r.http !== 200) throw new Error(`/version HTTP ${r.http}`);
  return JSON.parse(r.body).commit;
};
const before = ver();
if (expected && !before.startsWith(expected)) throw new Error(`Unexpected SHA ${before}; no QR request sent`);
const spec = get('/openapi.json');
if (spec.http !== 200) throw new Error(`OpenAPI HTTP ${spec.http}`);
const paths = JSON.parse(spec.body).paths;
for (const p of ['/api/v1/public/qr/{token}', '/api/v1/public/qr/{token}/menu']) {
  if (!paths?.[p]?.get) throw new Error(`Missing GET ${p}`);
}
const infoResponse = get(`/api/v1/public/qr/${token}`);
const menuResponse = get(`/api/v1/public/qr/${token}/menu`);
const after = ver();
const info = infoResponse.http === 200 ? JSON.parse(infoResponse.body) : null;
const menu = menuResponse.http === 200 ? JSON.parse(menuResponse.body) : null;
const checks = {
  info_http: infoResponse.http, menu_http: menuResponse.http,
  table_matches: info?.table_code === tableCode,
  token_not_expired: info ? Number.isFinite(Date.parse(info.expires_at)) && Date.parse(info.expires_at) > Date.now() : false,
  ordering_unlocked: info?.ordering_locked === false,
  category_count: Array.isArray(menu?.categories) ? menu.categories.length : null,
  menu_count: Array.isArray(menu?.items) ? menu.items.length : null,
  available_count: Array.isArray(menu?.items) ? menu.items.filter(x => x.is_available === true).length : null,
  menu_shape_valid: Array.isArray(menu?.items) && menu.items.every(x =>
    typeof x.id === 'string' && typeof x.name === 'string' && typeof x.price === 'string' && typeof x.is_available === 'boolean'),
};
const passed = before === after && checks.info_http === 200 && checks.menu_http === 200 &&
  checks.table_matches && checks.token_not_expired && checks.ordering_unlocked &&
  checks.category_count > 0 && checks.menu_count > 0 && checks.available_count > 0 && checks.menu_shape_valid;
const result = {
  test_ref: 'PF-P2-QR-001-002', checked_at: new Date().toISOString(), build_before: before,
  build_after: after, build_stable: before === after, table_code: tableCode, checks,
  result: passed ? 'PASSED' : 'FAILED',
  business_cases: 'P2-QR-001/002 NOT_EXECUTED in full: issuing/revoking the QR session and UI are outside this read-only gate',
  mutations: 0, token_recorded: false, secrets_recorded: false,
};
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`); }
console.log(JSON.stringify(result, null, 2));
if (!passed) process.exitCode = 1;
