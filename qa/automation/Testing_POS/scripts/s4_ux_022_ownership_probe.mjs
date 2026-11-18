// Read-only recovery probe for the S4-UX-022 run that ended before cleanup.
// Prints only table/session/order IDs and lifecycle timestamps, never credentials.
const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const pin = process.env.S2_STAGING_PIN;
const expected = process.env.POS_EXPECTED_COMMIT;
if (base !== 'http://160.191.47.17' || !pin || !/^[a-f0-9]{40}$/.test(expected || ''))
  throw new Error('Set QA3 PIN and full expected staging SHA; staging base only');

async function get(path, token) {
  const response = await fetch(base + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

const before = await get('/version');
if (before.environment !== 'staging' || before.commit !== expected)
  throw new Error('Staging SHA/environment changed; probe stopped');
const login = await fetch(base + '/api/v1/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'qa3_waiter', password: pin }),
  signal: AbortSignal.timeout(20_000),
});
if (login.status !== 200) throw new Error(`QA3 login: HTTP ${login.status}`);
const auth = await login.json();
if (auth.staff?.role !== 'WAITER') throw new Error('Unexpected staff role');
const tables = await get('/api/v1/tables', auth.access_token);
const q3 = tables.find(row => row.code === 'Q3-1');
if (!q3) throw new Error('Q3-1 absent');
const table = await get(`/api/v1/tables/${q3.id}`, auth.access_token);
const session = table.current_session;
const orders = (table.orders || []).filter(row =>
  session && row.table_session_id === session.id);
const orderDetails = [];
for (const row of orders) {
  try {
    const order = await get(`/api/v1/orders/${row.id}`, auth.access_token);
    orderDetails.push({ id: order.id, status: order.status,
      created_at: order.created_at ?? null, item_count: order.items?.length ?? null,
      table_session_id: order.table_session_id });
  } catch {
    orderDetails.push({ id: row.id, status: row.status ?? null,
      created_at: row.created_at ?? null, item_count: null,
      table_session_id: row.table_session_id });
  }
}
const after = await get('/version');
console.log(JSON.stringify({ result: 'READ_ONLY', table_code: q3.code,
  table_id: q3.id, table_status: table.status,
  current_session: session ? { id: session.id,
    opened_at: session.opened_at ?? null } : null,
  orders: orderDetails, build_stable: after.commit === before.commit,
  mutations: 0, secrets_recorded: false }, null, 2));
