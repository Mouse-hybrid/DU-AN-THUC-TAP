// Fixture-free P0/P1 regression on approved POS staging. No valid credentials or business mutations.
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const base = 'http://160.191.47.17';
const expected = process.env.POS_EXPECTED_COMMIT;
if (expected && !/^[0-9a-f]{7,40}$/i.test(expected)) {
  throw new Error('POS_EXPECTED_COMMIT must be a Git SHA prefix (7–40 hex)');
}
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';

function request(method, path, body) {
  const args = ['--max-time', '20', '--silent', '--show-error', '--request', method,
    '--write-out', '\n%{http_code}'];
  if (body !== undefined) args.push('--header', 'Content-Type: application/json',
    '--data', JSON.stringify(body));
  args.push(`${base}${path}`);
  const text = execFileSync(curl, args, {encoding:'utf8', timeout:25_000});
  const split = text.lastIndexOf('\n');
  return {status:Number(text.slice(split + 1).trim()), body:JSON.parse(text.slice(0, split))};
}

const before = request('GET', '/version');
if (before.status !== 200 || !/^[0-9a-f]{40}$/i.test(before.body.commit || '')) {
  throw new Error('Cannot pin staging SHA before tests');
}
if (expected && !before.body.commit.toLowerCase().startsWith(expected.toLowerCase())) {
  throw new Error(`Unexpected staging SHA ${before.body.commit}`);
}
const health = request('GET', '/health');
const openapi = request('GET', '/openapi.json');
const tables = request('GET', '/api/v1/tables');
// A missing username is rejected at schema validation; this is not a password attempt.
const login = request('POST', '/api/v1/auth/login', {password:'qa-placeholder-invalid'});
const after = request('GET', '/version');
const loginRequired = Array.isArray(login.body.detail) && login.body.detail.some(
  entry => Array.isArray(entry.loc) && entry.loc.includes('username'));
const stable = before.body.commit === after.body.commit && after.status === 200;
const paths = openapi.body.paths || {};
const ops = Object.values(paths).reduce((n, methods) => n + Object.keys(methods).filter(
  method => /^(get|post|put|patch|delete)$/i.test(method)).length, 0);
const cases = [
  {tc_id:'TC_EXT_009', priority:'Critical / P0', method:'GET', path:'/api/v1/tables',
    expected_http:401, actual_http:tables.status,
    assertion:'No Authorization; no table list',
    result:tables.status === 401 && !Array.isArray(tables.body) && !Array.isArray(tables.body?.tables)
      ? 'PASSED' : 'FAILED'},
  {tc_id:'TC_API_01_003', priority:'High / P1', method:'POST', path:'/api/v1/auth/login',
    expected_http:422, actual_http:login.status,
    assertion:'Required username missing; no access_token',
    result:login.status === 422 && loginRequired && !login.body.access_token ? 'PASSED' : 'FAILED'},
];
const report = {
  run_at_utc:new Date().toISOString(), environment:'staging',
  build_before:before.body.commit, build_after:after.body.commit,
  preflight:{version_http:before.status, health_http:health.status,
    openapi_http:openapi.status, path_count:Object.keys(paths).length, rest_operations:ops},
  business_regression:cases, scope:'Two fixture-free Phase 1 cases only; no Phase 2/Sprint 4 business test executed.',
  secrets_recorded:false,
};
const qaRoot = fileURLToPath(new URL('../', import.meta.url));
const stamp = report.run_at_utc.replace(/[-:.]/g, '').replace('T', '_').replace('Z', 'Z');
const output = process.argv[2] || join(qaRoot, 'evidence', 'REGRESSION', `P0P1_SAFE_${stamp}.json`);
mkdirSync(dirname(output), {recursive:true});
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({output, ...report}, null, 2));
if (!stable || health.status !== 200 || openapi.status !== 200 || !openapi.body.paths ||
    cases.some(tc => tc.result !== 'PASSED')) process.exitCode = 1;
