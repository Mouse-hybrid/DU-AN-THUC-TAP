// TC_EXT_015: Nginx WebSocket handshake without JWT must be forbidden (403).
// No credentials, mutations or test fixtures required.
describe('TC_EXT_015 | WebSocket unauthorized handshake through nginx', () => {
  it('rejects websocket Upgrade without JWT with HTTP 403 (not proxy 404)', () => {
    cy.env(['POS_BASE_URL']).then(env => {
      const base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/$/, '');
      cy.request({
        method: 'GET',
        url: base + '/api/v1/ws',
        headers: {
          'Connection': 'Upgrade',
          'Upgrade': 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
        },
        failOnStatusCode: false,
        followRedirect: false
      }).then(response => {
        expect(response.status, 'WebSocket unauthorized handshake HTTP').to.equal(403);
        expect(response.status, 'nginx must route to backend (not 404)').not.to.equal(404);
      });
    });
  });
});
