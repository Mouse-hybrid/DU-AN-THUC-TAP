import { test, expect, type Response } from '@playwright/test';

test.describe('POS System - FE Menu Integration Smoke', () => {
  test.skip(!process.env.CUSTOMER_MENU_URL,
    'Chưa có URL màn Customer Menu thật; /customer hiện là route bảo vệ đăng nhập');

  test('TC-FE-MENU-001 - Customer FE gọi GET /api/v1/menu', async ({ page }) => {
    const customerMenuUrl = process.env.CUSTOMER_MENU_URL;
    test.setTimeout(30_000);

    const menuResponses: Response[] = [];
    page.on('response', response => {
      if (response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/menu') {
        menuResponses.push(response);
      }
    });

    const navigation = await page.goto(customerMenuUrl!, { waitUntil: 'domcontentloaded' });
    expect(navigation?.ok(), 'Customer Menu document response').toBeTruthy();
    expect(new URL(page.url()).pathname, 'Customer Menu URL must not redirect to login').not.toBe('/login');

    await expect.poll(() => menuResponses.length, {
      timeout: 12_000,
      message: 'Customer Menu page must call GET /api/v1/menu',
    }).toBeGreaterThan(0);
    const response = menuResponses.find(candidate => candidate.status() === 200);
    expect(response, `GET /api/v1/menu statuses: ${menuResponses.map(candidate => candidate.status()).join(', ')}`)
      .toBeTruthy();

    const body = await response!.json();
    const items = Array.isArray(body) ? body : body?.items ?? body?.menu_items ?? body?.data;
    expect(Array.isArray(items), 'menu response must contain items').toBe(true);
    const firstItem = items.find((item: unknown) =>
      typeof item === 'object' && item !== null &&
      'name' in item && typeof item.name === 'string' && item.name.length > 0);
    expect(firstItem, 'menu response must have a displayable item').toBeTruthy();
    await expect(page.getByText(firstItem.name, { exact: false }).first()).toBeVisible();
  });
});
