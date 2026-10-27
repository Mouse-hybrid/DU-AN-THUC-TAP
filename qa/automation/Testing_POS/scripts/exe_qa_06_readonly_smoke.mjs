// EXE-QA-06: Sprint 3 readiness smoke. Business data is never mutated.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
if (base !== 'http://160.191.47.17') throw new Error('EXE-QA-06 is restricted to approved staging');
const expected = process.env.POS_EXPECTED_COMMIT;
if (expected && !/^[0-9a-f]{7,40}$/i.test(expected)) {
  throw new Error('POS_EXPECTED_COMMIT must be a 7–40 character Git SHA prefix');
}

function getJson(path) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const response = execFileSync(curl, [
    '--max-time', '20', '--silent', '--show-error',
    '--write-out', '\n%{http_code}', `${base}${path}`,
  ], { encoding: 'utf8', timeout: 25_000 });
  const split = response.lastIndexOf('\n');
  const status = Number(response.slice(split + 1).trim());
  if (status !== 200) throw new Error(`GET ${path}: expected HTTP 200, received ${status}`);
  return JSON.parse(response.slice(0, split));
}

const before = getJson('/version');
if (!/^[0-9a-f]{40}$/i.test(before.commit || '')) throw new Error('GET /version missing full commit');
getJson('/health');
const spec = getJson('/openapi.json');
const after = getJson('/version');
if (before.commit !== after.commit) throw new Error(`Staging changed during smoke: ${before.commit} -> ${after.commit}`);
if (expected && !before.commit.toLowerCase().startsWith(expected.toLowerCase())) {
  throw new Error(`Unexpected staging build: expected ${expected}, received ${before.commit}`);
}
if (!spec.paths || typeof spec.paths !== 'object' || Array.isArray(spec.paths)) {
  throw new Error('OpenAPI paths object is missing');
}

const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.keys(methods).filter(method => /^(get|post|put|patch|delete)$/i.test(method))
    .map(method => `${method.toUpperCase()} ${path}`));
const candidates = {
  qr_public: /\/(?:qr|public\/qr)(?:\/|-|$)/i,
  rewards: /\/(?:rewards?|loyalty|members?|points)(?:\/|$)/i,
  payment_v2: /\/(?:payments|split-bill)(?:\/|$)/i,
};
const contract = Object.fromEntries(Object.entries(candidates).map(([group, pattern]) => {
  const matches = operations.filter(op => pattern.test(op.slice(op.indexOf(' ') + 1)));
  return [group, { status: matches.length ? 'REVIEW_REQUIRED' : 'BLOCKED_MISSING_CONTRACT', operations: matches }];
}));
const report = {
  task: 'EXE-QA-06',
  observed_at: new Date().toISOString(),
  staging_commit: before.commit,
  api_preflight: { version: 200, health: 200, openapi: 200,
    paths: Object.keys(spec.paths).length, rest_operations: operations.length, status: 'PASSED' },
  contract,
  qr_ui: 'NOT_EXECUTED: public FE route is not established by an OpenAPI check',
  business_tests: 'NOT_EXECUTED',
  conclusion: 'Read-only smoke only. Candidate paths require BE contract review; absent paths block Phase 2 business execution.',
};
if (process.argv[2]) {
  mkdirSync(dirname(process.argv[2]), { recursive: true });
  writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
