// DES05-TC-012 changes an isolated QA item from SENT to PREPARING once.
// The operator must reserve the fixture and confirm its cleanup plan before opting in.
// Public API checks cannot verify the audit-log actor; that requires separate evidence.
describe('DES-QA-05 | TC-012 Start Cooking on isolated QA order', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const note = (message) => cy.task('des05Note', message, { log: false });
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

  const snapshot = (origin, orderId, itemId, token, expectedItem, expectedQueue) =>
    request(origin, `/api/v1/orders/${orderId}`, token).then((orderResponse) => {
      expect(orderResponse.status, 'GET isolated QA order').eq(200);
      const order = orderResponse.body;
      expect(order?.id, 'QA order ID').eq(orderId);
      expect(order?.items, 'QA order items').to.be.an('array');
      const item = order.items.find((entry) => entry.id === itemId);
      expect(item, 'exact QA order item').to.exist;
      expect(item.status, 'QA item status').eq(expectedItem);

      return request(origin, '/api/v1/kitchen/queue', token).then((queueResponse) => {
        expect(queueResponse.status, 'GET Kitchen Queue').eq(200);
        expect(queueResponse.body, 'Kitchen Queue').to.be.an('array');
        const entries = queueResponse.body.filter((entry) =>
          entry.order_id === orderId && entry.order_item_id === itemId);
        expect(entries.length, 'queue entries for exact QA item').eq(1);
        expect(entries[0].status, 'QA queue status').eq(expectedQueue);
        expect(entries[0].station_id, 'QA queue station').to.match(uuid);
        return { order, item, queue: entries[0] };
      });
    });

  it('TC-012 | SENT to PREPARING; queue becomes IN_PROGRESS', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_KITCHEN_USERNAME', 'EXT_KITCHEN_PASSWORD',
      'DES05_TC012_ORDER_ID', 'DES05_TC012_ITEM_ID',
      'DES05_TC012_IDEMPOTENCY_KEY', 'DES05_TC012_RUN',
      'DES05_TC012_CLEANUP_CONFIRMED',
    ]).then((environment) => {
      const e = environment;
      if (e.DES05_TC012_RUN !== 'START_COOKING_ON_ISOLATED_ORDER' ||
          e.DES05_TC012_CLEANUP_CONFIRMED !== 'YES') {
        return note('TC-012 PENDING: isolated QA fixture and cleanup plan must be explicitly approved locally')
          .then(() => this.skip());
      }
      if (!e.DES05_TC012_ORDER_ID || !e.DES05_TC012_ITEM_ID ||
          !e.DES05_TC012_IDEMPOTENCY_KEY || !e.EXT_KITCHEN_USERNAME ||
          !e.EXT_KITCHEN_PASSWORD) {
        return note('TC-012 PENDING: QA Order/Item IDs, fresh idempotency key, or Kitchen login missing')
          .then(() => this.skip());
      }

      const orderId = String(e.DES05_TC012_ORDER_ID);
      const itemId = String(e.DES05_TC012_ITEM_ID);
      const key = String(e.DES05_TC012_IDEMPOTENCY_KEY);
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

        return snapshot(origin, orderId, itemId, token, 'SENT', 'QUEUED')
          .then((before) => request(
            origin, `/api/v1/orders/${orderId}/items/${itemId}/start-cooking`,
            token, 'POST', key
          ).then((started) => {
            expect(started.status, 'POST Start Cooking').eq(200);
            const resultItem = started.body?.items?.find((item) => item.id === itemId);
            expect(resultItem?.status, 'Start Cooking response item').eq('PREPARING');

            return snapshot(origin, orderId, itemId, token, 'PREPARING', 'IN_PROGRESS')
              .then((after) => {
                expect(after.queue.id, 'same queue entry').eq(before.queue.id);
                expect(after.queue.station_id, 'same station').eq(before.queue.station_id);
                expect(after.queue.started_at, 'queue started_at').to.be.a('string');
                expect(Number.isFinite(Date.parse(after.queue.started_at)), 'valid started_at').eq(true);
                note(`TC-012: order ${orderId}; item ${itemId}; SENT/QUEUED -> PREPARING/IN_PROGRESS; audit actor requires separate check`);
              });
          }));
      });
    });
  });
});
