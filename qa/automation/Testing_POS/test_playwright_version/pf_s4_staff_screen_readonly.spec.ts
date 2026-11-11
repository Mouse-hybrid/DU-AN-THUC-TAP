import {expect, test} from '@playwright/test';

test('PF-S4-STAFF-READONLY | supervisor opens staff screen', async ({page, request}, testInfo) => {
  test.setTimeout(60_000);
  const pin=process.env.S2_STAGING_PIN;
  const expected=process.env.POS_EXPECTED_COMMIT;
  test.skip(!pin||!expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
  const base=(process.env.BASE_URL||'http://160.191.47.17').replace(/\/+$/,'');
  expect(base).toBe('http://160.191.47.17');
  const before=await request.get(base+'/version',{timeout:20_000});
  expect(before.status()).toBe(200);
  const build=(await before.json()).commit as string;
  expect(build).toBe(expected);

  const reads:Array<{path:string;status:number}>=[];
  const writes:string[]=[];
  page.on('response',res=>{
    const path=new URL(res.url()).pathname;
    if(res.request().method()==='GET'&&path.startsWith('/api/v1/'))
      reads.push({path,status:res.status()});
  });
  page.on('request',req=>{
    const path=new URL(req.url()).pathname;
    if(path.startsWith('/api/v1/')&&!['GET','HEAD'].includes(req.method())&&
       path!=='/api/v1/auth/login')writes.push(`${req.method()} ${path}`);
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
  await page.goto('/admin/staff',{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(/\/admin\/staff$/,{timeout:15_000});
  await expect(page.getByRole('heading',{name:'Quản trị nhân viên'})).toBeVisible();
  await expect.poll(()=>reads.some(x=>x.path==='/api/v1/staff'&&x.status===200),
    {timeout:15_000}).toBe(true);
  // These controls render visibly, but their HTML role varies across UI builds.
  // This smoke checks visible labels; accessibility semantics need a separate test.
  for(const label of ['Làm mới','Xuất danh sách','Thêm nhân viên'])
    await expect(page.getByText(label,{exact:true})).toBeVisible();
  expect(writes).toEqual([]);
  const after=await request.get(base+'/version',{timeout:20_000});
  expect(after.status()).toBe(200);
  expect((await after.json()).commit).toBe(build);
  await testInfo.attach('PF_S4_STAFF_readiness',{
    body:JSON.stringify({build,role:'admin',path:new URL(page.url()).pathname,
      staff_get_200:true,control_labels_visible:true,writes,
      scope:'read-only staff screen; control roles, usability and responsive layout not asserted'},null,2),
    contentType:'application/json',
  });
  await testInfo.attach('PF_S4_STAFF_mobile_screen',{
    body:await page.screenshot({fullPage:true,animations:'disabled'}),
    contentType:'image/png',
  });
});
