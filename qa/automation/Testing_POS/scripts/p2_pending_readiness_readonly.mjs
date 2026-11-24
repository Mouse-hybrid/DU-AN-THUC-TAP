// Read-only contract and QA fixture readiness for unresolved Phase 2 cases.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.P2_QA_SEED_PASSWORD || process.env.S2_STAGING_PIN;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
if (base !== 'http://160.191.47.17' || !pin ||
    !/^[0-9a-f]{40}$/.test(expected || '') || !output)
  throw Error('QA staging, private PIN, pinned 40-character commit and output required');
const report = { test_ref: 'PF-P2-PENDING-READINESS',
  checked_at: new Date().toISOString(), scope: 'Read-only staging OpenAPI and QA2/QA3 fixture inventory; no testcase is passed by this preflight.',
  token_recorded: false, secrets_recorded: false, business_mutations: 0 };
let tokens = {}, before, failure;
const safe = error => {
  let msg = String(error);
  for (const secret of [pin, ...Object.values(tokens)])
    if (secret) msg = msg.replaceAll(secret, '<REDACTED>');
  return msg;
};
async function get(path, role) {
  const response = await fetch(base + path, { headers: {
    Accept: 'application/json', ...(role ? { Authorization: 'Bearer ' + tokens[role] } : {}),
  }, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => null);
  if (response.status !== 200) throw Error('GET ' + path + ': HTTP ' + response.status);
  return body;
}
async function login(role) {
  const response = await fetch(base + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: role, password: pin }),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw Error('PENDING_FIXTURE: ' + role +
    ' login HTTP ' + response.status);
  const body = await response.json();
  if (body.staff?.role !== 'SUPERVISOR' || !body.access_token)
    throw Error('PENDING_FIXTURE: ' + role + ' supervisor identity mismatch');
  tokens[role] = body.access_token;
  return body.staff.outlet_id;
}
try {
  const v = await get('/version');
  if (v.environment !== 'staging') throw Error('Wrong environment');
  before = v.commit;
  if (before !== expected) throw Error('PENDING_BUILD: staging SHA changed');
  report.build_before = before;
  const spec = await get('/openapi.json');
  const qa3 = await login('qa3_admin');
  const qa2 = await login('qa2_admin');
  if (!qa3 || !qa2 || qa3 === qa2) throw Error('PENDING_FIXTURE: distinct outlets required');
  const [qa3Menu, qa2Menu, qa3Tables, qa2Tables] = await Promise.all([
    get('/api/v1/menu?available_only=true', 'qa3_admin'),
    get('/api/v1/menu?available_only=true', 'qa2_admin'),
    get('/api/v1/tables', 'qa3_admin'), get('/api/v1/tables', 'qa2_admin'),
  ]);
  const mappedCount = rows => rows.filter(item =>
    item.is_available && item.station_id && !item.has_modifiers).length;
  report.fixture = {
    distinct_outlets: true, qa3_mapped_items: mappedCount(qa3Menu),
    qa2_mapped_items: mappedCount(qa2Menu),
    qa3_available_tables: qa3Tables.filter(row => row.status === 'AVAILABLE')
      .map(row => row.code),
    qa2_available_tables: qa2Tables.filter(row => row.status === 'AVAILABLE')
      .map(row => row.code),
  };
  const paths = spec.paths || {};
  const has = (path, method) => !!paths[path]?.[method];
  const publicRoutes = Object.entries(paths)
    .filter(([path]) => path.startsWith('/api/v1/public/qr/'))
    .map(([path, operations]) => ({ path,
      methods: Object.keys(operations).filter(key =>
        ['get', 'post', 'patch', 'put', 'delete'].includes(key)).map(key => key.toUpperCase()) }));
  const gatewayRoutes = Object.entries(paths)
    .filter(([path]) => /payment|gateway|vnpay|card/i.test(path))
    .map(([path, operations]) => ({ path,
      methods: Object.keys(operations).filter(key =>
        ['get', 'post', 'patch', 'put', 'delete'].includes(key)).map(key => key.toUpperCase()) }));
  report.contract = {
    public_qr_routes: publicRoutes,
    qr_direct_order_lookup: publicRoutes.some(row =>
      /\{(?:order_id|id)\}/.test(row.path) && row.methods.includes('GET')),
    qr_customer_modify_cancel: publicRoutes.some(row =>
      /\{(?:order_id|item_id|id)\}/.test(row.path) &&
      row.methods.some(method => ['PATCH', 'PUT', 'DELETE'].includes(method))),
    refresh_token_post: has('/api/v1/auth/refresh', 'post'),
    pin_login_post: has('/api/v1/auth/pin-login', 'post'),
    gateway_routes: gatewayRoutes,
    expected_version_declared: JSON.stringify(spec.components?.schemas || {})
      .includes('expected_version'),
  };
  report.blockers = {
    'P2-QR-008': [
      ...(report.fixture.qa2_mapped_items ? [] : ['QA2_MAPPED_MENU_ITEM']),
      ...(report.contract.qr_direct_order_lookup ? [] : ['PUBLIC_ORDER_ID_LOOKUP_CONTRACT']),
    ],
    'P2-USR-006': report.contract.pin_login_post ? [] : ['PIN_LOGIN_CONTRACT'],
    'P2-USR-007': report.contract.refresh_token_post ? [] : ['REFRESH_CONTRACT'],
    'P2-ORD-001': report.contract.expected_version_declared ? [] :
      ['EXPECTED_VERSION_CONTRACT'],
  };
  report.result = 'READINESS_RECORDED';
} catch (error) { failure = safe(error); report.result = 'INCONCLUSIVE'; }
try {
  const after = await get('/version');
  report.build_after = after.commit;
  report.build_stable = before === after.commit;
} catch { report.build_stable = false; }
if (!report.build_stable) report.result = 'INCONCLUSIVE';
if (failure) report.error = failure;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('[P2-READINESS] Result: ' + JSON.stringify(report));
if (report.result !== 'READINESS_RECORDED') process.exitCode = 1;
