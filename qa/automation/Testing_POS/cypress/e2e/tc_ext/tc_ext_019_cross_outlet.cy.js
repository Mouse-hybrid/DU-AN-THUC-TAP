// TC_EXT_019 | cross-outlet resource access; read-only, no mutations.
// Requirements: token for outlet A, an order ID that belongs to outlet B.
// Never copy credentials into evidence. Do not substitute same-outlet IDs.
describe('TC_EXT_019 | cross-outlet order isolation',()=>{
  it('denies outlet A token access to outlet B order without data disclosure',function(){
    cy.env(['POS_BASE_URL','EXT_OUTLET_A_TOKEN','EXT_OUTLET_B_ORDER_ID']).then(v=>{
      if(!v.EXT_OUTLET_A_TOKEN||!v.EXT_OUTLET_B_ORDER_ID){
        cy.log('BLOCKED: set outlet A token and confirmed outlet B order ID');
        this.skip();
        return;
      }
      const base=String(v.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
      cy.request({
        method:'GET',
        url:base+'/api/v1/orders/'+encodeURIComponent(String(v.EXT_OUTLET_B_ORDER_ID)),
        headers:{Authorization:'Bearer '+v.EXT_OUTLET_A_TOKEN},
        failOnStatusCode:false,
        log:false
      }).then(r=>{
        expect(r.status,'cross-outlet order should be concealed').eq(404);
        // Do not assert exact error wording: only the isolation boundary matters.
        const body=JSON.stringify(r.body||{});
        expect(body,'other outlet order must not be returned').not.to.include(String(v.EXT_OUTLET_B_ORDER_ID));
      });
    });
  });
});
