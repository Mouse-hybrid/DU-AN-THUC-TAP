// DES05-TC-013 changes an isolated QA item from PREPARING to READY once.
// Reserve the fixture and confirm its cleanup plan before opting in.
// Audit actor and queue done_at need separate evidence because the public response omits them.
describe('DES-QA-05 | TC-013 Mark Ready on isolated QA order', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const note = (message) => cy.task('des05Note', message, { log: false });
  const pending = (message, context) => note(message)
    .then(() => cy.log(`${message} (video evidence pause: 3 seconds)`).wait(3000, { log: false }))
    .then(() => context.skip());
  const request = (origin, path, token, method = 'GET', key) => cy.request({
    method,
    url: origin + path,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    failOnStatusCode: false,
    log: false,
    timeout: 20000,
  });

  const orderItem = (origin, orderId, itemId, token, expectedStatus) =>
    request(origin, `/api/v1/orders/${orderId}`, token).then((response) => {
      expect(response.status, 'GET isolated QA order').eq(200);
      expect(response.body?.id, 'QA order ID').eq(orderId);
      expect(response.body?.items, 'QA order items').to.be.an('array');
      const item = response.body.items.find((entry) => entry.id === itemId);
      expect(item, 'exact QA order item').to.exist;
      expect(item.status, 'QA item status').eq(expectedStatus);
      return item;
    });

  const queueEntry = (origin, orderId, itemId, token, path, expectedStatus) =>
    request(origin, path, token).then((response) => {
      expect(response.status, 'GET Kitchen Queue').eq(200);
      expect(response.body, 'Kitchen Queue entries').to.be.an('array');
      const entries = response.body.filter((entry) =>
        entry.order_id === orderId && entry.order_item_id === itemId);
      expect(entries.length, 'queue entries for exact QA item').eq(1);
      expect(entries[0].status, 'QA queue status').eq(expectedStatus);
      expect(entries[0].station_id, 'QA queue station').to.match(uuid);
      return entries[0];
    });

  it('TC-013 | PREPARING to READY; queue becomes DONE', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_KITCHEN_USERNAME', 'EXT_KITCHEN_PASSWORD',
      'DES05_TC013_ORDER_ID', 'DES05_TC013_ITEM_ID',
      'DES05_TC013_IDEMPOTENCY_KEY', 'DES05_TC013_RUN',
      'DES05_TC013_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC013_RUN !== 'MARK_READY_ON_ISOLATED_ORDER' ||
          e.DES05_TC013_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-013 PENDING: isolated QA fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC013_ORDER_ID || !e.DES05_TC013_ITEM_ID ||
          !e.DES05_TC013_IDEMPOTENCY_KEY || !e.EXT_KITCHEN_USERNAME ||
          !e.EXT_KITCHEN_PASSWORD) {
        return pending('TC-013 PENDING: QA Order/Item IDs, fresh idempotency key, or Kitchen login missing', this);
      }

      const orderId = String(e.DES05_TC013_ORDER_ID);
      const itemId = String(e.DES05_TC013_ITEM_ID);
      const key = String(e.DES05_TC013_IDEMPOTENCY_KEY);
      expect(orderId, 'isolated QA Order UUID').to.match(uuid);
      expect(itemId, 'isolated QA Item UUID').to.match(uuid);
      expect(key, 'fresh Idempotency-Key UUID').to.match(uuid);
      const origin = String(e.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');

      cy.request({
        method: 'POST',
        url: origin + '/api/v1/auth/login',
        body: {
          username: String(e.EXT_KITCHEN_USERNAME),
          password: String(e.EXT_KITCHEN_PASSWORD),
        },
        failOnStatusCode: false,
        log: false,
        timeout: 20000,
      }).then((login) => {
        expect(login.status, 'Kitchen login').eq(200);
        expect(login.body?.staff?.role, 'Kitchen role').eq('KITCHEN');
        const token = login.body?.access_token;
        expect(token, 'Kitchen access token').to.be.a('string').and.not.be.empty;

        return orderItem(origin, orderId, itemId, token, 'PREPARING')
          .then(() => queueEntry(
            origin, orderId, itemId, token, '/api/v1/kitchen/queue', 'IN_PROGRESS'
          ))
          .then((before) => request(
            origin, `/api/v1/orders/${orderId}/items/${itemId}/mark-ready`,
            token, 'POST', key
          ).then((ready) => {
            expect(ready.status, 'POST Mark Ready').eq(200);
            const item = ready.body?.items?.find((entry) => entry.id === itemId);
            expect(item?.status, 'Mark Ready response item').eq('READY');

            return orderItem(origin, orderId, itemId, token, 'READY')
              .then(() => queueEntry(
                origin, orderId, itemId, token, '/api/v1/kitchen/queue?status=DONE', 'DONE'
              ))
              .then((after) => {
                expect(after.id, 'same queue entry').eq(before.id);
                expect(after.station_id, 'same station').eq(before.station_id);
                return note(`TC-013: order ${orderId}; item ${itemId}; PREPARING/IN_PROGRESS -> READY/DONE; audit actor and done_at require separate check`);
              });
          }));
      });
    });
  });
});
