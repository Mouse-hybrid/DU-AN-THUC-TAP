import {expect, test} from '@playwright/test';

test('PF-S4-ROLES-READONLY | supervisor opens permissions screen', async ({page, request}, testInfo) => {
  test.setTimeout(60_000);
  const pin=process.env.S2_STAGING_PIN;
  const expected=process.env.POS_EXPECTED_COMMIT;
  test.skip(!pin||!expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
  const base=(process.env.BASE_URL||'http://160.191.47.17').replace(/\/+$/,'');
  expect(base).toBe('http://160.191.47.17');

  const before=await request.get(base+'/version',{timeout:20_000});
  expect(before.status()).toBe(200);
  const build=(await before.json()).commit as string;
  test.skip(build!==expected, `PENDING_BUILD: expected ${expected}, staging ${build}`);
  const reads:Array<{path:string;status:number}>=[];
  const writes:string[]=[];
  page.on('response',response=>{
    const path=new URL(response.url()).pathname;
    if(response.request().method()==='GET'&&path.startsWith('/api/v1/'))
      reads.push({path,status:response.status()});
  });
  page.on('request',request=>{
    const path=new URL(request.url()).pathname;
    if(path.startsWith('/api/v1/')&&!['GET','HEAD'].includes(request.method())&&
       path!=='/api/v1/auth/login')writes.push(`${request.method()} ${path}`);
  });

  await page.goto('/login',{waitUntil:'domcontentloaded'});
  await page.getByLabel('Tên đăng nhập',{exact:true}).fill('admin');
  await page.getByLabel('Mật khẩu',{exact:true}).fill(pin!);
  const [login]=await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/auth/login'&&
      response.request().method()==='POST',{timeout:20_000}),
    page.getByRole('button',{name:'Đăng nhập',exact:true}).click(),
  ]);
  expect(login.status()).toBe(200);
  await expect(page).toHaveURL(/\/tables$/,{timeout:15_000});

  await page.goto('/admin/roles',{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(/\/admin\/roles$/,{timeout:15_000});
  await expect(page.getByRole('heading').first()).toBeVisible({timeout:15_000});
  await expect.poll(()=>reads.some(row=>row.path==='/api/v1/staff/permissions'&&row.status===200),
    {timeout:15_000,message:'Permissions screen must load GET /api/v1/staff/permissions'}).toBe(true);
  expect(writes).toEqual([]);
  const after=await request.get(base+'/version',{timeout:20_000});
  expect(after.status()).toBe(200);
  expect((await after.json()).commit).toBe(build);

  await testInfo.attach('PF_S4_ROLES_readonly',{
    body:JSON.stringify({build,path:new URL(page.url()).pathname,reads,writes,
      scope:'Supervisor roles screen read-only; permission edits and action-level policy not tested'},null,2),
    contentType:'application/json',
  });
  await testInfo.attach('PF_S4_ROLES_screen',{
    body:await page.screenshot({fullPage:true,animations:'disabled'}),contentType:'image/png',
  });
});

test('PF-S4-ROLES-CASHIER-GUARD | cashier cannot open permissions screen',
  async ({page, request}, testInfo) => {
    test.setTimeout(60_000);
    const pin=process.env.S2_STAGING_PIN;
    const expected=process.env.POS_EXPECTED_COMMIT;
    test.skip(!pin||!expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
    const base=(process.env.BASE_URL||'http://160.191.47.17').replace(/\/+$/,'');
    expect(base).toBe('http://160.191.47.17');
    const before=await request.get(base+'/version',{timeout:20_000});
    expect(before.status()).toBe(200);
    const build=(await before.json()).commit as string;
    test.skip(build!==expected, `PENDING_BUILD: expected ${expected}, staging ${build}`);
    const permissionReads:Array<{status:number;path:string}>=[];
    const writes:string[]=[];
    page.on('response',response=>{
      const path=new URL(response.url()).pathname;
      if(path==='/api/v1/staff/permissions'&&response.request().method()==='GET')
        permissionReads.push({status:response.status(),path});
    });
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(path.startsWith('/api/v1/')&&!['GET','HEAD'].includes(req.method())&&
         path!=='/api/v1/auth/login')writes.push(`${req.method()} ${path}`);
    });
    await page.goto('/login',{waitUntil:'domcontentloaded'});
    await page.getByLabel('Tên đăng nhập',{exact:true}).fill('cashier');
    await page.getByLabel('Mật khẩu',{exact:true}).fill(pin!);
    const [login]=await Promise.all([
      page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/auth/login'&&
        response.request().method()==='POST',{timeout:20_000}),
      page.getByRole('button',{name:'Đăng nhập',exact:true}).click(),
    ]);
    expect(login.status()).toBe(200);
    await expect(page).toHaveURL(/\/tables$/,{timeout:15_000});
    await page.goto('/admin/roles',{waitUntil:'domcontentloaded'});
    await expect(page).toHaveURL(/\/tables$/,{timeout:15_000});
    expect(permissionReads.some(row=>row.status===200)).toBe(false);
    expect(writes).toEqual([]);
    const after=await request.get(base+'/version',{timeout:20_000});
    expect(after.status()).toBe(200);
    expect((await after.json()).commit).toBe(build);
    await testInfo.attach('PF_S4_ROLES_cashier_guard',{
      body:JSON.stringify({build,attemptedPath:'/admin/roles',finalPath:new URL(page.url()).pathname,
        permissionReads,writes,scope:'UI route guard only; action-level API RBAC tested separately'},null,2),
      contentType:'application/json',
    });
    await testInfo.attach('PF_S4_ROLES_cashier_screen',{
      body:await page.screenshot({fullPage:true,animations:'disabled'}),contentType:'image/png',
    });
  });
