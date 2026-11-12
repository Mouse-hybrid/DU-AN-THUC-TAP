import {expect, test} from '@playwright/test';

test('PF-S4-AUDIT-READONLY | supervisor opens audit screen', async ({page, request}, testInfo) => {
  test.setTimeout(60_000);
  const pin=process.env.S2_STAGING_PIN;
  const expected=process.env.POS_EXPECTED_COMMIT;
  test.skip(!pin||!expected, 'S2_STAGING_PIN and POS_EXPECTED_COMMIT required');
  const base=(process.env.BASE_URL||'http://160.191.47.17').replace(/\/+$/,'');
  expect(base).toBe('http://160.191.47.17');
  const before=await request.get(base+'/version',{timeout:20_000});
  expect(before.status()).toBe(200);
  const build=(await before.json()).commit as string;
  test.skip(build!==expected, `PENDING_BUILD: expected ${expected}, staging ${build}; UI not opened`);

  const reads:Array<{path:string;status:number}>=[];
  const auditResponses:Array<{status:number;rows:number|null;filterKeys:string[]}>=[];
  const writes:string[]=[];
  page.on('response',res=>{
    try {
      const path=new URL(res.url()).pathname;
      if(res.request().method()==='GET'&&path.startsWith('/api/v1/'))
        reads.push({path,status:res.status()});
      if(res.request().method()==='GET'&&path==='/api/v1/audit-logs') {
        const filterKeys=[...new URL(res.url()).searchParams.keys()];
        void res.json().then(body=>auditResponses.push({status:res.status(),
          rows:Array.isArray(body)?body.length:Array.isArray(body?.items)?body.items.length:null,
          filterKeys})).catch(()=>auditResponses.push({status:res.status(),rows:null,filterKeys}));
      }
    } catch { /* unrelated response */ }
  });
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
  await expect(page.getByRole('heading').first()).toBeVisible({timeout:15_000});
  await expect.poll(()=>reads.some(x=>x.path==='/api/v1/audit-logs'&&x.status===200),
    {timeout:15_000,message:'Audit screen must load GET /api/v1/audit-logs'}).toBe(true);
  await expect.poll(()=>auditResponses.length,{timeout:5000}).toBeGreaterThan(0);
  const totalCard=page.getByText('Tổng thao tác',{exact:true}).locator('..');
  const visibleTotal=await totalCard.innerText().catch(()=>null);
  const diagnostics={auditResponses,visibleTotal};
  console.log('PF_S4_AUDIT_DIAGNOSTICS='+JSON.stringify(diagnostics));
  expect(writes).toEqual([]);
  const after=await request.get(base+'/version',{timeout:20_000});
  expect(after.status()).toBe(200);
  expect((await after.json()).commit).toBe(build);
  await testInfo.attach('PF_S4_AUDIT_readonly',{
    body:JSON.stringify({build,role:'SUPERVISOR',path:new URL(page.url()).pathname,
      reads,writes,diagnostics,scope:'read-only audit UI; count is observation only; export/immutability/system-error trace not tested'},null,2),
    contentType:'application/json',
  });
  await testInfo.attach('PF_S4_AUDIT_screen',{
    body:await page.screenshot({fullPage:true,animations:'disabled'}),contentType:'image/png',
  });
});
