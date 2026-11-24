// TC_EXT_019: QA2 cannot read an existing QA3 order; no business writes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.S2_STAGING_PIN || process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17') throw new Error('Approved QA staging origin only');
if (!output || !pin || !/^[a-f0-9]{40}$/.test(expected || '')) {
  console.error('Usage: set S2_STAGING_PIN and full POS_EXPECTED_COMMIT privately; node scripts/tc_ext_019_cross_outlet_readonly.mjs OUTPUT.json');
  process.exit(2);
}
const tokens = {};
const report = {
  run_id: `RUN-${new Date().toISOString().replace(/\D/g, '')}-TCEXT019`,
  test_ref: 'TC_EXT_019', checked_at: new Date().toISOString(),
  scope: 'Existing QA3 order GET 200; QA2 direct GET same order 404 with no data leak; read-only staging and stable build.',
  secrets_recorded: false, mutations: 0, checks: {}, result: 'INCONCLUSIVE',
};
const safe = error => {
  let value = String(error?.message || error);
  for (const secret of [pin, ...Object.values(tokens)])
    if (secret) value = value.replaceAll(secret, '<REDACTED>');
  return value;
};
async function call(method, path, role, body) {
  const headers = { Accept: 'application/json' };
  if (role) headers.Authorization = `Bearer ${tokens[role]}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { http: res.status, data };
}
const get = (path, role) => call('GET', path, role);
async function version() {
  const r = await get('/version');
  if (r.http !== 200 || r.data?.environment !== 'staging' ||
      !/^[a-f0-9]{40}$/.test(r.data.commit || '')) throw new Error('PENDING_BUILD: staging version unavailable');
  return r.data.commit;
}
function rowsOf(data) { return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []; }
let failure;
try {
  report.build_before = await version();
  if (report.build_before !== expected) throw new Error('PENDING_BUILD: staging SHA changed');
  const outlets = {};
  for (const [key, username] of [['qa3', 'qa3_admin'], ['qa2', 'qa2_admin']]) {
    const r = await call('POST', '/api/v1/auth/login', null, { username, password: pin });
    if (r.http !== 200 || r.data?.staff?.role !== 'SUPERVISOR' ||
        !r.data.access_token || !r.data.staff.outlet_id)
      throw new Error(`PENDING_FIXTURE: ${key} supervisor login unavailable`);
    tokens[key] = r.data.access_token;
    outlets[key] = r.data.staff.outlet_id;
  }
  if (outlets.qa3 === outlets.qa2) throw new Error('PENDING_FIXTURE: distinct QA outlets required');
  const audit = await get('/api/v1/audit-logs?sort=desc&limit=100', 'qa3');
  if (audit.http !== 200) throw new Error(`QA3 audit GET HTTP ${audit.http}`);
  const ids = [...new Set(rowsOf(audit.data)
    .filter(row => row.entity_type === 'order' && typeof row.entity_id === 'string')
    .map(row => row.entity_id))].slice(0, 20);
  let id, before;
  for (const candidate of ids) {
    const r = await get(`/api/v1/orders/${encodeURIComponent(candidate)}`, 'qa3');
    if (r.http === 200 && r.data?.id === candidate) { id = candidate; before = r.data; break; }
  }
  if (!id) throw new Error('PENDING_FIXTURE: no readable QA3 order among recent audit rows');
  const foreign = await get(`/api/v1/orders/${encodeURIComponent(id)}`, 'qa2');
  const after = await get(`/api/v1/orders/${encodeURIComponent(id)}`, 'qa3');
  const ownAudit = await get(`/api/v1/audit-logs?order_id=${encodeURIComponent(id)}&limit=100`, 'qa3');
  if (ownAudit.http !== 200) throw new Error(`QA3 order audit GET HTTP ${ownAudit.http}`);
  report.order_id = id;
  report.outlet_ids = outlets;
  report.http = { qa3_before: 200, qa2_cross_outlet: foreign.http, qa3_after: after.http };
  report.candidate_count = ids.length;
  report.checks = {
    distinct_outlets: outlets.qa3 !== outlets.qa2,
    own_order_readable: before.id === id && !!before.table_session_id,
    foreign_order_denied: foreign.http === 404,
    foreign_no_order_leak: !JSON.stringify(foreign.data).includes(id) &&
      !JSON.stringify(foreign.data).includes(String(before.table_session_id)),
    own_order_unchanged: after.http === 200 && JSON.stringify(after.data) === JSON.stringify(before),
    own_audit_readable: rowsOf(ownAudit.data).length > 0,
  };
  if (!Object.values(report.checks).every(Boolean))
    throw new Error('Cross-outlet order isolation mismatch');
} catch (error) { failure = safe(error); }
try { report.build_after = await version(); } catch { report.build_after = null; }
report.build_stable = !!report.build_before && report.build_before === report.build_after;
report.result = !failure && report.build_stable ? 'PASSED' :
  /^PENDING_/.test(failure || '') ? 'PENDING' : 'FAILED';
if (failure) report.error = failure;
mkdirSync(join(process.cwd(), 'evidence'), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('[TC_EXT_019] Result: ' + JSON.stringify(report));
if (report.result !== 'PASSED') process.exitCode = report.result === 'PENDING' ? 2 : 1;
