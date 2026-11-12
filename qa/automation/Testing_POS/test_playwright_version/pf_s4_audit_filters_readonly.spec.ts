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
  const auditResponses:import('@playwright/test').Response[]=[];
  page.on('response',res=>{
    try {
      if(res.request().method()==='GET'&&new URL(res.url()).pathname==='/api/v1/audit-logs')
        auditResponses.push(res);
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
  await expect(page.getByText('Tổng thao tác',{exact:true})).toBeVisible({timeout:15_000});
  const observations:Array<{range:string;status:number;createdFrom:string|null;
    filterKeys:string[];rows:number|null;visibleTotal:string;responsesSeen:number;allCreatedFrom:Array<string|null>;selectedClass:string}>=[];
  for(const range of ['Hôm nay','30 ngày','7 ngày']){
    const startIndex=auditResponses.length;
    const [first]=await Promise.all([
      page.waitForResponse(res=>{
        try {
          return res.request().method()==='GET'&&new URL(res.url()).pathname==='/api/v1/audit-logs';
        } catch { return false; }
      },{timeout:15_000}),
      page.getByText(range,{exact:true}).click(),
    ]);
    await first.finished();
    await page.waitForLoadState('networkidle',{timeout:15_000});
    const responses=auditResponses.slice(startIndex);
    expect(responses.length,`${range}: audit GET after click`).toBeGreaterThan(0);
    const response=responses.at(-1)!;
    expect(response.status(),`${range}: latest audit GET`).toBe(200);
    const body=await response.json();
    const rows=Array.isArray(body)?body.length:Array.isArray(body?.items)?body.items.length:null;
    const query=new URL(response.url()).searchParams;
    const filterKeys=[...query.keys()];
    expect(filterKeys,`${range}: time query`).toContain('created_from');
    const card=page.getByText('Tổng thao tác',{exact:true}).locator('..');
    await expect(card).toBeVisible();
    const selectedClass=await page.getByText(range,{exact:true}).evaluate(el=>
      `${el.getAttribute('class')||''} | parent:${el.parentElement?.getAttribute('class')||''}`);
    observations.push({range,status:response.status(),createdFrom:query.get('created_from'),
      filterKeys,rows,visibleTotal:await card.innerText(),responsesSeen:responses.length,
      allCreatedFrom:responses.map(res=>new URL(res.url()).searchParams.get('created_from')),
      selectedClass});
  }
  console.log('PF_S4_AUDIT_FILTERS_DIAGNOSTICS='+JSON.stringify(observations));
  const byRange=Object.fromEntries(observations.map(x=>[x.range,x.createdFrom]));
  expect(Date.parse(byRange['Hôm nay']!), 'Today must start later than 7 days').toBeGreaterThan(Date.parse(byRange['7 ngày']!));
  expect(Date.parse(byRange['7 ngày']!), '7 days must start later than 30 days').toBeGreaterThan(Date.parse(byRange['30 ngày']!));
  expect(writes).toEqual([]);
  const after=await request.get(base+'/version',{timeout:20_000});
  expect(after.status()).toBe(200);
  expect((await after.json()).commit).toBe(build);
  await testInfo.attach('PF_S4_AUDIT_filters_readonly',{
    body:JSON.stringify({build,observations,writes,
      scope:'UI time filters and audit GET only; totals observed, export and immutability not tested'},null,2),
    contentType:'application/json',
  });
  await testInfo.attach('PF_S4_AUDIT_filters_screen',{
    body:await page.screenshot({fullPage:true,animations:'disabled'}),contentType:'image/png',
  });
});
