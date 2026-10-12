// PF-06 is a read-only API fixture check for DES05-TC-016.
// Passing this preflight does not prove what the Expeditor sees in the UI.
describe('DES-QA-05 | TC-016 partial-ready Expeditor preflight', () => {
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

  it('PF-06 | one READY/DONE and one pending/active item belong to separate stations', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_USERNAME', 'EXT_REFIRE_SUPERVISOR_PASSWORD',
      'DES05_TC016_ORDER_ID', 'DES05_TC016_READY_ITEM_ID', 'DES05_TC016_PENDING_ITEM_ID',
    ]).then((e) => {
      if (!e.DES05_TC016_ORDER_ID || !e.DES05_TC016_READY_ITEM_ID ||
          !e.DES05_TC016_PENDING_ITEM_ID || !e.EXT_REFIRE_SUPERVISOR_USERNAME ||
          !e.EXT_REFIRE_SUPERVISOR_PASSWORD) {
        return pending('PF-06 PENDING: isolated mixed-station QA Order/Item IDs or Supervisor login missing', this);
      }
      const orderId = String(e.DES05_TC016_ORDER_ID);
      const readyId = String(e.DES05_TC016_READY_ITEM_ID);
      const pendingId = String(e.DES05_TC016_PENDING_ITEM_ID);
      for (const [label, id] of [['Order', orderId], ['READY item', readyId], ['pending item', pendingId]]) {
        expect(id, `QA ${label} UUID`).to.match(uuid);
      }
      expect(readyId, 'two distinct QA items').not.eq(pendingId);
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
          expect(orderResponse.status, 'GET QA order').eq(200);
          expect(orderResponse.body?.id, 'QA order ID').eq(orderId);
          expect(orderResponse.body?.items, 'QA order items').to.be.an('array');
          const readyItem = orderResponse.body.items.find((item) => item.id === readyId);
          const pendingItem = orderResponse.body.items.find((item) => item.id === pendingId);
          expect(readyItem, 'exact READY item').to.exist;
          expect(pendingItem, 'exact pending item').to.exist;
          expect(readyItem.status, 'READY item status').eq('READY');
          expect(['SENT', 'PREPARING'], 'pending state candidates').to.include(pendingItem.status);
          const expectedQueueStatus = pendingItem.status === 'SENT' ? 'QUEUED' : 'IN_PROGRESS';

          return get(origin, '/api/v1/kitchen/queue?status=DONE', token)
            .then((doneResponse) => {
              expect(doneResponse.status, 'GET DONE queue').eq(200);
              expect(doneResponse.body, 'DONE queue entries').to.be.an('array');
              const done = doneResponse.body.filter((entry) =>
                entry.order_id === orderId && entry.order_item_id === readyId);
              expect(done.length, 'exact READY item DONE entry').eq(1);
              expect(done[0].status, 'READY item queue status').eq('DONE');
              expect(done[0].station_id, 'READY item station').to.match(uuid);

              return get(origin, '/api/v1/kitchen/queue', token).then((activeResponse) => {
                expect(activeResponse.status, 'GET active queue').eq(200);
                expect(activeResponse.body, 'active queue entries').to.be.an('array');
                const active = activeResponse.body.filter((entry) =>
                  entry.order_id === orderId && entry.order_item_id === pendingId);
                expect(active.length, 'exact pending item active entry').eq(1);
                expect(active[0].status, 'pending item queue status').eq(expectedQueueStatus);
                expect(active[0].station_id, 'pending item station').to.match(uuid);
                expect(active[0].station_id, 'two different stations').not.eq(done[0].station_id);
                return note(`PF-06: order ${orderId}; READY/DONE station ${done[0].station_id}; ${pendingItem.status}/${expectedQueueStatus} station ${active[0].station_id}; Expeditor UI unverified`);
              });
            });
        });
      });
    });
  });
});
