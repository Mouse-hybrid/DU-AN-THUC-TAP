// Read-only executable companion to the Postman collection for environments without Postman CLI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const expectedCommit = process.env.POS_EXPECTED_COMMIT;
if (expectedCommit && !/^[0-9a-f]{7,40}$/i.test(expectedCommit)) {
  throw new Error('POS_EXPECTED_COMMIT must be a 7–40 character Git SHA prefix');
}
const get = async path => {
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  return JSON.parse(execFileSync(command, ['--max-time', '20', '--fail', '--silent', '--show-error', `${base}${path}`], {encoding:'utf8'}));
};
const before = await get('/version');
await get('/health');
const spec = await get('/openapi.json');
const after = await get('/version');
if (before.commit !== after.commit) throw new Error(`Build changed mid-audit: ${before.commit} -> ${after.commit}`);
if (expectedCommit && !before.commit.toLowerCase().startsWith(expectedCommit.toLowerCase())) {
  throw new Error(`Unexpected staging build: expected ${expectedCommit}, observed ${before.commit}`);
}
if (!spec.paths || typeof spec.paths !== 'object' || Array.isArray(spec.paths)) {
  throw new Error('OpenAPI does not contain a paths object');
}
const patterns = {
  qr: /\/qr(?:\/|-|$)|\/public\/qr/i,
  rewards: /\/(?:rewards?|customers?|members?)(?:\/|$)/i,
  payment_v2: /\/payments(?:\/|$)|\/split-bill(?:\/|$)/i,
  table_advanced: /\/tables\/(?:merge|[^/]+\/transfer)(?:\/|$)|\/orders\/[^/]+\/split(?:\/|$)/i,
  modifier: /\/modifiers?(?:\/|$)/i,
  inventory: /\/(?:inventory|bom|ingredients?|stock(?:-levels|-movements)?|recipes?)(?:\/|$)/i
};
const paths = spec.paths || {};
const operations = Object.entries(paths).flatMap(([path, methods]) =>
  Object.keys(methods).filter(m => /^(get|post|put|patch|delete)$/i.test(m)).map(method => `${method.toUpperCase()} ${path}`));
const groups = Object.fromEntries(Object.entries(patterns).map(([name, regex]) =>
  [name, operations.filter(op => regex.test(op.slice(op.indexOf(' ') + 1)))]));
const result = {audit: 'DES-QA-07 read-only contract inventory', observed_at: new Date().toISOString(),
  commit: before.commit, path_count: Object.keys(paths).length, operation_count: operations.length,
  groups, phase2_missing_groups: Object.keys(groups).filter(name =>
    name !== 'inventory' && groups[name].length === 0),
  conclusion: 'Readiness only. Inventory/BOM is a separate scope decision; no Phase 2 business testcase executed.'};
const output = process.argv[2];
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
