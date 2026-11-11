import {expect, test} from '@playwright/test';

// Sprint 4 role navigation on approved staging. Login is the only POST.
for (const role of ['waiter', 'cashier', 'kitchen', 'admin'] as const) {
  test(`PF-S4-ROLE-${role.toUpperCase()} | allowed screen and protected routes`,
    async ({page, request}, testInfo) => {
      test.setTimeout(60_000);
      const pin=process.env.S2_STAGING_PIN;
      test.skip(!pin, 'S2_STAGING_PIN required; role UI was not executed');
      const expected=process.env.POS_EXPECTED_COMMIT;
      test.skip(!expected, 'POS_EXPECTED_COMMIT required; role UI was not executed');
      const base=(process.env.BASE_URL||'http://160.191.47.17').replace(/\/+$/,'');
      expect(base).toBe('http://160.191.47.17');
      const before=await request.get(base+'/version',{timeout:20_000});
      expect(before.status()).toBe(200);
      const build=(await before.json()).commit as string;
      expect(build).toBe(expected);
      const writes:string[]=[];
      const reads:Array<{path:string;status:number}>=[];
      page.on('request',req=>{
        const path=new URL(req.url()).pathname;
        if(path.startsWith('/api/v1/')&&!['GET','HEAD'].includes(req.method())&&
           path!=='/api/v1/auth/login')writes.push(`${req.method()} ${path}`);
      });
      page.on('response',res=>{
        const path=new URL(res.url()).pathname;
        if(path.startsWith('/api/v1/')&&res.request().method()==='GET')
          reads.push({path,status:res.status()});
      });
      await page.goto('/login',{waitUntil:'domcontentloaded'});
      await page.getByLabel('Tên đăng nhập',{exact:true}).fill(role);
      await page.getByLabel('Mật khẩu',{exact:true}).fill(pin!);
      const [login]=await Promise.all([
        page.waitForResponse(res=>new URL(res.url()).pathname==='/api/v1/auth/login'&&
          res.request().method()==='POST',{timeout:20_000}),
        page.getByRole('button',{name:'Đăng nhập',exact:true}).click(),
      ]);
      expect(login.status()).toBe(200);
      const home=role==='kitchen'?'/kitchen':'/tables';
      await expect(page).toHaveURL(new RegExp(`${home}$`),{timeout:15_000});
      const allowedApi=role==='kitchen'?'/api/v1/kitchen/queue':'/api/v1/tables';
      await expect.poll(()=>reads.some(x=>x.path===allowedApi&&x.status===200),
        {timeout:15_000}).toBe(true);
      if(role==='kitchen'){
        await page.goto('/tables',{waitUntil:'domcontentloaded'});
        await expect(page).toHaveURL(/\/kitchen$/,{timeout:15_000});
      }else if(role==='admin'){
        await page.goto('/kitchen',{waitUntil:'domcontentloaded'});
        await expect(page).toHaveURL(/\/kitchen$/,{timeout:15_000});
        await expect.poll(()=>reads.some(x=>x.path==='/api/v1/kitchen/queue'&&x.status===200),
          {timeout:15_000}).toBe(true);
        await page.goto('/tables',{waitUntil:'domcontentloaded'});
        await expect(page).toHaveURL(/\/tables$/,{timeout:15_000});
      }else{
        await page.goto('/kitchen',{waitUntil:'domcontentloaded'});
        await expect(page).toHaveURL(/\/tables$/,{timeout:15_000});
        expect(reads.filter(x=>x.path==='/api/v1/kitchen/queue')).toEqual([]);
      }
      expect(writes).toEqual([]);
      const after=await request.get(base+'/version',{timeout:20_000});
      expect(after.status()).toBe(200);
      expect((await after.json()).commit).toBe(build);
      await testInfo.attach(`PF_S4_ROLE_${role}`,{
        body:JSON.stringify({role,build,home,finalPath:new URL(page.url()).pathname,
          reads,writes,scope:'login and read-only route guard; no business lifecycle'},null,2),
        contentType:'application/json',
      });
      await testInfo.attach(`PF_S4_ROLE_${role}_screen`,{
        body:await page.screenshot({fullPage:true,animations:'disabled'}),
        contentType:'image/png',
      });
    });
}
