// Read-only executable companion to the Postman collection for environments without Postman CLI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const base = process.env.POS_STAGING_URL || 'http://160.191.47.17';
const get = async path => {
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  return JSON.parse(execFileSync(command, ['--max-time', '20', '--fail', '--silent', '--show-error', `${base}${path}`], {encoding:'utf8'}));
};
const before = await get('/version');
await get('/health');
const spec = await get('/openapi.json');
const after = await get('/version');
if (before.commit !== after.commit) throw new Error(`Build changed mid-audit: ${before.commit} -> ${after.commit}`);
const patterns = {
  qr: /\/qr(?:\/|-|$)|\/public\/qr/i,
  rewards: /reward|customer|member/i,
  payment_v2: /\/payments(?:\/|$)|split-bill/i,
  table_advanced: /transfer|merge|\/split(?:\/|$)/i,
  modifier: /modifier/i,
  inventory: /ingredient|stock|recipe/i
};
const paths = spec.paths || {};
const operations = Object.entries(paths).flatMap(([path, methods]) =>
  Object.keys(methods).filter(m => /^(get|post|put|patch|delete)$/i.test(m)).map(method => `${method.toUpperCase()} ${path}`));
const groups = Object.fromEntries(Object.entries(patterns).map(([name, regex]) =>
  [name, operations.filter(op => regex.test(op))]));
const result = {audit: 'DES-QA-07 read-only contract inventory', observed_at: new Date().toISOString(),
  commit: before.commit, path_count: Object.keys(paths).length, operation_count: operations.length,
  groups, conclusion: 'Readiness only. No Phase 2 business testcase executed.'};
const output = process.argv[2];
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
