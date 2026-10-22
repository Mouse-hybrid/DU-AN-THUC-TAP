import { test, expect } from '@playwright/test';

// Anonymous route readiness only. Authenticated screen and Customer menu
// behavior have separate tests; a login redirect is not a business UI PASS.
const routes = [
  { ref: 'PF-UI-ROUTE-001', path: '/pos' },
  { ref: 'PF-UI-ROUTE-002', path: '/kitchen' },
  { ref: 'PF-UI-ROUTE-003', path: '/customer' },
  { ref: 'PF-UI-ROUTE-004', path: '/admin' },
] as const;

test.describe('POS System | anonymous route guard smoke', () => {
  for (const { ref, path } of routes) {
    test(`${ref} | ${path} redirects to login without a session`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
      await expect(page.getByRole('heading', { name: 'Chào mừng trở lại' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Mã nhân viên' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Mã PIN' })).toBeVisible();
    });
  }
});
