// DES05-TC-020 repeats Refire with the same Idempotency-Key on a dedicated SERVED item.
// The first request mutates staging. Reserve a fresh QA fixture and cleanup plan first.
describe('DES-QA-05 | TC-020 Refire retry on isolated QA order', () => {
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
  const itemIn = (response, orderId, itemId, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body?.id, `${label} order ID`).eq(orderId);
    expect(response.body?.items, `${label} items`).to.be.an('array');
    const matches = response.body.items.filter((item) => item.id === itemId);
    expect(matches, `${label} one target item`).to.have.length(1);
    return matches[0];
  };
  const activeTickets = (response, orderId, itemId, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body, `${label} queue`).to.be.an('array');
    return response.body.filter((ticket) =>
      ticket.order_id === orderId && ticket.order_item_id === itemId);
  };

  it('TC-020 | same key returns the first result without a second queue ticket or version', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_USERNAME', 'EXT_REFIRE_SUPERVISOR_PASSWORD',
      'DES05_TC020_ORDER_ID', 'DES05_TC020_ITEM_ID', 'DES05_TC020_IDEMPOTENCY_KEY',
      'DES05_TC020_RUN', 'DES05_TC020_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC020_RUN !== 'RETRY_REFIRE_ON_ISOLATED_SERVED_ITEM' ||
          e.DES05_TC020_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-020 PENDING: isolated SERVED fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC020_ORDER_ID || !e.DES05_TC020_ITEM_ID ||
          !e.DES05_TC020_IDEMPOTENCY_KEY || !e.EXT_REFIRE_SUPERVISOR_USERNAME ||
          !e.EXT_REFIRE_SUPERVISOR_PASSWORD) {
        return pending('TC-020 PENDING: QA Order/Item IDs, fresh key, or Supervisor login missing', this);
      }

      const orderId = String(e.DES05_TC020_ORDER_ID);
      const itemId = String(e.DES05_TC020_ITEM_ID);
      const key = String(e.DES05_TC020_IDEMPOTENCY_KEY);
      expect(orderId, 'isolated QA Order UUID').to.match(uuid);
      expect(itemId, 'isolated QA Item UUID').to.match(uuid);
      expect(key, 'fresh Idempotency-Key UUID').to.match(uuid);
      const origin = String(e.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      const orderPath = `/api/v1/orders/${orderId}`;
      const refirePath = `${orderPath}/items/${itemId}/refire`;

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
          expect(itemIn(before, orderId, itemId, 'before first Refire').status).eq('SERVED');
          expect(before.body.status, 'open order').not.to.be.oneOf(['BILLING', 'PAID', 'CLOSED']);
          expect(before.body.current_version, 'version before').to.be.a('number');
          const versionBefore = before.body.current_version;
          const itemCount = before.body.items.length;

          return request(origin, '/api/v1/kitchen/queue', token).then((queueBefore) => {
            expect(activeTickets(queueBefore, orderId, itemId, 'queue before'),
              'no active ticket before Refire').to.have.length(0);
            return request(origin, '/api/v1/kitchen/queue?status=DONE', token);
          }).then((done) => {
            const originals = activeTickets(done, orderId, itemId, 'DONE queue before');
            expect(originals, 'one original completed ticket').to.have.length(1);
            const originalId = originals[0].id;
            expect(originalId, 'original ticket UUID').to.match(uuid);

            return request(origin, refirePath, token, 'POST', key).then((first) => {
              expect(itemIn(first, orderId, itemId, 'first Refire').status).eq('REFIRED');
              expect(first.body.current_version, 'version after first Refire').eq(versionBefore + 1);
              expect(first.body.items, 'no added item').to.have.length(itemCount);
              return request(origin, '/api/v1/kitchen/queue', token).then((queueFirst) => {
                const firstTickets = activeTickets(queueFirst, orderId, itemId, 'queue after first');
                expect(firstTickets, 'exactly one new active ticket').to.have.length(1);
                expect(firstTickets[0].status, 'first ticket status').eq('QUEUED');
                expect(firstTickets[0].id, 'new ticket UUID').to.match(uuid).and.not.eq(originalId);
                const ticketId = firstTickets[0].id;

                return request(origin, refirePath, token, 'POST', key).then((retry) => {
                  expect(itemIn(retry, orderId, itemId, 'same-key retry').status).eq('REFIRED');
                  expect(retry.body, 'cached first response').to.deep.eq(first.body);
                  return request(origin, orderPath, token);
                }).then((after) => {
                  expect(itemIn(after, orderId, itemId, 'GET after retry').status).eq('REFIRED');
                  expect(after.body.current_version, 'version increments only once').eq(versionBefore + 1);
                  expect(after.body.items, 'unchanged order item count').to.have.length(itemCount);
                  return request(origin, '/api/v1/kitchen/queue', token);
                }).then((queueAfter) => {
                  const tickets = activeTickets(queueAfter, orderId, itemId, 'queue after retry');
                  expect(tickets, 'retry creates no extra ticket').to.have.length(1);
                  expect(tickets[0].id, 'same ticket after retry').eq(ticketId);
                  expect(tickets[0].status, 'ticket remains QUEUED').eq('QUEUED');
                  return note(`TC-020: order ${orderId}; item ${itemId}; same-key Refire response replayed; version ${versionBefore} -> ${versionBefore + 1}; one active ticket ${ticketId}`);
                });
              });
            });
          });
        });
      });
    });
  });
});
