# Tự động hóa luồng demo Pha 1 bằng Playwright (UI)

Tài liệu cho QA viết test giao diện (E2E) chạy trọn luồng demo Pha 1 trên staging: mở bàn → gọi món
→ bếp nấu → phục vụ → thanh toán → dọn bàn, với 3 vai chạy song song. Mọi selector dưới đây lấy đúng
từ code giao diện trên `main` (commit `e4cf695`), ưu tiên tìm theo vai trò và tên truy cập
(`getByRole` / `getByLabel`), vì giao diện chưa có `data-testid`.

## 1. Môi trường

| Mục | Giá trị |
|---|---|
| URL | `http://160.191.47.17` (staging, HTTP) |
| Phiên bản đang chạy | `GET /version` → kiểm tra `short_commit` trước khi chạy |
| Tài khoản | `waiter` (phục vụ), `kitchen` (bếp), `cashier` (thu ngân), `admin` (giám sát, dự phòng) |
| Mật khẩu | **Không ghi vào code/repo.** Đọc từ biến môi trường, vd `POS_PASSWORD` (secret trên CI) |
| Bàn dùng cho luồng | **B1** (phải đang Trống) |

Biến môi trường gợi ý:

```bash
BASE_URL=http://160.191.47.17
POS_PASSWORD=<lấy từ BE, lưu ở secret>
```

## 2. Chuẩn bị dữ liệu

1. Không chạy song song với buổi demo hoặc người khác đang thao tác trên B1.
2. Muốn dữ liệu sạch: GitHub → Actions → **Reset staging data** (bật `with_fixtures`, `purge_extra_menu`,
   tắt `dry_run`). **Báo nhóm trước**; nên chạy **Backup staging DB** trước khi reset.
3. Sau reset: B1–B4 trống; B5 có món ở bếp (SLA), B6 có đơn đã phục vụ; menu đúng 8 món mẫu.
4. **Không tạo/sửa món trên chi nhánh demo.** Test có ghi dữ liệu (tạo món, chạy trọn luồng nhiều
   lần) dùng chi nhánh QA 3 (`qa3_admin`, `qa3_cashier`, `qa3_waiter`, `qa3_kitchen`, bàn Q3-1..Q3-3).
   Chi nhánh QA 2 cố ý không có menu, chỉ dùng cho test cách ly.

Menu mẫu (seed) dùng trong test:

| Nhóm | Món | Trạm |
|---|---|---|
| Món khai vị | Gỏi cuốn, Chả giò | Bếp chính |
| Món chính | Phở bò, Bún chả, Cơm tấm sườn | Bếp chính |
| Đồ uống | Trà đá, Cà phê sữa đá, Nước cam | Quầy bar |

## 3. Quy tắc quan trọng khi viết test

- **Mỗi vai một `browser.newContext()`.** Giao diện lưu đăng nhập ở `localStorage` key `pos_auth` theo
  origin: hai vai trong cùng một context sẽ đè đăng nhập của nhau.
- **Màn bên kia cập nhật qua WebSocket** (thường dưới 1 giây). Nếu WebSocket rớt, giao diện tự tải lại
  5 giây/lần (màn bếp, chi tiết bàn). Dùng `expect(...).toBeVisible({ timeout: 10_000 })`, **không dùng
  `waitForTimeout`**. Sơ đồ bàn chỉ có WebSocket (không polling): nếu chậm, bấm nút **Làm mới**.
- **Mọi thao tác ghi đều có `Idempotency-Key`** do giao diện tự sinh; test không cần làm gì thêm.
- **Ghi chú món chỉ lưu khi bấm "Cập nhật"**, và chỉ sửa được trước khi gửi bếp.
- **Đăng nhập xong giao diện tự chuyển trang:** `kitchen` → `/kitchen`, các vai khác → `/tables`.

## 4. Bảng selector theo màn

### Đăng nhập (`/login`)

| Phần tử | Selector |
|---|---|
| Mã nhân viên | `page.getByLabel('Mã nhân viên')` |
| Mã PIN (mật khẩu) | `page.getByLabel('Mã PIN', { exact: true })` |
| Nút đăng nhập | `page.getByRole('button', { name: 'Đăng nhập', exact: true })` |

### Sơ đồ bàn (`/tables`)

| Phần tử | Selector |
|---|---|
| Thẻ bàn (tên kèm trạng thái) | `page.getByRole('button', { name: 'Bàn B1, Trống' })` |
| Lọc trạng thái | `page.getByLabel('Trạng thái')` (select: `ALL`, `AVAILABLE`, `OCCUPIED`, `BILLING`, `CLEANING`…) |
| Làm mới | `page.getByRole('button', { name: 'Làm mới' })` |
| Dọn xong (khi bàn Đang dọn) | `page.getByRole('button', { name: 'Dọn xong bàn B1' })` |

