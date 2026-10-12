// DES05-TC-023 attempts Refire on one SENT item, which is not refirable.
// Guarded because a regression could mutate the dedicated staging QA item.
describe('DES-QA-05 | TC-023 Refire invalid item state on isolated QA order', () => {
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
  const orderSnapshot = (response, orderId, itemId, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body?.id, `${label} order ID`).eq(orderId);
    expect(response.body?.items, `${label} items`).to.be.an('array');
    const items = response.body.items.filter((item) => item.id === itemId);
    expect(items, `${label} target item`).to.have.length(1);
    return {
      itemStatus: items[0].status,
      version: response.body.current_version,
      itemCount: response.body.items.length,
    };
  };
  const queueSnapshot = (origin, token, orderId, itemId) => {
    const entries = [];
    const statuses = ['QUEUED', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
    return cy.wrap(statuses, { log: false }).each((status) =>
      request(origin, `/api/v1/kitchen/queue?status=${status}`, token).then((response) => {
        expect(response.status, `GET ${status} queue`).eq(200);
        expect(response.body, `${status} queue`).to.be.an('array');
        entries.push(...response.body
          .filter((entry) => entry.order_id === orderId && entry.order_item_id === itemId)
          .map((entry) => ({ id: entry.id, status: entry.status, station_id: entry.station_id })));
      })
    ).then(() => entries.sort((a, b) => a.id.localeCompare(b.id)));
  };

  it('TC-023 | SENT item Refire returns 409 without changing order or queue', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_USERNAME', 'EXT_REFIRE_SUPERVISOR_PASSWORD',
      'DES05_TC023_ORDER_ID', 'DES05_TC023_ITEM_ID', 'DES05_TC023_IDEMPOTENCY_KEY',
      'DES05_TC023_RUN', 'DES05_TC023_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC023_RUN !== 'TRY_REFIRE_ON_ISOLATED_SENT_ITEM' ||
          e.DES05_TC023_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-023 PENDING: isolated SENT fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC023_ORDER_ID || !e.DES05_TC023_ITEM_ID ||
          !e.DES05_TC023_IDEMPOTENCY_KEY || !e.EXT_REFIRE_SUPERVISOR_USERNAME ||
          !e.EXT_REFIRE_SUPERVISOR_PASSWORD) {
        return pending('TC-023 PENDING: QA Order/Item IDs, fresh key, or Supervisor login missing', this);
      }

      const orderId = String(e.DES05_TC023_ORDER_ID);
      const itemId = String(e.DES05_TC023_ITEM_ID);
      const key = String(e.DES05_TC023_IDEMPOTENCY_KEY);
      expect(orderId, 'isolated QA Order UUID').to.match(uuid);
      expect(itemId, 'isolated QA Item UUID').to.match(uuid);
      expect(key, 'fresh Idempotency-Key UUID').to.match(uuid);
      const origin = String(e.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      const orderPath = `/api/v1/orders/${orderId}`;

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
        expect(login.body?.staff?.role, 'Refire role').eq('SUPERVISOR');
        const token = login.body?.access_token;
        expect(token, 'Supervisor access token').to.be.a('string').and.not.be.empty;

        return request(origin, orderPath, token).then((before) => {
          const original = orderSnapshot(before, orderId, itemId, 'GET before invalid Refire');
          expect(original.itemStatus, 'invalid fixture state').eq('SENT');
          expect(original.version, 'order version before').to.be.a('number');
          return queueSnapshot(origin, token, orderId, itemId).then((beforeQueue) => {
            expect(beforeQueue, 'one queued ticket for SENT item').to.have.length(1);
            expect(beforeQueue[0].status, 'original ticket status').eq('QUEUED');

            return request(origin, `${orderPath}/items/${itemId}/refire`, token, 'POST', key)
              .then((rejected) => {
                expect(rejected.status, 'invalid item state HTTP').eq(409);
                expect(String(rejected.body?.detail), 'conflict identifies SENT').to.include('SENT');
                return request(origin, orderPath, token);
              }).then((after) => {
                expect(orderSnapshot(after, orderId, itemId, 'GET after rejected Refire'),
                  'item status, version and item count unchanged').to.deep.eq(original);
                return queueSnapshot(origin, token, orderId, itemId);
              }).then((afterQueue) => {
                expect(afterQueue, 'no duplicate or changed ticket').to.deep.eq(beforeQueue);
                return note(`TC-023: order ${orderId}; item ${itemId}; SENT Refire rejected 409; version ${original.version} and queue unchanged`);
              });
          });
        });
      });
    });
  });
});
