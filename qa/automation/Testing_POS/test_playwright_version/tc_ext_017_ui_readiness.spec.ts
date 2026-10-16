import { test, expect } from '@playwright/test';

// Read-only UI readiness for TC_EXT_017. A passing readiness probe is not a
// passing reconnect/resync business testcase. Never log PIN, JWT or WS query.
test('PF-UI-017 | Kitchen screen supports queue and WebSocket', async ({ page }, testInfo) => {
  const pin = process.env.PHASE1_STAGING_PIN;
  test.skip(!pin, 'Local staging PIN is required for read-only Kitchen UI inspection');
  const base = process.env.BASE_URL || 'http://160.191.47.17';
  expect(base.replace(/\/+$/, ''), 'approved staging origin').toBe('http://160.191.47.17');

  const queueResponses: number[] = [];
  const webSocketPaths: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.request().method() === 'GET' && url.pathname === '/api/v1/kitchen/queue') {
      queueResponses.push(response.status());
    }
  });
  page.on('websocket', (socket) => {
    // pathname only: WS query contains a JWT.
    webSocketPaths.push(new URL(socket.url()).pathname);
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Mã nhân viên', { exact: true }).fill('kitchen');
  await page.getByLabel('Mã PIN', { exact: true }).fill(pin!);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(/\/kitchen$/, { timeout: 15_000 });
  await page.waitForTimeout(1_500);

  const placeholder = await page.getByRole('heading', { name: 'Màn bếp sắp có' }).isVisible();
  const diagnostic = {
    route: new URL(page.url()).pathname,
    placeholder,
    kitchenQueueGetStatuses: queueResponses,
    webSocketPaths,
  };
  await testInfo.attach('TC_EXT_017_UI_readiness', {
    body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json',
  });
  await testInfo.attach('TC_EXT_017_Kitchen_screen', {
    body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
  });
  console.log(`[Phase 1] PF-UI-017: path=${diagnostic.route}; placeholder=${placeholder}; queue GET statuses=${queueResponses.join(',') || 'none'}; WS paths=${webSocketPaths.join(',') || 'none'}`);

  if (placeholder) {
    test.skip(true, 'Kitchen UI is still a placeholder; TC_EXT_017 reconnect behavior remains Pending');
  }
  if (!queueResponses.includes(200) || !webSocketPaths.includes('/api/v1/ws')) {
    test.skip(true, 'Kitchen UI did not show both a successful Queue GET and a WebSocket; TC_EXT_017 remains Pending');
  }
  // This proves only readiness. The offline change and UI resync need their own testcase.
  console.log('[Phase 1] PF-UI-017 readiness PASS only; TC_EXT_017 business flow not executed');
});
