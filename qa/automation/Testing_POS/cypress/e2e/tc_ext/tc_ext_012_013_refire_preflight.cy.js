// Read-only preflight for TC_EXT_012 and TC_EXT_013.
// Intentionally does NOT call refire endpoint until method/schema/cleanup are verified.
describe('TC_EXT_012/013 | Refire fixture preflight (no mutation)',()=>{
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 const get=(base,id,token)=>cy.request({method:'GET',url:base+'/api/v1/orders/'+id,
   headers:{Authorization:'Bearer '+token},failOnStatusCode:false,log:false});
 ['012','013'].forEach(testId=>{
  it('TC_EXT_'+testId+' | confirms isolated SERVED item fixture',function(){
   cy.env(['POS_BASE_URL','EXT_REFIRE_SUPERVISOR_TOKEN','EXT_REFIRE_ORDER_ID']).then(e=>{
    if(!e.EXT_REFIRE_SUPERVISOR_TOKEN||!e.EXT_REFIRE_ORDER_ID){
     cy.log('PENDING: need confirmed QA supervisor JWT and QA order ID');this.skip();return;
    }
    expect(e.EXT_REFIRE_ORDER_ID,'order UUID').to.match(uuid);
    const base=String(e.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
    get(base,e.EXT_REFIRE_ORDER_ID,e.EXT_REFIRE_SUPERVISOR_TOKEN).then(r=>{
     expect(r.status,'authorized order read').eq(200);
     const order=r.body?.order||r.body;
     const served=(Array.isArray(order.items)?order.items:[]).filter(x=>x.status==='SERVED');
     if(!served.length){cy.log('PENDING: no SERVED order item; order status '+String(order.status));this.skip();return;}
     cy.log('PREFLIGHT: '+served.length+' SERVED items available; subtotal '+String(order.subtotal)+'; version '+String(order.current_version));
     cy.log('NOT A REFIRE PASS: need validated endpoint, payload, idempotency and isolation/cleanup');
    });
   });
  });
 });
});