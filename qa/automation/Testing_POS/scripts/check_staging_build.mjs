import { readFileSync } from 'node:fs';

const expected = process.env.POS_EXPECTED_COMMIT ||
  JSON.parse(readFileSync('phase1-gate.json', 'utf8')).target_build;
if (!/^[0-9a-f]{40}$/.test(expected || '')) throw new Error('Invalid target build');
const response = await fetch(`${process.env.BASE_URL || 'http://160.191.47.17'}/version`, {
  signal: AbortSignal.timeout(20_000),
});
if (response.status !== 200) throw new Error(`Staging /version HTTP ${response.status}`);
const actual = await response.json();
if (actual.environment !== 'staging' || actual.commit !== expected)
  throw new Error('Staging SHA changed; Phase 1 run cannot be attributed to its gate');
console.log(`Staging build verified: ${expected}`);
