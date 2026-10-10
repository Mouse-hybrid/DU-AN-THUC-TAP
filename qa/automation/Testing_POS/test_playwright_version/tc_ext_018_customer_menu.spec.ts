import { test, expect } from '@playwright/test';

/** TC_EXT_018: Customer UI must GET /api/v1/menu and render a menu item.
 * Set CUSTOMER_MENU_URL to actual Customer screen URL/path; not the admin/POS screen.
 * No mutation. Intentionally does not pass on API-only behavior.
 */
test('TC_EXT_018 | customer menu UI calls GET menu and renders item', async ({ page }) => {
  const target = process.env.CUSTOMER_MENU_URL;
  test.skip(!target, 'Set CUSTOMER_MENU_URL to actual Customer Menu screen URL or path');
  let menuResponseBody: any = null;
  const matchedResponses: number[] = [];
  page.on('response', async response => {
    try {
      const u = new URL(response.url());
      if (response.request().method() !== 'GET' || u.pathname !== '/api/v1/menu') return;
      matchedResponses.push(response.status());
      if (response.status() === 200) {
        menuResponseBody = await response.json();
      }
    } catch (_) {
      // Parsing an unrelated response cannot make a test pass.
    }
  });
  await page.goto(target!, {waitUntil:'domcontentloaded'});
  await expect.poll(()=>matchedResponses.length, {timeout:10000,
    message:'Customer page must make GET /api/v1/menu'}).toBeGreaterThan(0);
  expect(matchedResponses, 'GET /api/v1/menu status').toContain(200);
  const items = Array.isArray(menuResponseBody) ? menuResponseBody :
    menuResponseBody?.items || menuResponseBody?.menu_items || menuResponseBody?.data;
  expect(Array.isArray(items), 'menu response contract').toBe(true);
  const first = items.find((x:any)=>x && typeof x.name==='string' && x.name.length);
  expect(first, 'menu response has displayable name').toBeTruthy();
  await expect(page.getByText(first.name,{exact:false}).first(),
    'Customer page must display actual menu item').toBeVisible({timeout:10000});
});
