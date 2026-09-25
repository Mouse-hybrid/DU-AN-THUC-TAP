import { test, expect } from '@playwright/test';

test('Kiểm thử luồng cơ bản có ghi video và ảnh', async ({ page }) => {
  // 1. Mở trang đích
  await page.goto('https://playwright.dev/');

  // 2. Chụp ảnh chủ động tại trang chủ
  await page.screenshot({ path: 'test-results/screenshots/01-trang-chu.png' });

  // 3. Thực hiện thao tác tương tác
  await page.getByRole('link', { name: 'Get started' }).click();

  // 4. Giữ thời lượng test tối thiểu 3s để video có độ dài chuẩn
  await page.waitForTimeout(3000);

  // 5. Kiểm tra phần tử xuất hiện
  await expect(page.getByRole('heading', { name: 'Installation' })).toBeVisible();

  // 6. Chụp ảnh kết quả cuối cùng
  await page.screenshot({ path: 'test-results/screenshots/02-ket-qua.png' });
});