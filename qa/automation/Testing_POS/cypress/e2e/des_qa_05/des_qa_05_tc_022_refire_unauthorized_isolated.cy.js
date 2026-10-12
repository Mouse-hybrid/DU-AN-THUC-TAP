// DES05-TC-022 attempts Refire as KITCHEN, a role excluded by the Refire contract.
// Guarded because an RBAC regression could mutate the dedicated staging QA item.
describe('DES-QA-05 | TC-022 unauthorized Refire on isolated QA order', () => {
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
  const matchingTickets = (response, orderId, itemId, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body, label).to.be.an('array');
    return response.body.filter((ticket) =>
      ticket.order_id === orderId && ticket.order_item_id === itemId)
      .map((ticket) => ({ id: ticket.id, status: ticket.status, station_id: ticket.station_id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  };
  const orderSnapshot = (response, orderId, itemId, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body?.id, `${label} order ID`).eq(orderId);
    expect(response.body?.items, `${label} order items`).to.be.an('array');
    const matching = response.body.items.filter((item) => item.id === itemId);
    expect(matching, `${label} exact item`).to.have.length(1);
    return {
      itemStatus: matching[0].status,
      version: response.body.current_version,
      itemCount: response.body.items.length,
    };
  };

  it('TC-022 | Kitchen Refire is 403; item, version and queue remain unchanged', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_KITCHEN_USERNAME', 'EXT_KITCHEN_PASSWORD',
      'DES05_TC022_ORDER_ID', 'DES05_TC022_ITEM_ID', 'DES05_TC022_IDEMPOTENCY_KEY',
      'DES05_TC022_RUN', 'DES05_TC022_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC022_RUN !== 'TRY_UNAUTHORIZED_REFIRE_ON_ISOLATED_ITEM' ||
          e.DES05_TC022_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-022 PENDING: isolated SERVED fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC022_ORDER_ID || !e.DES05_TC022_ITEM_ID ||
          !e.DES05_TC022_IDEMPOTENCY_KEY || !e.EXT_KITCHEN_USERNAME ||
          !e.EXT_KITCHEN_PASSWORD) {
        return pending('TC-022 PENDING: QA Order/Item IDs, fresh key, or Kitchen login missing', this);
      }

      const orderId = String(e.DES05_TC022_ORDER_ID);
      const itemId = String(e.DES05_TC022_ITEM_ID);
      const key = String(e.DES05_TC022_IDEMPOTENCY_KEY);
      expect(orderId, 'isolated QA Order UUID').to.match(uuid);
      expect(itemId, 'isolated QA Item UUID').to.match(uuid);
      expect(key, 'fresh Idempotency-Key UUID').to.match(uuid);
      const origin = String(e.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      const orderPath = `/api/v1/orders/${orderId}`;

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
        expect(login.body?.staff?.role, 'non-Refire role').eq('KITCHEN');
        const token = login.body?.access_token;
        expect(token, 'Kitchen access token').to.be.a('string').and.not.be.empty;

        return request(origin, orderPath, token).then((before) => {
          const original = orderSnapshot(before, orderId, itemId, 'GET before unauthorized Refire');
          expect(original.itemStatus, 'QA item is SERVED').eq('SERVED');
          expect(original.version, 'order version').to.be.a('number');

          return request(origin, '/api/v1/kitchen/queue', token).then((active) => {
            const beforeActive = matchingTickets(active, orderId, itemId, 'active queue before');
            expect(beforeActive, 'no active ticket on SERVED item').to.have.length(0);
            return request(origin, '/api/v1/kitchen/queue?status=DONE', token)
              .then((done) => ({ beforeActive, beforeDone: matchingTickets(done, orderId, itemId, 'DONE queue before') }));
          }).then(({ beforeActive, beforeDone }) => {
            expect(beforeDone, 'one original completed ticket').to.have.length(1);
            return request(origin, `${orderPath}/items/${itemId}/refire`, token, 'POST', key)
              .then((denied) => {
                expect(denied.status, 'unauthorized Refire HTTP').eq(403);
                return request(origin, orderPath, token);
              }).then((after) => {
                expect(orderSnapshot(after, orderId, itemId, 'GET after rejected Refire'),
                  'item status, version, and item count unchanged').to.deep.eq(original);
                return request(origin, '/api/v1/kitchen/queue', token);
              }).then((activeAfter) => {
                expect(matchingTickets(activeAfter, orderId, itemId, 'active queue after'),
                  'no new active ticket').to.deep.eq(beforeActive);
                return request(origin, '/api/v1/kitchen/queue?status=DONE', token);
              }).then((doneAfter) => {
                expect(matchingTickets(doneAfter, orderId, itemId, 'DONE queue after'),
                  'original completed ticket unchanged').to.deep.eq(beforeDone);
                return note(`TC-022: Kitchen Refire rejected 403; order ${orderId}; item ${itemId}; status SERVED and version ${original.version}; no new queue ticket`);
              });
          });
        });
      });
    });
  });
});
