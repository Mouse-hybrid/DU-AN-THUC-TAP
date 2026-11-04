import { test, expect } from '@playwright/test';

// Anonymous route readiness only. Authenticated screen and Customer menu
// behavior have separate tests; a login redirect is not a business UI PASS.
const routes = [
  { ref: 'PF-UI-ROUTE-001', path: '/pos', heading: 'Chào mừng trở lại' },
  { ref: 'PF-UI-ROUTE-002', path: '/kitchen', heading: 'Sẵn sàng cho ca bếp' },
  { ref: 'PF-UI-ROUTE-003', path: '/customer', heading: 'Chào mừng trở lại' },
  { ref: 'PF-UI-ROUTE-004', path: '/admin', heading: 'Chào mừng trở lại' },
] as const;

test.describe('POS System | anonymous route guard smoke', () => {
  for (const { ref, path, heading } of routes) {
    test(`${ref} | ${path} redirects to login without a session`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Mã nhân viên' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Mã PIN' })).toBeVisible();
    });
  }
});
