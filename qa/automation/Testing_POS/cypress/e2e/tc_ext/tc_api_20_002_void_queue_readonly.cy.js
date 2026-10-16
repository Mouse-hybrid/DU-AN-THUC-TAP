// Phase 1 TC_API_20_002: inspect a previously voided QA item without
// creating any new staging orders or tickets. Item VOIDED corresponds to
// a cancelled ticket in the current API state model.
describe('Phase 1 | TC_API_20_002 voided item and active Kitchen Queue', () => {
  const base = 'http://160.191.47.17';
  const note = (message) => cy.task('des05Note', `[Phase 1] ${message}`, { log: false });
  const get = (path, token) => cy.request({
    method: 'GET', url: base + path, failOnStatusCode: false, log: false,
    timeout: 20000, headers: { Authorization: `Bearer ${token}` },
  });

  it('TC_API_20_002 | VOIDED item is absent from the active queue', function () {
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD',
      'PHASE1_VOID_ORDER_ID', 'PHASE1_VOID_ITEM_ID'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD || !env.PHASE1_VOID_ORDER_ID || !env.PHASE1_VOID_ITEM_ID) {
        return note('TC_API_20_002 PENDING: local PIN or historical own fixture IDs missing')
          .then(() => this.skip());
      }
      const orderId = String(env.PHASE1_VOID_ORDER_ID);
      const itemId = String(env.PHASE1_VOID_ITEM_ID);
      const password = String(env.DES05_SEED_PASSWORD);
      return cy.request({
        method: 'POST', url: base + '/api/v1/auth/login',
        body: { username: 'kitchen', password }, log: false,
        failOnStatusCode: false, timeout: 20000,
      }).then((login) => {
        expect(login.status, 'Kitchen login').eq(200);
        const token = login.body?.access_token;
        expect(token, 'Kitchen JWT').to.be.a('string').and.not.be.empty;
        return get(`/api/v1/orders/${orderId}`, token).then((order) => {
          if (order.status === 404) {
            return note(`TC_API_20_002 PENDING: own historical order ${orderId} no longer exists; no mutation`)
              .then(() => this.skip());
          }
          expect(order.status, 'historical own order GET').eq(200);
          const item = order.body?.items?.find((entry) => entry.id === itemId);
          expect(item, 'own historical item exists').to.exist;
          expect(item.status, 'API cancellation state is VOIDED').eq('VOIDED');
          return get('/api/v1/kitchen/queue', token).then((queue) => {
            expect(queue.status, 'active Kitchen Queue GET').eq(200);
            const active = queue.body.filter((entry) =>
              entry.order_id === orderId && entry.order_item_id === itemId);
            return get('/api/v1/kitchen/queue?status=CANCELLED', token)
              .then((cancelled) => {
                expect(cancelled.status, 'CANCELLED Kitchen Queue GET').eq(200);
                const historical = cancelled.body.filter((entry) =>
                  entry.order_id === orderId && entry.order_item_id === itemId);
                return note(`TC_API_20_002 observed: order ${orderId}; item ${itemId} VOIDED; active tickets ${active.length} [${active.map((entry) => `${entry.id}:${entry.status}`).join(',') || 'none'}]; CANCELLED tickets ${historical.length}; read-only`)
                  .then(() => {
                    expect(active, 'VOIDED item absent from active Kitchen Queue')
                      .to.have.length(0);
                    return note('TC_API_20_002 assertions OK: no active queue entry for VOIDED item; no mutation');
                  });
              });
          });
        });
      });
    });
  });
});
