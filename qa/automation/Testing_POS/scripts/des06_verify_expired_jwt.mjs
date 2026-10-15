// DES06-TC-033: observe a real JWT for at most 15 minutes. If it expires within
// that window, verify GET/POST rejection; otherwise record Pending evidence.
// No token or password is printed or written to disk.
import { randomUUID } from 'node:crypto';

const base = String(process.env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
const password = process.env.DES06_SEED_PASSWORD;
delete process.env.DES06_SEED_PASSWORD;

if (!password) {
  console.log('[DES-QA-06] TC-033 PENDING: local staging PIN missing');
  process.exitCode = 2;
} else {
  try {
    await main();
  } catch (error) {
    console.log(`[DES-QA-06] TC-033 FAILED/INCONCLUSIVE: ${error.message}`);
    process.exitCode = 1;
  }
}

async function request(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Cache-Control': 'no-store',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* Status remains available for non-JSON errors. */ }
  return { status: response.status, data, serverDate: response.headers.get('date') };
}

function requireStatus(response, expected, operation) {
  if (response.status !== expected) throw new Error(`${operation} HTTP ${response.status}; expected ${expected}`);
}

async function version() {
  const result = await request('GET', '/version');
  requireStatus(result, 200, 'GET /version');
  if (!/^[0-9a-f]{40}$/i.test(result.data?.commit || '')) throw new Error('GET /version missing full commit');
  const serverTime = Date.parse(result.serverDate || '');
  if (!Number.isFinite(serverTime)) throw new Error('Server Date header missing');
  return { commit: result.data.commit, serverTime };
}

async function login() {
  const result = await request('POST', '/api/v1/auth/login', null, { username: 'admin', password });
  requireStatus(result, 200, 'admin login');
  const token = result.data?.access_token;
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('Login JWT missing');
  return token;
}

function tokenTimes(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat) || payload.exp <= payload.iat) {
    throw new Error('JWT exp/iat claims invalid');
  }
  return { issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
}

async function main() {
  const before = await version();
  const expiredToken = await login();
  const { issuedAt, expiresAt } = tokenTimes(expiredToken);
  if (expiresAt <= before.serverTime) throw new Error('JWT already expired at login');
  const valid = await request('GET', '/api/v1/menu', expiredToken);
  requireStatus(valid, 200, 'Menu GET with valid JWT');
  const started = await version();
  if (started.commit !== before.commit) throw new Error('staging changed during login');
  const observationDeadline = started.serverTime + 15 * 60 * 1000;
  const lifetimeMinutes = Math.round((expiresAt - issuedAt) / 60000);
  console.log(`[DES-QA-06] TC-033 start: staging ${before.commit.slice(0, 12)}; valid JWT GET Menu 200; JWT exp ${new Date(expiresAt).toISOString()}; exp-iat ${lifetimeMinutes} minutes`);
  console.log('[DES-QA-06] TC-033 observing for at most 15 minutes; expiry rejection is checked only if token actually expires');

  // Use the server Date header as the clock. A 3-second margin avoids second-level rounding.
  let current;
  let nextProgressMinute = 5;
  do {
    current = await version();
    if (current.commit !== before.commit) {
      console.log(`[DES-QA-06] TC-033 PENDING: staging changed ${before.commit.slice(0, 12)} -> ${current.commit.slice(0, 12)} during wait`);
      process.exitCode = 2;
      return;
    }
    const untilExpiry = expiresAt + 3000 - current.serverTime;
    if (untilExpiry <= 0) break;
    const untilDeadline = observationDeadline - current.serverTime;
    if (untilDeadline <= 0) {
      const observedGet = await request('GET', '/api/v1/menu', expiredToken);
      requireStatus(observedGet, 200, 'Menu GET with unexpired JWT after observation');
      console.log(`[DES-QA-06] TC-033 PENDING: JWT still valid after 15-minute observation; GET Menu 200; JWT exp ${new Date(expiresAt).toISOString()}; exp-iat ${lifetimeMinutes} minutes; remaining ${Math.ceil((expiresAt - current.serverTime) / 60000)} minutes. Expired GET/POST not executed; no Menu mutation.`);
      process.exitCode = 2;
      return;
    }
    const observedMinutes = Math.floor((current.serverTime - started.serverTime) / 60000);
    if (observedMinutes >= nextProgressMinute) {
      console.log(`[DES-QA-06] TC-033 observation: ${observedMinutes}/15 minutes; JWT has not expired`);
      nextProgressMinute += 5;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(60000, Math.max(1000, Math.min(untilExpiry, untilDeadline)))));
  } while (true);

  const expiredGet = await request('GET', '/api/v1/menu', expiredToken);
  const guardName = `DES06-QA-EXPIRED-${randomUUID()}`;
  const noSuchCategory = '00000000-0000-0000-0000-000000000000';
  const expiredPost = await request('POST', '/api/v1/menu', expiredToken, {
    name: guardName, price: '1', category_id: noSuchCategory, station_id: noSuchCategory,
  });

  // Even if expired authentication is broken, nonexistent references prevent creation.
  // Verify the unique name using a new token before declaring the result.
  const freshToken = await login();
  const search = await request('GET', `/api/v1/menu?q=${encodeURIComponent(guardName)}&available_only=false`, freshToken);
  requireStatus(search, 200, 'guarded Menu search');
  if (!Array.isArray(search.data)) throw new Error('guarded Menu search is not an array');
  const created = search.data.filter((item) => item.name === guardName);
  if (created.length) {
    for (const item of created) {
      const disabled = await request('PATCH', `/api/v1/menu/${item.id}`, freshToken, { is_available: false });
      if (disabled.status !== 200) console.log(`[DES-QA-06] CLEANUP REQUIRED: Menu item ${item.id}`);
    }
    throw new Error(`expired-token request unexpectedly created ${created.length} Menu item(s)`);
  }
  console.log(`[DES-QA-06] TC-033 diagnostic: server time ${new Date(current.serverTime).toISOString()}; expired GET ${expiredGet.status}; guarded POST ${expiredPost.status}; new Menu records 0`);
  if (expiredGet.status !== 401 || expiredPost.status !== 401) {
    throw new Error('expired JWT must return 401 for GET and POST');
  }
  console.log(`[DES-QA-06] DES06-TC-033 PASS: staging ${before.commit.slice(0, 12)}; valid JWT GET 200 before expiry; expired JWT GET/POST 401 after expiry; no Menu record created`);
}