Nhãn trạng thái bàn: `Trống` (AVAILABLE), `Đang phục vụ` (OCCUPIED), `Chờ thanh toán` (BILLING),
`Đang dọn` (CLEANING). Bấm bàn Trống → `/tables/:id/open`; bàn khác → `/tables/:id`.

### Mở bàn (`/tables/:id/open`)

| Phần tử | Selector |
|---|---|
| Số khách | `page.getByLabel('Số khách')` (hoặc nút `Tăng số khách` / `Giảm số khách`) |
| Mở bàn | `page.getByRole('button', { name: 'Mở bàn', exact: true })` |

Mở bàn thành công → quay về `/tables`, thẻ đổi thành `Bàn B1, Đang phục vụ`.

### Chi tiết bàn (`/tables/:id`)

| Phần tử | Selector |
|---|---|
| Gọi món | `page.getByRole('link', { name: 'Gọi món cho bàn B1' })` |
| Tóm tắt đơn | `page.getByRole('link', { name: 'Tóm tắt đơn bàn B1' })` |
| Lấy món (món Sẵn sàng) | `page.getByRole('button', { name: 'Lấy món Phở bò' })` |
| Đã mang ra (món Đã lấy) | `page.getByRole('button', { name: 'Đã mang ra Phở bò' })` |
| Làm mới | `page.getByRole('button', { name: 'Làm mới chi tiết bàn' })` |

### Gọi món (`/tables/:id/order`)

| Phần tử | Selector |
|---|---|
| Tab nhóm món | `page.getByRole('tab', { name: 'Tất cả' })`, `'Món chính'`, `'Đồ uống'`… |
| Thêm món | `page.getByRole('button', { name: 'Thêm Phở bò vào đơn' })` |
| Dòng món trong đơn | `page.locator('article.nova-order-line', { hasText: 'Phở bò' })` |
| Ghi chú của dòng | `line.getByPlaceholder('Ví dụ: ít cay')` |
| Lưu ghi chú/số lượng | `page.getByRole('button', { name: 'Cập nhật Phở bò' })` |
| Xóa món (trước khi gửi) | `page.getByRole('button', { name: 'Xóa Phở bò khỏi đơn' })` |
| Gửi bếp | `page.getByRole('button', { name: 'Gửi các món mới xuống bếp' })` |
| Thông báo | `page.getByText('Đã gửi món xuống bếp.')` |

Đơn được tạo khi thêm món đầu tiên. Nút Gửi bếp chỉ hiện khi có món chưa gửi.

### Màn bếp (`/kitchen`)

| Phần tử | Selector |
|---|---|
| Tab | `page.getByRole('tab', { name: 'Món mới' })`, `'Đang chế biến'`, `'Sẵn sàng'` |
| Lọc trạm | `page.getByLabel('Trạm bếp')` |
| Bắt đầu nấu | `page.getByRole('button', { name: 'Bắt đầu nấu Phở bò bàn B1' })` |
| Món xong | `page.getByRole('button', { name: 'Món xong Phở bò bàn B1' })` |
| Phiếu bếp | `page.locator('article.nova-kds-ticket', { hasText: 'Bàn B1' })` |

Badge trễ trên phiếu đang nấu: `Đúng tiến độ` (< 8 phút), `Sắp trễ` (8–12), `Trễ` (12–15),
`Rất trễ` (≥ 15). Phiếu có `Ghi chú: …` hoặc `Không có ghi chú`.

### Tóm tắt đơn (`/tables/:id/summary`)

| Phần tử | Selector |
|---|---|
| Yêu cầu thanh toán | `page.getByRole('button', { name: 'Yêu cầu thanh toán đơn' })` |
| Xác nhận trong hộp thoại | `page.getByRole('button', { name: 'Yêu cầu thanh toán', exact: true })` |
| Thanh toán (chỉ thu ngân/giám sát) | `page.getByRole('button', { name: 'Xác nhận đơn đã thanh toán' })` |
| Xác nhận trong hộp thoại | `page.getByRole('button', { name: 'Xác nhận đã thanh toán', exact: true })` |
| Hủy hộp thoại | `page.getByRole('button', { name: 'Hủy thao tác' })` |
| Thông báo | `page.getByText('Đã thanh toán.')` |

## 5. Kịch bản và điểm kiểm tra

