// PF-07 checks the read-only all-ready fixture for DES05-TC-017.
// A Passed preflight does not verify Expeditor UI or perform Pickup.
describe('DES-QA-05 | TC-017 all-ready Expeditor preflight', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const note = (message) => cy.task('des05Note', message, { log: false });
  const pending = (message, context) => note(message)
    .then(() => cy.log(`${message} (video evidence pause: 3 seconds)`).wait(3000, { log: false }))
    .then(() => context.skip());
  const get = (origin, path, token) => cy.request({
    method: 'GET',
    url: origin + path,
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
    log: false,
    timeout: 20000,
  });

  it('PF-07 | all active order items are READY/DONE across at least two stations', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_USERNAME', 'EXT_REFIRE_SUPERVISOR_PASSWORD',
      'DES05_TC017_ORDER_ID',
    ]).then((e) => {
      if (!e.DES05_TC017_ORDER_ID || !e.EXT_REFIRE_SUPERVISOR_USERNAME ||
          !e.EXT_REFIRE_SUPERVISOR_PASSWORD) {
        return pending('PF-07 PENDING: isolated all-ready QA Order ID or Supervisor login missing', this);
      }
      const orderId = String(e.DES05_TC017_ORDER_ID);
      expect(orderId, 'isolated QA Order UUID').to.match(uuid);
      const origin = String(e.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');

      cy.request({
        method: 'POST',
        url: origin + '/api/v1/auth/login',
        body: {
          username: String(e.EXT_REFIRE_SUPERVISOR_USERNAME),
          password: String(e.EXT_REFIRE_SUPERVISOR_PASSWORD),
        },
        failOnStatusCode: false,
        log: false,
        timeout: 20000,
      }).then((login) => {
        expect(login.status, 'Supervisor login').eq(200);
        expect(login.body?.staff?.role, 'Supervisor role').eq('SUPERVISOR');
        const token = login.body?.access_token;
        expect(token, 'Supervisor access token').to.be.a('string').and.not.be.empty;

        return get(origin, `/api/v1/orders/${orderId}`, token).then((orderResponse) => {
          expect(orderResponse.status, 'GET isolated QA order').eq(200);
          expect(orderResponse.body?.id, 'QA order ID').eq(orderId);
          expect(orderResponse.body?.items, 'QA order items').to.be.an('array');
          const items = orderResponse.body.items.filter((item) => item.status !== 'VOIDED');
          expect(items.length, 'at least two active QA items').to.be.at.least(2);
          const itemIds = items.map((item) => item.id);
          expect(new Set(itemIds).size, 'distinct active item IDs').eq(items.length);
          for (const item of items) {
            expect(item.id, 'QA item UUID').to.match(uuid);
            expect(item.status, `item ${item.id} status`).eq('READY');
          }

          return get(origin, '/api/v1/kitchen/queue?status=DONE', token).then((doneResponse) => {
            expect(doneResponse.status, 'GET DONE queue').eq(200);
            expect(doneResponse.body, 'DONE queue entries').to.be.an('array');
            const done = doneResponse.body.filter((entry) => entry.order_id === orderId);
            expect(done.length, 'one DONE entry per active item').eq(items.length);
            for (const itemId of itemIds) {
              const entries = done.filter((entry) => entry.order_item_id === itemId);
              expect(entries.length, `DONE entries for ${itemId}`).eq(1);
              expect(entries[0].status, `queue status for ${itemId}`).eq('DONE');
              expect(entries[0].station_id, `station for ${itemId}`).to.match(uuid);
            }
            expect(new Set(done.map((entry) => entry.station_id)).size,
              'at least two distinct stations').to.be.at.least(2);

            return get(origin, '/api/v1/kitchen/queue', token).then((activeResponse) => {
              expect(activeResponse.status, 'GET active queue').eq(200);
              expect(activeResponse.body, 'active queue entries').to.be.an('array');
              expect(activeResponse.body.filter((entry) => entry.order_id === orderId),
                'no active queue entry for QA order').to.have.length(0);
              return note(`PF-07: order ${orderId}; ${items.length} READY/DONE items across ${new Set(done.map((entry) => entry.station_id)).size} stations; Expeditor UI and Pickup unverified`);
            });
          });
        });
      });
    });
  });
});
