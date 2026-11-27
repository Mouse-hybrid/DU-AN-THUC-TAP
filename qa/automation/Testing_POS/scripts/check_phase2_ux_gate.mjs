import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(readFileSync(new URL('./phase2_ux_gate_manifest.json', import.meta.url), 'utf8'));
const fail = message => { throw new Error(`Phase 2 / UX UI gate: ${message}`); };
if (manifest.schema !== 1 || !/^[0-9a-f]{40}$/.test(manifest.build)) fail('invalid manifest');
if (manifest.suites?.length !== 2) fail('expected two suites');
const results = [];
for (const [suiteName, total, required] of [['phase2', 71, 57], ['ux_ui', 42, 38]]) {
  const suite = manifest.suites.find(x => x.suite === suiteName);
  if (!suite || !/^[0-9a-f]{64}$/.test(suite.source_sha256) || suite.cases?.length !== total)
    fail(`${suiteName}: missing source snapshot or wrong case count`);
  const ids = new Set();
  for (const row of suite.cases) {
    if (!new RegExp(`^${suiteName === 'phase2' ? 'P2-' : 'S4-UX-'}[A-Z0-9-]+$`).test(row.id) || ids.has(row.id))
      fail(`${suiteName}: malformed or duplicate case ID`);
    ids.add(row.id);
    if (!['Passed', 'Failed', 'Pending', 'Skipped', 'Not Executed'].includes(row.status))
      fail(`${row.id}: unsupported status`);
    if (row.status === 'Passed' && !row.evidence?.trim()) fail(`${row.id}: missing evidence reference`);
    if (row.evidence_file) {
      if (!/^evidence\/qa27\/[A-Za-z0-9_.-]+\.json$/.test(row.evidence_file))
        fail(`${row.id}: invalid supplemental evidence path`);
      const bytes = readFileSync(new URL('../' + row.evidence_file, import.meta.url));
      if (createHash('sha256').update(bytes).digest('hex') !== row.evidence_sha256)
        fail(`${row.id}: supplemental evidence fingerprint differs`);
      const report = JSON.parse(bytes);
      if (row.status !== 'Passed' || report.result !== 'PASSED' ||
          report.test_ref !== row.evidence_test_ref || report.run_id !== row.evidence_run_id ||
          report.staging_commit !== row.evidence_build || report.build_after !== row.evidence_build ||
          report.build_stable !== true || report.cleanup_pass !== true || report.secrets_recorded !== false)
        fail(`${row.id}: supplemental run does not establish an isolated Pass`);
    }
  }
  const passed = suite.cases.filter(x => x.status === 'Passed').length;
  if (passed < required) fail(`${suiteName}: ${passed}/${total} Passed; needs ${required}`);
  results.push({ suite: suiteName, passed, total, source_sha256: suite.source_sha256 });
}
const usr = manifest.suites[0].cases.find(x => x.id === 'P2-USR-008');
if (usr?.status !== 'Passed' || !usr.evidence.includes('RUN-20261126022523322-P2USR008'))
  fail('P2-USR-008 run is absent');
const lines = ['## Phase 2 and UX/UI historical evidence gate', '',
  '| Suite | Passed | Threshold | Source SHA-256 |', '|---|---:|---:|---|',
  ...results.map(x => `| ${x.suite} | ${x.passed}/${x.total} | ${x.suite === 'phase2' ? '≥80%' : '>90%'} | \`${x.source_sha256}\` |`),
  '', ...manifest.suites.filter(x => x.source_adjustment).map(x => `Supplement (${x.suite}): ${x.source_adjustment}`),
  '', `Baseline staging build: \`${manifest.build}\`. Statuses are an evidence snapshot; this job does not rerun PIN-protected cases.`, ''];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
