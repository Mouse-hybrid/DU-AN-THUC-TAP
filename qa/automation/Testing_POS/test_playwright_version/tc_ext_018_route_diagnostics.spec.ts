import { test, expect } from '@playwright/test';

// Read-only route diagnostics for TC_EXT_018. Does not assert Customer UI exists.
// Avoid recording credentials, tokens, request headers, or response bodies.
test('TC_EXT_018 | diagnose configured Customer route', async ({ page }, testInfo) => {
  const target=process.env.CUSTOMER_MENU_URL;
  test.skip(!target, 'Set CUSTOMER_MENU_URL to a suspected customer route');
  const seen: Array<{method:string;path:string;status:number}> = [];
  page.on('response', response => {
    try {
      const u=new URL(response.url());
      const path=u.pathname; // avoid query values which might contain tokens
      if (seen.length < 100) seen.push({method:response.request().method(),path,status:response.status()});
    } catch (_) { /* ignore non-HTTP URLs */ }
  });
  const response=await page.goto(target!, {waitUntil:'domcontentloaded',timeout:15000});
  await page.waitForTimeout(2000);
  const report={
    requested_url: new URL(target!).origin + new URL(target!).pathname,
    response_status:response?.status()??null,
    final_path:new URL(page.url()).pathname,
    page_title:await page.title(),
    menu_get_observed:seen.some(x=>x.method==='GET'&&x.path==='/api/v1/menu'),
    recorded_responses:seen
  };
  await testInfo.attach('customer-route-diagnostics', {
    body:JSON.stringify(report,null,2),contentType:'application/json'
  });
  console.log('TC_EXT_018_DIAGNOSTICS='+JSON.stringify(report));
  expect(response,'Customer route should return a document response').not.toBeNull();
});
