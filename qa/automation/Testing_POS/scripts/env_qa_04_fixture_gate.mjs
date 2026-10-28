// ENV-QA-04: offline, read-only decision gate for Phase 2 QR/Rewards fixtures.
// No staging request or business mutation occurs in this script.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [inventoryPath, manifestPath, outputPath] = process.argv.slice(2);
if (!inventoryPath) {
  console.error('Usage: node env_qa_04_fixture_gate.mjs INVENTORY.json [FIXTURES.json|-] [EVIDENCE.json]');
  process.exit(1);
}
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/i.test(s);
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const manifest = manifestPath && manifestPath !== '-' ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
if (!sha(inventory.commit) || !inventory.groups || typeof inventory.groups !== 'object') {
  throw new Error('Invalid DES-QA-07 inventory: full commit and groups required');
}
const requirements = {
  qr: ['qr'],
  rewards: ['rewards'],
  payment: ['payment_v2'],
};
const reasons = [];
for (const [name, groups] of Object.entries(requirements)) {
  if (groups.every(group => !Array.isArray(inventory.groups[group]) || inventory.groups[group].length === 0)) {
    reasons.push(`${name}: no candidate operation documented in OpenAPI`);
  }
}
if (!manifest) {
  reasons.push('No BE/CRM fixture manifest supplied');
} else {
  if (manifest.staging_commit !== inventory.commit) reasons.push('Fixture SHA differs from inventory SHA');
  if (!manifest.owner || typeof manifest.owner !== 'string') reasons.push('Fixture owner missing');
  if (manifest.cleanup_approved !== true) reasons.push('Cleanup approval/owner missing');
  for (const [group, fields] of Object.entries({
    qr: ['table_id', 'table_session_id', 'token_issuer_confirmed'],
    rewards: ['tenant_id', 'member_id', 'ledger_baseline_confirmed'],
    payment: ['sandbox_confirmed', 'reconciliation_confirmed'],
  })) {
    const f = manifest[group] || {};
    for (const field of fields) if (!f[field]) reasons.push(`${group}.${field} missing`);
  }
}
const result = {
  task: 'ENV-QA-04', checked_at: new Date().toISOString(), staging_commit: inventory.commit,
  status: reasons.length ? 'BLOCKED' : 'READY_FOR_QA_REVIEW', reasons,
  business_execution: 'NOT_EXECUTED',
  note: 'Static gate only. Candidate OpenAPI paths and fixture manifest still require QA review before mutation.',
};
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = reasons.length ? 2 : 0;