| # | Vai | Thao tác | Kiểm tra |
|---|---|---|---|
| 1 | waiter | Đăng nhập | URL `/tables`; thấy `Bàn B1, Trống` |
| 2 | waiter | Bấm B1 → Số khách = 2 → Mở bàn | Về `/tables`; thấy `Bàn B1, Đang phục vụ` |
| 3 | waiter | Bấm B1 → Gọi món → thêm Phở bò, Trà đá → ghi chú Phở bò "ít hành" → Cập nhật | 2 dòng món trong đơn; ô ghi chú Phở bò giữ `ít hành`, nút Cập nhật chuyển về mờ (đã lưu) |
| 4 | waiter | Gửi bếp | Thông báo `Đã gửi món xuống bếp.` |
| 5 | kitchen | Tab Món mới | Phiếu `Bàn B1` có Phở bò, `Ghi chú: ít hành` (≤ 10 giây) |
| 6 | kitchen | Bắt đầu nấu Phở bò → tab Đang chế biến → Món xong | Phiếu sang tab Sẵn sàng |
| 7 | waiter | Chi tiết B1 | Thấy nút `Lấy món Phở bò` (≤ 10 giây) → bấm → `Đã mang ra Phở bò` → bấm |
| 8 | kitchen | Làm Trà đá tương tự bước 6 | Quầy bar; phiếu sang Sẵn sàng |
| 9 | waiter | Lấy món, Đã mang ra Trà đá | Hai món ở trạng thái `Đã phục vụ` |
| 10 | waiter | Tóm tắt đơn → Yêu cầu thanh toán → xác nhận | **Không** thấy nút `Xác nhận đơn đã thanh toán`; sơ đồ bàn: `Bàn B1, Chờ thanh toán` |
| 11 | cashier | Đăng nhập → B1 → Tóm tắt đơn → Xác nhận đơn đã thanh toán → xác nhận | Thông báo `Đã thanh toán.` |
| 12 | waiter | Sơ đồ bàn | `Bàn B1, Đang dọn` → Dọn xong bàn B1 → `Bàn B1, Trống` |

Kiểm tra phân quyền nên có thêm:

- `kitchen` đăng nhập → URL `/kitchen`; không có nút Thêm món / Gửi bếp.
- `waiter` ở Tóm tắt đơn không thấy nút thanh toán (bước 10).
- `cashier` không thấy nút `Dọn xong bàn` (chỉ phục vụ/giám sát).

## 6. Mẫu spec (TypeScript)

