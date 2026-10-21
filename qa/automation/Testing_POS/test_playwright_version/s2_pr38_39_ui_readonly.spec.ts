import {expect, test} from '@playwright/test';

// PR #38/#39 readiness. Reads existing QA data; never clicks a business action.
test('S2-UI-PF-01 | table detail and order summary render for an existing QA order', async ({page, request}, testInfo) => {
  test.setTimeout(45_000);
  const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
  expect(base, 'approved staging').toBe('http://160.191.47.17');
  const pin = process.env.S2_STAGING_PIN;
  test.skip(!pin, 'Local staging PIN required');

  const mutations: string[] = [];
  const responses: Array<{path: string; status: number}> = [];
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/api/v1/') && req.method() !== 'GET' &&
        path !== '/api/v1/auth/login') mutations.push(`${req.method()} ${path}`);
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/v1/')) responses.push({path, status: response.status()});
  });

  const login = await request.post(base + '/api/v1/auth/login', {
    data: {username: 'cashier', password: pin}, timeout: 20_000,
  });
  expect(login.status(), 'Cashier API login').toBe(200);
  const token = (await login.json()).access_token as string;
  const headers = {Authorization: `Bearer ${token}`};
  const tablesResult = await request.get(base + '/api/v1/tables', {headers});
  expect(tablesResult.status(), 'table inventory').toBe(200);
  const tables = await tablesResult.json() as Array<{id: string; code: string}>;

  let fixture: {id: string; code: string; orderId: string; orderStatus: string} | undefined;
  for (const table of tables.filter(candidate => /^B[1-4]$/.test(candidate.code))) {
    const result = await request.get(base + `/api/v1/tables/${table.id}`, {headers});
    expect(result.status(), `read QA table ${table.code}`).toBe(200);
    const detail = await result.json() as {orders: Array<{id: string; status: string}>};
    const order = detail.orders.find(candidate =>
      ['NEW', 'SENT', 'SERVED', 'BILLING', 'PAID'].includes(candidate.status));
    if (order) {
      fixture = {id: table.id, code: table.code, orderId: order.id, orderStatus: order.status};
      break;
    }
  }
  if (!fixture) console.log('[S2-UI] PF-01 PENDING: no existing B1-B4 QA order; no UI business action');
  test.skip(!fixture, 'No existing QA order for read-only detail/summary inspection');

  await page.goto('/login', {waitUntil: 'domcontentloaded'});
  await page.getByLabel('Mã nhân viên', {exact: true}).fill('cashier');
  await page.getByLabel('Mã PIN', {exact: true}).fill(pin!);
  await page.getByRole('button', {name: 'Đăng nhập', exact: true}).click();
  await expect(page).toHaveURL(/\/tables$/, {timeout: 15_000});

  await page.goto(`/tables/${fixture!.id}`, {waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('heading', {name: `Bàn ${fixture!.code}`})).toBeVisible();
  await expect(page.getByRole('link', {name: `Tóm tắt đơn bàn ${fixture!.code}`})).toBeVisible();
  await testInfo.attach('S2_UI_table_detail', {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
  await page.getByRole('link', {name: `Tóm tắt đơn bàn ${fixture!.code}`}).click();
  await expect(page).toHaveURL(new RegExp(`/tables/${fixture!.id}/summary$`));
  await expect(page.getByRole('heading', {name: `Bàn ${fixture!.code}`})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Các món trong đơn'})).toBeVisible();
  await testInfo.attach('S2_UI_order_summary', {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});

  expect(mutations, 'no business mutation from read-only UI inspection').toEqual([]);
  const evidence = {fixture, responses, scope: 'PR #38/#39 route/readiness only; actions, payment and cleanup untested'};
  await testInfo.attach('S2_UI_PF_01_diagnostics', {
    body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
  });
  console.log(`[S2-UI] PF-01 PASS: ${fixture!.code}; order ${fixture!.orderId} ${fixture!.orderStatus}; ` +
    'detail and summary rendered; no business mutation; lifecycle remains untested');
});
