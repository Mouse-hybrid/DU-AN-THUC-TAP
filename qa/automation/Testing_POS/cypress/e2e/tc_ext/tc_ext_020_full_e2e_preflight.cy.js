// Read-only preflight for TC_EXT_020. Does not create or close orders.
// Full workflow is NOT declared passed on a successful preflight.
describe('TC_EXT_020 | Full POS E2E infrastructure preflight',()=>{
 it('checks login, available table and menu fixtures without mutation',function(){
  cy.env(['POS_BASE_URL','POS_USERNAME','POS_PASSWORD']).then(e=>{
   if(!e.POS_USERNAME||!e.POS_PASSWORD){cy.log('PENDING: missing QA login credentials');this.skip();return;}
   const base=String(e.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
   const req=(method,path,headers={},body)=>cy.request({method,url:base+'/api/v1'+path,
     headers,body,failOnStatusCode:false,log:false});
   req('POST','/auth/login',{}, {username:e.POS_USERNAME,password:e.POS_PASSWORD}).then(login=>{
    expect(login.status,'QA login').eq(200);
    const token=login.body.access_token||login.body?.data?.access_token;
    expect(token,'access token').to.be.a('string').and.not.be.empty;
    const h={Authorization:'Bearer '+token};
    req('GET','/tables',h).then(t=>{
     expect(t.status,'GET tables').eq(200);
     const arr=Array.isArray(t.body)?t.body:(t.body?.items||t.body?.data||[]);
     const free=arr.filter(x=>x.status==='AVAILABLE'&&!x.current_session);
     cy.log('Available QA tables: '+free.length);
     req('GET','/menu',h).then(m=>{
      expect(m.status,'GET menu').eq(200);
      const menu=Array.isArray(m.body)?m.body:(m.body?.items||m.body?.data||[]);
      const sellable=menu.filter(x=>x.is_available===true);
      cy.log('Sellable menu items: '+sellable.length);
      if(!free.length||!sellable.length){
       cy.log('PENDING: missing isolated available table or sellable menu item');this.skip();return;
      }
      cy.log('PREFLIGHT ONLY: do not mark TC_EXT_020 PASSED; full session->order->payment->cleanup not executed');
     });
    });
   });
  });
 });
});