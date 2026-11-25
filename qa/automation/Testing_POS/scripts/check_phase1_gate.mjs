import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const root = process.cwd();
const manifestFile = process.argv[2] || 'phase1-gate.json';
const expectedBuild = process.env.POS_EXPECTED_COMMIT;
const fail = message => { throw new Error(`PHASE1_GATE: ${message}`); };
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const manifest = readJson(manifestFile);
const caseIds = readJson('phase1-case-ids.json');
if (manifest.schema_version !== 2 || manifest.total_testcases !== 116)
  fail('expected the 116-case Phase 1 manifest');
if (!Array.isArray(caseIds) || caseIds.length !== 116 || new Set(caseIds).size !== 116)
  fail('Phase 1 ID registry must contain exactly 116 unique IDs');
if (manifest.baseline_file !== 'phase1-historical-baseline.json')
  fail('historical baseline file is not pinned');
const baseline = readJson(manifest.baseline_file);
if (baseline.schema_version !== 1 || baseline.source_workbook !== manifest.source_workbook ||
    !/^[0-9a-f]{64}$/.test(baseline.source_sha256 || '') ||
    baseline.source_sha256 !== manifest.source_workbook_sha256 ||
    !Array.isArray(baseline.cases) || baseline.cases.length !== 116)
  fail('historical baseline provenance or row count differs from the workbook snapshot');
const baselineIds = new Set();
const sourceRows = new Set();
let historicalPassed = 0;
for (const row of baseline.cases) {
  if (!caseIds.includes(row.tc_id) || baselineIds.has(row.tc_id) ||
      !Number.isInteger(row.source_row) || row.source_row < 4 ||
      sourceRows.has(row.source_row) ||
      !['Passed', 'Blocked', 'Pending', 'Failed', 'Not Executed', 'Skipped'].includes(row.status))
    fail('historical baseline contains an invalid or repeated testcase row');
  baselineIds.add(row.tc_id);
  sourceRows.add(row.source_row);
  if (row.status === 'Passed') {
    if (!/^[0-9a-f]{64}$/.test(row.actual_result_sha256 || ''))
      fail(`${row.tc_id}: historical Passed has no Actual Result fingerprint`);
    historicalPassed++;
  }
}
if (!/^[0-9a-f]{40}$/.test(manifest.target_build || ''))
  fail('manifest target_build must be a full SHA');
if (manifest.target_build !== expectedBuild)
  fail('the pinned staging build differs from the manifest');
if (!Array.isArray(manifest.verified_cases)) fail('verified_cases must be an array');
if (!Array.isArray(manifest.fresh_smoke_required) ||
    manifest.fresh_smoke_required.length !== 2 ||
    !['TC_EXT_009', 'TC_API_01_003'].every(id => manifest.fresh_smoke_required.includes(id)))
  fail('the two current-build smoke checks are mandatory');

const seen = new Set();
for (const row of manifest.verified_cases) {
  if (!caseIds.includes(row.tc_id) || seen.has(row.tc_id))
    fail('invalid or repeated testcase ID');
  seen.add(row.tc_id);
  if (typeof row.evidence !== 'string' || !row.evidence.startsWith('evidence/'))
    fail(`${row.tc_id}: repository evidence path required`);
  const path = resolve(root, row.evidence);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || !existsSync(path))
    fail(`${row.tc_id}: evidence missing or outside checkout`);
  const evidence = readJson(path);
  const branch = Array.isArray(evidence.business_regression) ?
    evidence.business_regression.filter(item => item.tc_id === row.tc_id) : [];
  const coversCase = evidence.test_ref === row.tc_id ||
    (!evidence.test_ref && branch.length === 1 && branch[0].result === 'PASSED' &&
      Number.isInteger(branch[0].expected_http) &&
      branch[0].actual_http === branch[0].expected_http);
  if (!coversCase || !evidence.run_id ||
      evidence.result !== 'PASSED' || evidence.build_before !== expectedBuild ||
      evidence.build_after !== expectedBuild || evidence.build_stable !== true ||
      (evidence.cleanup_pass !== true && evidence.mutations !== 0) ||
      evidence.secrets_recorded !== false)
    fail(`${row.tc_id}: evidence does not establish an isolated Pass on the pinned build`);
}

const minimum = Math.floor(manifest.total_testcases * .9) + 1;
const freshSmokePassed = manifest.fresh_smoke_required.every(id => seen.has(id));
const gateOpen = historicalPassed >= minimum && freshSmokePassed;
const summary = {
  source_workbook: manifest.source_workbook,
  source_workbook_sha256: baseline.source_sha256,
  staging_build: expectedBuild,
  policy: 'HISTORICAL_BASELINE_PLUS_CURRENT_SHA_SMOKE',
  historical_passed: historicalPassed,
  fresh_smoke_passed: seen.size,
  total: manifest.total_testcases,
  required_passed: minimum,
  historical_pass_percent: Number((100 * historicalPassed / manifest.total_testcases).toFixed(2)),
  gate: gateOpen ? 'OPEN' : 'BLOCKED',
};
console.log(JSON.stringify(summary));
if (process.env.GITHUB_STEP_SUMMARY)
  (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Phase 1 ${summary.policy}: ${summary.historical_passed}/${summary.total} workbook-reported historical Pass; ${summary.fresh_smoke_passed} current-SHA smoke Pass; required ${minimum}. ${summary.gate}.\n`);
if (summary.gate !== 'OPEN') process.exitCode = 2;
