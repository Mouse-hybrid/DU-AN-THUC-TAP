import {expect, test} from '@playwright/test';

// PR #37 access/readiness on staging. No ticket or order mutation.
for (const role of ['kitchen', 'waiter', 'cashier', 'admin'] as const) {
  test(`S2-UI-PF-02 | ${role} route guard`, async ({page}, testInfo) => {
    test.setTimeout(40_000);
    const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    expect(base, 'approved staging').toBe('http://160.191.47.17');
    const pin = process.env.S2_STAGING_PIN;
    test.skip(!pin, 'Local staging PIN required');

    const mutations: string[] = [];
    const gets: Array<{path: string; status: number}> = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/') && request.method() !== 'GET' &&
          path !== '/api/v1/auth/login') mutations.push(`${request.method()} ${path}`);
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/v1/') && response.request().method() === 'GET') {
        gets.push({path, status: response.status()});
      }
    });

    await page.goto('/login', {waitUntil: 'domcontentloaded'});
    await page.getByLabel('Mã nhân viên', {exact: true}).fill(role);
    await page.getByLabel('Mã PIN', {exact: true}).fill(pin!);
    await page.getByRole('button', {name: 'Đăng nhập', exact: true}).click();
    const home = role === 'kitchen' ? '/kitchen' : '/tables';
    await expect(page).toHaveURL(new RegExp(`${home}$`), {timeout: 15_000});
    await expect.poll(() => gets.some(get =>
      get.path === (role === 'kitchen' ? '/api/v1/kitchen/queue' : '/api/v1/tables')
      && get.status === 200), {timeout: 10_000}).toBe(true);

    if (role === 'kitchen') {
      await expect(page.getByRole('tab', {name: 'Món mới'})).toBeVisible();
      await page.goto('/tables', {waitUntil: 'domcontentloaded'});
      await expect(page).toHaveURL(/\/kitchen$/, {timeout: 10_000});
    } else if (role === 'admin') {
      await page.goto('/kitchen', {waitUntil: 'domcontentloaded'});
      await expect(page).toHaveURL(/\/kitchen$/, {timeout: 10_000});
      await expect(page.getByRole('tab', {name: 'Món mới'})).toBeVisible();
      await expect.poll(() => gets.some(get =>
        get.path === '/api/v1/kitchen/queue' && get.status === 200), {timeout: 10_000}).toBe(true);
      await page.goto('/tables', {waitUntil: 'domcontentloaded'});
      await expect(page).toHaveURL(/\/tables$/, {timeout: 10_000});
    } else {
      await page.goto('/kitchen', {waitUntil: 'domcontentloaded'});
      await expect(page).toHaveURL(/\/tables$/, {timeout: 10_000});
    }

    expect(mutations, `${role}: no business mutation`).toEqual([]);
    if (role === 'waiter' || role === 'cashier') {
      expect(gets.filter(get => get.path === '/api/v1/kitchen/queue'),
        `${role}: protected Kitchen page did not load the queue`).toEqual([]);
    }
    await testInfo.attach(`S2_UI_PF_02_${role}`, {
      body: JSON.stringify({role, finalPath: new URL(page.url()).pathname, gets, mutations,
        scope: 'route and read-only API readiness; no business lifecycle'}, null, 2),
      contentType: 'application/json',
    });
    console.log(`[S2-UI] PF-02 PASS ${role}: route guard and allowed GET; no business mutation`);
  });
}
