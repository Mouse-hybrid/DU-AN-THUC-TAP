// TC_EXT_011 - read-only preflight. Does not attempt VOID.
// A valid authorization test requires an order item in SENT state and a CASHIER identity.
// CLOSED order fixtures cannot prove role-specific denial.
describe('TC_EXT_011 | Cashier VOID fixture preflight (read only)',()=>{
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  it('checks CASHIER QA order and SENT item availability',function(){
    cy.env(['POS_BASE_URL','EXT_011_CASHIER_TOKEN','EXT_011_ORDER_ID']).then(v=>{
      if(!v.EXT_011_CASHIER_TOKEN||!v.EXT_011_ORDER_ID){
        cy.log('PENDING: set CYPRESS_EXT_011_CASHIER_TOKEN and CYPRESS_EXT_011_ORDER_ID; do not use CLOSED order');
        this.skip();return;
      }
      expect(v.EXT_011_ORDER_ID,'QA order ID format').to.match(uuid);
      const base=String(v.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
      cy.request({method:'GET',url:base+'/api/v1/orders/'+v.EXT_011_ORDER_ID,
        headers:{Authorization:'Bearer '+v.EXT_011_CASHIER_TOKEN},failOnStatusCode:false,log:false}).then(r=>{
        expect(r.status,'cashier can read selected QA order').eq(200);
        const order=r.body?.order||r.body;
        cy.log('Order status: '+String(order.status));
        if(order.status!=='SENT'){
          cy.log('PENDING: need an isolated SENT order; actual order status = '+String(order.status));
          this.skip();return;
        }
        const items=Array.isArray(order.items)?order.items:[];
        const sent=items.filter(i=>i.status==='SENT');
        if(!sent.length){
          cy.log('PENDING: order has no SENT item for role-based void check');
          this.skip();return;
        }
        cy.log('PREFLIGHT VERIFIED: SENT order, SENT items='+sent.length);
        cy.log('VOID authorization NOT tested. Confirm endpoint and request body before active case.');
      });
    });
  });
});
