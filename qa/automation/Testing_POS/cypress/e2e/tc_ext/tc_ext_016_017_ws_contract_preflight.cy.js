// TC_EXT_016/017 - WebSocket handshake and contract preflight only.
// No fabricated realtime events and no synthetic reconnect PASS.
describe('TC_EXT_016/017 | WebSocket live/reconnect preflight',()=>{
 ['016','017'].forEach(id=>{
  it('TC_EXT_'+id+' | discovers WS route and verifies no-JWT boundary',function(){
   cy.env(['POS_BASE_URL','EXT_WS_JWT']).then(e=>{
    const base=String(e.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
    cy.request({url:base+'/openapi.json',failOnStatusCode:false,log:false}).then(schema=>{
     expect(schema.status,'OpenAPI').eq(200);
     const candidates=Object.keys(schema.body.paths||{}).filter(p=>/ws|websocket/i.test(p));
     cy.log('OpenAPI WS references: '+candidates.join(', ').slice(0,350));
     cy.request({method:'GET',url:base+'/api/v1/ws',headers:{
      'Connection':'Upgrade','Upgrade':'websocket','Sec-WebSocket-Version':'13',
      'Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='
     },failOnStatusCode:false,followRedirect:false,log:false}).then(r=>{
      expect(r.status,'unauthorized WS handshake').eq(403);
      if(!e.EXT_WS_JWT){cy.log('PENDING: authorized WS JWT absent; actual realtime/reconnect untested');this.skip();return;}
      cy.log('JWT configured; authenticated WebSocket message protocol/event fixture not verified.');
      this.skip(); // Never count an unauthorized handshake as EXT016/017 acceptance.
     });
    });
   });
  });
 });
});