// DES05-TC-015 attempts Start Cooking on one already SERVED isolated QA item.
// The expected HTTP 409 must leave the item and its queue entries unchanged.
// Opt in only after reserving the fixture and confirming its cleanup plan.
describe('DES-QA-05 | TC-015 backward transition on isolated QA order', () => {
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

  const servedItem = (origin, orderId, itemId, token) =>
    request(origin, `/api/v1/orders/${orderId}`, token).then((response) => {
      expect(response.status, 'GET isolated QA order').eq(200);
      expect(response.body?.id, 'QA order ID').eq(orderId);
      expect(response.body?.items, 'QA order items').to.be.an('array');
      const item = response.body.items.find((entry) => entry.id === itemId);
      expect(item, 'exact QA order item').to.exist;
      expect(item.status, 'QA item remains SERVED').eq('SERVED');
      return item;
    });

  const queueSnapshot = (origin, orderId, itemId, token) => {
    const entries = [];
    const statuses = ['QUEUED', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
    return cy.wrap(statuses, { log: false }).each((status) =>
      request(origin, `/api/v1/kitchen/queue?status=${status}`, token)
        .then((response) => {
          expect(response.status, `GET queue ${status}`).eq(200);
          expect(response.body, `queue ${status} entries`).to.be.an('array');
          entries.push(...response.body
            .filter((entry) => entry.order_id === orderId && entry.order_item_id === itemId)
            .map((entry) => ({ id: entry.id, status: entry.status, station_id: entry.station_id })));
        })
    ).then(() => entries.sort((a, b) => a.id.localeCompare(b.id)));
  };

  it('TC-015 | Start Cooking from SERVED returns 409 with no new queue entry', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_KITCHEN_USERNAME', 'EXT_KITCHEN_PASSWORD',
      'DES05_TC015_ORDER_ID', 'DES05_TC015_ITEM_ID',
      'DES05_TC015_IDEMPOTENCY_KEY', 'DES05_TC015_RUN',
      'DES05_TC015_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC015_RUN !== 'TRY_START_COOKING_ON_SERVED_QA_ITEM' ||
          e.DES05_TC015_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-015 PENDING: isolated SERVED fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC015_ORDER_ID || !e.DES05_TC015_ITEM_ID ||
          !e.DES05_TC015_IDEMPOTENCY_KEY || !e.EXT_KITCHEN_USERNAME ||
          !e.EXT_KITCHEN_PASSWORD) {
        return pending('TC-015 PENDING: QA Order/Item IDs, fresh idempotency key, or Kitchen login missing', this);
      }

      const orderId = String(e.DES05_TC015_ORDER_ID);
      const itemId = String(e.DES05_TC015_ITEM_ID);
      const key = String(e.DES05_TC015_IDEMPOTENCY_KEY);
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

        return servedItem(origin, orderId, itemId, token)
          .then(() => queueSnapshot(origin, orderId, itemId, token))
          .then((before) => request(
            origin, `/api/v1/orders/${orderId}/items/${itemId}/start-cooking`,
            token, 'POST', key
          ).then((rejected) => {
            expect(rejected.status, 'backward transition HTTP status').eq(409);
            expect(String(rejected.body?.detail), 'state conflict detail').to.include('SERVED');
            return servedItem(origin, orderId, itemId, token)
              .then(() => queueSnapshot(origin, orderId, itemId, token))
              .then((after) => {
                expect(after, 'no added or altered QA queue entry').to.deep.eq(before);
                return note(`TC-015: order ${orderId}; item ${itemId}; SERVED -> Start Cooking rejected 409; item and queue snapshot unchanged`);
              });
          }));
      });
    });
  });
});
