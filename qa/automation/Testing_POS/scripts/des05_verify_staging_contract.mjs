// Read-only staging contract audit for DES-QA-05.
// Compares the live OpenAPI document with the latest docs/api/openapi.json on main.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const origin = String(process.env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const getJson = async (path) => {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const sha256 = (value) => createHash('sha256')
  .update(JSON.stringify(canonical(value))).digest('hex');
const operationCount = (document) => Object.values(document.paths || {})
  .flatMap((operations) => Object.keys(operations)
    .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))).length;

const version = await getJson('/version');
const stagingOpenapi = await getJson('/openapi.json');
execFileSync('git', ['fetch', '--depth=1', 'origin', 'main'], { stdio: 'ignore' });
const mainCommit = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).trim();
const mainOpenapi = JSON.parse(execFileSync('git', [
  'show', 'FETCH_HEAD:docs/api/openapi.json',
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));

const report = {
  staging_version: version,
  main_commit_at_audit: mainCommit,
  openapi_equal_to_main: sha256(stagingOpenapi) === sha256(mainOpenapi),
  staging_openapi_sha256: sha256(stagingOpenapi),
  main_openapi_sha256: sha256(mainOpenapi),
  staging_path_count: Object.keys(stagingOpenapi.paths || {}).length,
  main_path_count: Object.keys(mainOpenapi.paths || {}).length,
  staging_rest_operation_count: operationCount(stagingOpenapi),
  main_rest_operation_count: operationCount(mainOpenapi),
  staging_get_orders: Boolean(stagingOpenapi.paths?.['/api/v1/orders']?.get),
  main_get_orders: Boolean(mainOpenapi.paths?.['/api/v1/orders']?.get),
};
const stagingCommit = String(version.short_commit || version.commit || 'unknown').slice(0, 7);
const mainShort = mainCommit.slice(0, 7);
const contractResult = report.openapi_equal_to_main ? 'MATCH' : 'DIFF';
console.log(`[DES-QA-05] staging ${stagingCommit} | main ${mainShort} | OpenAPI ${contractResult} (${report.staging_rest_operation_count} REST, ${report.staging_path_count} paths) | GET /orders: ${report.staging_get_orders ? 'YES' : 'NO'}`);
if (process.argv.includes('--verbose')) console.log(JSON.stringify(report, null, 2));
console.log('[DES-QA-05] Read-only audit; business testcases not executed.');
