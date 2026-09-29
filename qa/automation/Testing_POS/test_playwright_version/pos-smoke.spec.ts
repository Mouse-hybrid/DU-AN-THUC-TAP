import { test, expect } from '@playwright/test';

test.describe('POS System - Render Test', () => {

  test('TC-E2E-001 - POS screen hiển thị', async ({ page }) => {
    await page.goto('/pos');

    await expect(
      page.getByRole('heading', { name: 'Staff POS' })
    ).toBeVisible();

    await page.screenshot({
      path: 'test-results/pos-screen.png',
      fullPage: true,
    });
  });

  test('TC-E2E-002 - Kitchen screen hiển thị', async ({ page }) => {
    await page.goto('/kitchen');

    await expect(
      page.getByRole('heading', { name: 'Kitchen queue' })
    ).toBeVisible();

    await page.screenshot({
      path: 'test-results/kitchen-screen.png',
      fullPage: true,
    });
  });

  test('TC-E2E-003 - Customer screen hiển thị', async ({ page }) => {
    await page.goto('/customer');

    await expect(
      page.getByRole('heading', { name: 'Customer menu' })
    ).toBeVisible();

    await page.screenshot({
      path: 'test-results/customer-screen.png',
      fullPage: true,
    });
  });

  test('TC-E2E-004 - Admin screen hiển thị', async ({ page }) => {
    await page.goto('/admin');

    await expect(
      page.getByRole('heading', { name: 'Tổng quan vận hành' })
    ).toBeVisible();

    await page.screenshot({
      path: 'test-results/admin-screen.png',
      fullPage: true,
    });
  });

});