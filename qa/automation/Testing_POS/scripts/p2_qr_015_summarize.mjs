// Aggregate exactly three independent QR timing samples from one invocation.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const since = Date.parse(process.argv[2] || '');
const output = process.argv[3];
const expected = process.env.POS_EXPECTED_COMMIT;
if (!Number.isFinite(since) || !output || !/^[a-f0-9]{40}$/.test(expected || ''))
  throw Error('Usage: node scripts/p2_qr_015_summarize.mjs SINCE_ISO OUTPUT.json; pin full POS_EXPECTED_COMMIT');
const dir = dirname(output);
const reports = readdirSync(dir)
  .filter(name => /^P2_QR_015_RUN-\d+-P2QR015\.json$/.test(name))
  .map(name => ({ name, row: JSON.parse(readFileSync(join(dir, name), 'utf8')) }))
  .filter(({ row }) => row.test_ref === 'P2-QR-015' && Date.parse(row.checked_at) >= since)
  .sort((a, b) => Date.parse(a.row.checked_at) - Date.parse(b.row.checked_at));
const samples = reports.map(({ name, row }) => ({
  evidence: name, run_id: row.run_id, checked_at: row.checked_at,
  elapsed_ms: row.flow_elapsed_ms ?? null, result: row.result,
  cleanup_pass: row.cleanup_pass, build_stable: row.build_stable,
  staging_commit: row.staging_commit,
  one_ui_submit: row.checks?.one_ui_submit,
  customer_receipt_visible: row.checks?.customer_receipt_visible,
}));
const values = samples.map(row => row.elapsed_ms).sort((a, b) => a - b);
const passed = samples.length === 3 && new Set(samples.map(row => row.run_id)).size === 3 &&
  samples.every(row => row.result === 'PASSED_SAMPLE' && row.cleanup_pass &&
    row.build_stable && row.staging_commit === expected &&
    row.one_ui_submit && row.customer_receipt_visible &&
    Number.isFinite(row.elapsed_ms) && row.elapsed_ms <= 30_000);
const result = {
  test_ref: 'P2-QR-015', checked_at: new Date().toISOString(),
  scope: 'Three independent QA3 DIRECT Chromium 1366x768 samples; QR navigation through visible customer receipt, excluding API fixture setup and cleanup, no artificial throttling.',
  threshold_ms: 30_000, sample_count: samples.length, samples,
  max_ms: values.length ? Math.max(...values) : null,
  mean_ms: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
  p95_nearest_rank_ms: values.length === 3 ? values[2] : null,
  staging_commit: expected, secrets_recorded: false, token_recorded: false,
  result: passed ? 'PASSED' : samples.length === 3 ? 'FAILED' : 'INCONCLUSIVE',
};
mkdirSync(dir, { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log('[P2-QR-015] Aggregate: ' + JSON.stringify(result));
if (!passed) process.exitCode = 1;
