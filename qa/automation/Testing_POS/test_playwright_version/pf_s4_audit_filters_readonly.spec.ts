import {expect, test} from '@playwright/test';

test('PF-S4-AUDIT-FILTERS | supervisor switches audit time ranges', async ({page, request}, testInfo) => {
  test.setTimeout(75_000);
  const pin=process.env.S2_STAGING_PIN;
  const expected=process.env.POS_EXPECTED_COMMIT;
  test.skip(!pin||!expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
  const base=(process.env.BASE_URL||'http://160.191.47.17').replace(/\/+$/,'');
  expect(base).toBe('http://160.191.47.17');
  const before=await request.get(base+'/version',{timeout:20_000});
  expect(before.status()).toBe(200);
  const build=(await before.json()).commit as string;
  test.skip(build!==expected, `PENDING_BUILD: expected ${expected}, staging ${build}; UI not opened`);

  const writes:string[]=[];
  page.on('request',req=>{
    try {
      const path=new URL(req.url()).pathname;
      if(path.startsWith('/api/v1/')&&!['GET','HEAD'].includes(req.method())&&
         path!=='/api/v1/auth/login')writes.push(`${req.method()} ${path}`);
    } catch { /* unrelated request */ }
  });
  await page.goto('/login',{waitUntil:'domcontentloaded'});
  await page.getByLabel('Tên đăng nhập',{exact:true}).fill('admin');
  await page.getByLabel('Mật khẩu',{exact:true}).fill(pin!);
  const [login]=await Promise.all([
    page.waitForResponse(res=>new URL(res.url()).pathname==='/api/v1/auth/login'&&
      res.request().method()==='POST',{timeout:20_000}),
    page.getByRole('button',{name:'Đăng nhập',exact:true}).click(),
  ]);
  expect(login.status()).toBe(200);
  await expect(page).toHaveURL(/\/tables$/,{timeout:15_000});
  await page.goto('/admin/audit-logs',{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(/\/admin\/audit-logs$/,{timeout:15_000});
  await expect(page.getByText('Tổng thao tác',{exact:true})).toBeVisible({timeout:15_000});
  const observations:Array<{range:string;status:number;filterKeys:string[];rows:number|null;visibleTotal:string}>=[];
  for(const range of ['Hôm nay','30 ngày','7 ngày']){
    const [response]=await Promise.all([
      page.waitForResponse(res=>{
        try {
          return res.request().method()==='GET'&&new URL(res.url()).pathname==='/api/v1/audit-logs';
        } catch { return false; }
      },{timeout:15_000}),
      page.getByText(range,{exact:true}).click(),
    ]);
    expect(response.status(),`${range}: audit GET`).toBe(200);
    const body=await response.json();
    const rows=Array.isArray(body)?body.length:Array.isArray(body?.items)?body.items.length:null;
    const filterKeys=[...new URL(response.url()).searchParams.keys()];
    expect(filterKeys,`${range}: time query`).toContain('created_from');
    const card=page.getByText('Tổng thao tác',{exact:true}).locator('..');
    await expect(card).toBeVisible();
    observations.push({range,status:response.status(),filterKeys,rows,
      visibleTotal:await card.innerText()});
  }
  expect(writes).toEqual([]);
  const after=await request.get(base+'/version',{timeout:20_000});
  expect(after.status()).toBe(200);
  expect((await after.json()).commit).toBe(build);
  console.log('PF_S4_AUDIT_FILTERS_DIAGNOSTICS='+JSON.stringify(observations));
  await testInfo.attach('PF_S4_AUDIT_filters_readonly',{
    body:JSON.stringify({build,observations,writes,
      scope:'UI time filters and audit GET only; totals observed, export and immutability not tested'},null,2),
    contentType:'application/json',
  });
  await testInfo.attach('PF_S4_AUDIT_filters_screen',{
    body:await page.screenshot({fullPage:true,animations:'disabled'}),contentType:'image/png',
  });
});