```ts
import { test, expect, type Browser, type Page } from '@playwright/test';

const PASSWORD = process.env.POS_PASSWORD ?? '';
const TABLE = 'B1';

async function loginAs(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext(); // mỗi vai một context riêng
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Mã nhân viên').fill(username);
  await page.getByLabel('Mã PIN', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(username === 'kitchen' ? /\/kitchen$/ : /\/tables$/);
  return page;
}

async function cookAndReady(kitchen: Page, dish: string) {
  await kitchen.getByRole('tab', { name: 'Món mới' }).click();
  await kitchen.getByRole('button', { name: `Bắt đầu nấu ${dish} bàn ${TABLE}` }).click({ timeout: 10_000 });
  await kitchen.getByRole('tab', { name: 'Đang chế biến' }).click();
  await kitchen.getByRole('button', { name: `Món xong ${dish} bàn ${TABLE}` }).click({ timeout: 10_000 });
}

async function pickupAndServe(waiter: Page, dish: string) {
  await waiter.getByRole('button', { name: `Lấy món ${dish}` }).click({ timeout: 10_000 });
  await waiter.getByRole('button', { name: `Đã mang ra ${dish}` }).click({ timeout: 10_000 });
}

test.describe.serial('Luồng demo Pha 1 trên bàn B1', () => {
  test.skip(!PASSWORD, 'Thiếu POS_PASSWORD');

  test('mở bàn → gọi món → bếp → phục vụ → thanh toán → dọn bàn', async ({ browser }) => {
    test.setTimeout(180_000);
    const waiter = await loginAs(browser, 'waiter');
    const kitchen = await loginAs(browser, 'kitchen');

    // 1–2. Mở bàn
    await waiter.getByRole('button', { name: `Bàn ${TABLE}, Trống` }).click();
    await waiter.getByLabel('Số khách').fill('2');
    await waiter.getByRole('button', { name: 'Mở bàn', exact: true }).click();
    await expect(waiter.getByRole('button', { name: `Bàn ${TABLE}, Đang phục vụ` })).toBeVisible();

    // 3. Gọi món + ghi chú
    await waiter.getByRole('button', { name: `Bàn ${TABLE}, Đang phục vụ` }).click();
    await waiter.waitForURL(/\/tables\/[^/]+$/);
    const tableUrl = waiter.url(); // dùng lại cho các bước sau
    await waiter.getByRole('link', { name: `Gọi món cho bàn ${TABLE}` }).click();
    await waiter.getByRole('button', { name: 'Thêm Phở bò vào đơn' }).click();
    await waiter.getByRole('button', { name: 'Thêm Trà đá vào đơn' }).click();
    const pho = waiter.locator('article.nova-order-line', { hasText: 'Phở bò' });
    await pho.getByPlaceholder('Ví dụ: ít cay').fill('ít hành');
    await waiter.getByRole('button', { name: 'Cập nhật Phở bò' }).click();
    // Trước khi gửi bếp, ghi chú nằm trong ô nhập (chưa hiện dạng chữ "Ghi chú: …")
    await expect(pho.getByPlaceholder('Ví dụ: ít cay')).toHaveValue('ít hành');
    await expect(waiter.getByRole('button', { name: 'Cập nhật Phở bò' })).toBeDisabled();

    // 4–5. Gửi bếp, bếp thấy món kèm ghi chú
    await waiter.getByRole('button', { name: 'Gửi các món mới xuống bếp' }).click();
    await expect(waiter.getByText('Đã gửi món xuống bếp.')).toBeVisible();
    const ticket = kitchen.locator('article.nova-kds-ticket', { hasText: `Bàn ${TABLE}` }).filter({ hasText: 'Phở bò' });
    await expect(ticket).toBeVisible({ timeout: 10_000 });
    await expect(ticket.getByText('ít hành')).toBeVisible();

    // 6–9. Bếp nấu, phục vụ lấy và mang ra
    await waiter.goto(tableUrl);
    await cookAndReady(kitchen, 'Phở bò');
    await pickupAndServe(waiter, 'Phở bò');
    await cookAndReady(kitchen, 'Trà đá');
    await pickupAndServe(waiter, 'Trà đá');

    // 10. Yêu cầu thanh toán; phục vụ không được thu tiền
    await waiter.getByRole('link', { name: `Tóm tắt đơn bàn ${TABLE}` }).click();
    await waiter.getByRole('button', { name: 'Yêu cầu thanh toán đơn' }).click();
    await waiter.getByRole('button', { name: 'Yêu cầu thanh toán', exact: true }).click();
    await expect(waiter.getByRole('button', { name: 'Xác nhận đơn đã thanh toán' })).toHaveCount(0);

    // 11. Thu ngân thanh toán
    const cashier = await loginAs(browser, 'cashier');
    await cashier.goto(tableUrl);
    await cashier.getByRole('link', { name: `Tóm tắt đơn bàn ${TABLE}` }).click();
    await cashier.getByRole('button', { name: 'Xác nhận đơn đã thanh toán' }).click();
    await cashier.getByRole('button', { name: 'Xác nhận đã thanh toán', exact: true }).click();
    await expect(cashier.getByText('Đã thanh toán.')).toBeVisible();

    // 12. Dọn bàn
    await waiter.goto('/tables');
    await waiter.getByRole('button', { name: `Dọn xong bàn ${TABLE}` }).click({ timeout: 10_000 });
    await expect(waiter.getByRole('button', { name: `Bàn ${TABLE}, Trống` })).toBeVisible();
  });
});
```

`playwright.config.ts` tối thiểu:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    baseURL: process.env.BASE_URL ?? 'http://160.191.47.17',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  expect: { timeout: 10_000 },
  retries: 0, // luồng ghi dữ liệu thật: không tự chạy lại, tránh mở bàn 2 lần
});
```

## 7. Lỗi hay gặp

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Bước 2 không thấy `Bàn B1, Trống` | B1 đang có phiên từ lần chạy trước → Reset staging data, hoặc chọn bàn trống khác |
| Hai vai bị đăng xuất lẫn nhau | Dùng chung một context → tạo `browser.newContext()` cho mỗi vai |
| Màn bên kia không đổi | WebSocket rớt → đợi polling 5 giây (timeout 10 giây), hoặc bấm Làm mới |
| Ghi chú không lên bếp | Chưa bấm `Cập nhật` trước khi Gửi bếp |
| 409 / thông báo dữ liệu đã thay đổi | Có người thao tác cùng bàn → chạy lại sau khi Reset |
| `Thêm … vào đơn` không thấy | Menu không phải 8 món mẫu → Reset với `purge_extra_menu` |

## 8. Gợi ý tiếp theo

- Thêm `data-testid` cho các phần tử chính (thẻ bàn, phiếu bếp, dòng món) để selector bền hơn khi đổi
  chữ: cần FE (Thiện) thêm.
- Cho test UI chạy trên CI sau mỗi lần deploy staging (cần BE/DevOps thêm job, secret `POS_PASSWORD`).
- Nhánh QA đang có `TC-FE-MENU-001` chờ màn menu cho khách (không có trong Release 1): nên `skip` để bộ
  test không đỏ thường trực.
