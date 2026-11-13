import { expect, test } from '@playwright/test';

const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');

async function prepare(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const pin = process.env.S2_STAGING_PIN;
  const expected = process.env.POS_EXPECTED_COMMIT;
  test.skip(!pin || !expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
  expect(base).toBe('http://160.191.47.17');
  const before = await request.get(base + '/version', { timeout: 20_000 });
  expect(before.status()).toBe(200);
  const build = (await before.json()).commit as string;
  test.skip(build !== expected, `PENDING_BUILD: expected ${expected}, staging ${build}`);

  const reads: Array<{ path: string; status: number }> = [];
  const writes: string[] = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/v1/') && response.request().method() === 'GET')
      reads.push({ path, status: response.status() });
  });
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(req.method()) &&
        path !== '/api/v1/auth/login') writes.push(`${req.method()} ${path}`);
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Tên đăng nhập', { exact: true }).fill('admin');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(pin!);
  const [login] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/login' &&
      response.request().method() === 'POST', { timeout: 20_000 }),
    page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(),
  ]);
  expect(login.status()).toBe(200);
  await expect(page).toHaveURL(/\/tables$/, { timeout: 15_000 });
  return { build, reads, writes };
}

async function finish(request: import('@playwright/test').APIRequestContext, build: string, writes: string[]) {
  expect(writes).toEqual([]);
  const after = await request.get(base + '/version', { timeout: 20_000 });
  expect(after.status()).toBe(200);
  expect((await after.json()).commit).toBe(build);
}

test('PF-S4-PROFILE-READONLY | supervisor views own profile', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const { build, reads, writes } = await prepare(page, request);
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', { name: 'Hồ sơ của tôi' })).toBeVisible();
  await expect(page.locator('.nova-profile-list dd').first()).toHaveText('admin', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Đổi mật khẩu' })).toBeVisible();
  await expect.poll(() => reads.some(row => row.path === '/api/v1/auth/me' && row.status === 200),
    { timeout: 15_000, message: 'Profile must load GET /api/v1/auth/me' }).toBe(true);
  await finish(request, build, writes);
  await testInfo.attach('PF_S4_PROFILE_readonly', {
    body: JSON.stringify({ build, path: '/profile', reads, writes,
      scope: 'Own profile display only; password change and edits not tested' }, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('PF_S4_PROFILE_screen', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png',
  });
});

test('PF-S4-HISTORY-READONLY | supervisor views order history', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const { build, reads, writes } = await prepare(page, request);
  await page.goto('/history', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole('heading', { name: 'Lịch sử đơn hàng' })).toBeVisible();
  await expect.poll(() => reads.some(row => row.path === '/api/v1/orders' && row.status === 200),
    { timeout: 20_000, message: 'History must load GET /api/v1/orders' }).toBe(true);
  await expect(page.getByRole('searchbox', { name: 'Tìm theo mã đơn hoặc bàn' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Đã đóng/ }).first()).toBeVisible();
  await finish(request, build, writes);
  await testInfo.attach('PF_S4_HISTORY_readonly', {
    body: JSON.stringify({ build, path: '/history', reads, writes,
      scope: 'Order history display only; closing an order and CSV export not tested' }, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('PF_S4_HISTORY_screen', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png',
  });
});
