import { test, expect } from '@playwright/test';

test.describe('POS System - FE Menu Integration Smoke', () => {

  test('TC-FE-MENU-001 - Customer FE gọi GET /api/v1/menu', async ({ page }) => {

    const menuResponse = page.waitForResponse(
      response =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/menu',
      { timeout: 10_000 }
    );

    await page.goto('/customer', {
      waitUntil: 'domcontentloaded',
    });

    const response = await menuResponse;

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body).toBeTruthy();

    await expect(
      page.getByRole('heading', { name: 'Customer menu' })
    ).toBeVisible();

    await page.screenshot({
      path: 'test-results/menu-integration-smoke.png',
      fullPage: true,
    });
  });

});