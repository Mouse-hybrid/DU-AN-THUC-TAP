// P2-USR-008 staging side: QA3 effective permission matrix and safe HTTP guards.
// Pair with backend/tests/test_permissions.py and a same-build customer QR UI run.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.env.POS_STAGING_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.S2_STAGING_PIN || process.env.P2_QA_SEED_PASSWORD;
const expected = process.env.POS_EXPECTED_COMMIT;
const output = process.argv[2];
const customerEvidencePath = process.argv[3];
if (base !== 'http://160.191.47.17' || !pin ||
    !/^[a-f0-9]{40}$/.test(expected || '') || !output || !customerEvidencePath)
  throw Error('QA staging, private PIN, pinned full SHA and output required');

const floor = ['CASHIER', 'WAITER', 'SUPERVISOR'];
const supervisor = ['SUPERVISOR'];
const expectedRoles = {
  ORDER_WRITE: floor, SEND_TO_KITCHEN: floor, REQUEST_BILLING: floor,
  PROCESS_PAYMENT: ['CASHIER', 'SUPERVISOR'], OVERRIDE: supervisor,
  VIEW_KDS: ['KITCHEN', 'SUPERVISOR'],
  KITCHEN_ACTION: ['KITCHEN', 'SUPERVISOR'],
  SERVE_FOOD: ['WAITER', 'SUPERVISOR'], TABLE_OPEN: floor,
  TABLE_MARK_CLEAN: ['WAITER', 'SUPERVISOR'],
  TABLE_LAYOUT_MANAGE: supervisor,
  TABLE_TRANSFER: ['WAITER', 'SUPERVISOR'], QR_SESSION_MANAGE: floor,
  MENU_WRITE: supervisor, AUDIT_READ: supervisor, STAFF_MANAGE: supervisor,
  CUSTOMER_ACCESS: ['CASHIER', 'SUPERVISOR'],
  REWARD_APPLY: ['CASHIER', 'SUPERVISOR'],
  LOYALTY_MANAGE: supervisor, PAYMENT_REFUND: supervisor,
  OUTLET_SETTINGS: supervisor,
};
const users = [
  ['admin', 'qa3_admin', 'SUPERVISOR'],
  ['cashier', 'qa3_cashier', 'CASHIER'],
  ['waiter', 'qa3_waiter', 'WAITER'],
  ['kitchen', 'qa3_kitchen', 'KITCHEN'],
];
const tokens = {};
const report = {
  run_id: 'RUN-' + new Date().toISOString().replace(/\D/g, '') + '-P2USR008',
  test_ref: 'P2-USR-008', checked_at: new Date().toISOString(),
  scope: 'QA3 effective 21-permission contract and 84 runtime authorization cells with invalid fixture IDs, plus same-build customer QR positive evidence; no runtime business write in this run.',
  case_coverage: 'QA3_21_PERMISSION_RUNTIME_MATRIX_AND_CUSTOMER_QR_EVIDENCE',
  secrets_recorded: false, mutations: 0, checks: {}, rows: [],
};
const redact = error => {
  let value = String(error);
  for (const secret of [pin, ...Object.values(tokens)])
    if (secret) value = value.replaceAll(secret, '<REDACTED>');
  return value;
};
async function call(method, path, role, data) {
  const headers = { Accept: 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + tokens[role];
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
  const res = await fetch(base + path, { method, headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(20_000) });
  return { http: res.status, data: await res.json().catch(() => null) };
}
async function must(method, path, role, status, data) {
  const result = await call(method, path, role, data);
  if (result.http !== status) throw Error(method + ' ' + path.split('?')[0] +
    ': HTTP ' + result.http + ', expected ' + status);
  return result.data;
}
async function build() {
  const result = await must('GET', '/version', null, 200);
  if (result.environment !== 'staging') throw Error('Wrong environment');
  return result.commit;
}
let before, failure;
try {
  before = await build();
  report.staging_commit = before;
  if (before !== expected) throw Error('PENDING_BUILD: staging SHA changed');
  let outlet;
  for (const [role, username, expectedRole] of users) {
    const login = await must('POST', '/api/v1/auth/login', null, 200,
      { username, password: pin });
    if (!login.access_token || login.staff?.role !== expectedRole ||
        !login.staff?.outlet_id || outlet && outlet !== login.staff.outlet_id)
      throw Error('PENDING_FIXTURE: QA3 role/outlet mismatch for ' + role);
    tokens[role] = login.access_token;
    outlet = login.staff.outlet_id;
  }
  report.outlet_id = outlet;
  const effective = await must('GET', '/api/v1/staff/permissions', 'admin', 200);
  const actual = new Map(effective.map(row => [row.permission, row.roles]));
  report.checks.effective_matrix_matches_adr =
    actual.size === Object.keys(expectedRoles).length &&
    Object.entries(expectedRoles).every(([permission, allowed]) =>
      Array.isArray(actual.get(permission)) &&
      JSON.stringify([...actual.get(permission)].sort()) ===
        JSON.stringify([...allowed].sort()));
  if (!report.checks.effective_matrix_matches_adr)
    throw Error('PENDING_POLICY: QA3 effective permission roles differ from ADR default');
  for (const [role, , name] of users) {
    const tables = await call('GET', '/api/v1/tables', role);
    const queue = await call('GET', '/api/v1/kitchen/queue', role);
    const staff = await call('GET', '/api/v1/staff/permissions', role);
    const row = { role: name, tables_http: tables.http, kds_http: queue.http,
      permissions_http: staff.http };
    row.matches = tables.http === 200 &&
      queue.http === (['KITCHEN', 'SUPERVISOR'].includes(name) ? 200 : 403) &&
      staff.http === (name === 'SUPERVISOR' ? 200 : 403);
    report.rows.push(row);
  }
  report.checks.runtime_get_guards = report.rows.every(row => row.matches);
  const absentSession = randomUUID(), absentTable = randomUUID();
  const kitchenCreate = await call('POST', '/api/v1/orders', 'kitchen',
    { table_session_id: absentSession });
  const anonCreate = await call('POST', '/api/v1/orders', null,
    { table_session_id: absentSession });
  const kitchenQR = await call('POST', '/api/v1/tables/' + absentTable +
    '/qr-session', 'kitchen');
  const anonKds = await call('GET', '/api/v1/kitchen/queue', null);
  report.http = { kitchen_create_order: kitchenCreate.http,
    customer_create_staff_order: anonCreate.http,
    kitchen_issue_qr: kitchenQR.http, anonymous_kds: anonKds.http };
  report.checks.runtime_write_denials = kitchenCreate.http === 403 &&
    anonCreate.http === 401 && kitchenQR.http === 403 && anonKds.http === 401;
  // Every declared permission has a representative runtime endpoint. Use invalid
  // entity IDs or invalid bodies so allowed roles fail validation, never mutate data.
  const absent = randomUUID();
  const cases = {
    ORDER_WRITE: ['POST', '/api/v1/orders'],
    SEND_TO_KITCHEN: ['POST', `/api/v1/orders/${absent}/send-to-kitchen`],
    REQUEST_BILLING: ['POST', `/api/v1/orders/${absent}/request-billing`],
    PROCESS_PAYMENT: ['POST', `/api/v1/orders/${absent}/payments`],
    OVERRIDE: ['POST', `/api/v1/orders/${absent}/items/${absent}/void`],
    VIEW_KDS: ['GET', '/api/v1/kitchen/queue'],
    KITCHEN_ACTION: ['POST', `/api/v1/orders/${absent}/items/${absent}/start-cooking`],
    SERVE_FOOD: ['POST', `/api/v1/orders/${absent}/items/${absent}/served`],
    TABLE_OPEN: ['POST', `/api/v1/tables/${absent}/open-session`],
    TABLE_MARK_CLEAN: ['POST', `/api/v1/tables/${absent}/mark-clean`],
    TABLE_LAYOUT_MANAGE: ['PATCH', `/api/v1/tables/${absent}`],
    TABLE_TRANSFER: ['POST', `/api/v1/tables/${absent}/transfer`],
    QR_SESSION_MANAGE: ['POST', `/api/v1/tables/${absent}/qr-session`],
    MENU_WRITE: ['POST', '/api/v1/menu'],
    AUDIT_READ: ['GET', '/api/v1/audit-logs?limit=1'],
    STAFF_MANAGE: ['POST', '/api/v1/staff'],
    CUSTOMER_ACCESS: ['GET', `/api/v1/customers/${absent}`],
    REWARD_APPLY: ['GET', `/api/v1/orders/${absent}/eligible-rewards`],
    LOYALTY_MANAGE: ['GET', '/api/v1/loyalty-rules'],
    PAYMENT_REFUND: ['POST', `/api/v1/payments/${absent}/refunds`],
    OUTLET_SETTINGS: ['GET', '/api/v1/outlet/settings'],
  };
  if (Object.keys(cases).length !== Object.keys(expectedRoles).length)
    throw Error('Permission coverage incomplete');
  report.matrix = [];
  for (const [permission, [method, path]] of Object.entries(cases)) {
    for (const [role, , name] of users) {
      const response = await call(method, path, role, method === 'GET' ? undefined : {});
      const allowed = expectedRoles[permission].includes(name);
      const matches = allowed ? response.http !== 401 && response.http !== 403 && response.http < 500
        : response.http === 403;
      report.matrix.push({ permission, role: name, http: response.http, matches });
    }
  }
  report.checks.runtime_matrix_all_cells = report.matrix.length === 84 &&
    report.matrix.every(row => row.matches);
  const customer = JSON.parse(readFileSync(customerEvidencePath, 'utf8'));
  report.customer_evidence = { run_id: customer.run_id, test_ref: customer.test_ref,
    staging_commit: customer.staging_commit, result: customer.result };
  report.checks.customer_qr_positive =
    customer.test_ref === 'S4-QR-CUSTOMER-DIRECT-UI' && customer.result === 'PASSED' &&
    customer.staging_commit === before && customer.build_stable === true &&
    customer.cleanup_pass === true && customer.ui_submit_http === 201 &&
    customer.checks?.customer_receipt_visible === true &&
    customer.checks?.direct_sent === true;
  if (!Object.values(report.checks).every(Boolean))
    throw Error('QA3 role matrix or customer evidence mismatch');
} catch (error) { failure = redact(error?.message || error); }
try { report.build_after = await build(); } catch { report.build_after = null; }
report.build_stable = before === expected && report.build_after === before;
report.result = !failure && report.build_stable ? 'PASSED' :
  /^PENDING_/.test(failure || '') ? 'PENDING' : 'FAILED';
if (failure) report.error = failure;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('[P2-USR-008] Result: ' + JSON.stringify(report));
if (report.result !== 'PASSED') process.exitCode = 1;
