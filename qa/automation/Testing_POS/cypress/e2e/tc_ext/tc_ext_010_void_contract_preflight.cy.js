// TC_EXT_010: contract discovery only; never performs a VOID mutation.
describe('TC_EXT_010 | Supervisor VOID contract preflight',()=>{
 it('discovers void operation and checks QA order fixture safely',function(){
  cy.env(['POS_BASE_URL','EXT_010_ORDER_ID','EXT_010_SUPERVISOR_TOKEN']).then(e=>{
   const base=String(e.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
   cy.request({url:base+'/openapi.json',failOnStatusCode:false,log:false}).then(r=>{
    expect(r.status,'staging OpenAPI').eq(200);
    const operations=Object.entries(r.body.paths||{}).flatMap(([path,methods])=>
      Object.entries(methods).filter(([method])=>['post','patch','put','delete'].includes(method)).map(([method,op])=>({path,method,operationId:op.operationId||''})));
    const voidOps=operations.filter(x=>/void/i.test(x.path+' '+x.operationId));
    cy.log('VOID operations discovered: '+voidOps.map(x=>x.method.toUpperCase()+' '+x.path).join('; ').slice(0,400));
    if(!voidOps.length){cy.log('BLOCKED: no VOID operation exposed by OpenAPI');this.skip();return;}
    if(!e.EXT_010_ORDER_ID||!e.EXT_010_SUPERVISOR_TOKEN){cy.log('PENDING: QA SENT order and supervisor JWT required');this.skip();return;}
    cy.request({method:'GET',url:base+'/api/v1/orders/'+encodeURIComponent(e.EXT_010_ORDER_ID),
     headers:{Authorization:'Bearer '+e.EXT_010_SUPERVISOR_TOKEN},failOnStatusCode:false,log:false}).then(order=>{
      expect(order.status,'supervisor can inspect fixture').eq(200);
      const body=order.body.order||order.body;
      if(body.status!=='SENT'||!(body.items||[]).some(x=>x.status==='SENT')){
       cy.log('BLOCKED: fixture must be SENT order with SENT item');this.skip();return;
      }
      cy.log('VOID contract and fixture discovered. Actual VOID, version increment and audit remain NOT TESTED.');
    });
   });
  });
 });
});