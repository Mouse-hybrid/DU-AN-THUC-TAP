// DES05-TC-021 verifies GET Order subtotal is unchanged after one Refire.
// The Refire request mutates staging. Use a dedicated SERVED QA item and cleanup plan.
describe('DES-QA-05 | TC-021 Refire subtotal on isolated QA order', () => {
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
    expect(matches, `${label} exact item`).to.have.length(1);
    return matches[0];
  };
  const ticketsFor = (response, orderId, itemId, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body, label).to.be.an('array');
    return response.body.filter((ticket) =>
      ticket.order_id === orderId && ticket.order_item_id === itemId);
  };

  it('TC-021 | Refire creates a ticket without increasing GET Order subtotal', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_USERNAME', 'EXT_REFIRE_SUPERVISOR_PASSWORD',
      'DES05_TC021_ORDER_ID', 'DES05_TC021_ITEM_ID', 'DES05_TC021_IDEMPOTENCY_KEY',
      'DES05_TC021_RUN', 'DES05_TC021_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC021_RUN !== 'REFIRE_AND_COMPARE_ISOLATED_SUBTOTAL' ||
          e.DES05_TC021_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-021 PENDING: isolated SERVED fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC021_ORDER_ID || !e.DES05_TC021_ITEM_ID ||
          !e.DES05_TC021_IDEMPOTENCY_KEY || !e.EXT_REFIRE_SUPERVISOR_USERNAME ||
          !e.EXT_REFIRE_SUPERVISOR_PASSWORD) {
        return pending('TC-021 PENDING: QA Order/Item IDs, fresh key, or Supervisor login missing', this);
      }

      const orderId = String(e.DES05_TC021_ORDER_ID);
      const itemId = String(e.DES05_TC021_ITEM_ID);
      const key = String(e.DES05_TC021_IDEMPOTENCY_KEY);
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
          const item = itemIn(before, orderId, itemId, 'GET before Refire');
          expect(item.status, 'target item status').eq('SERVED');
          expect(before.body.status, 'open order').not.to.be.oneOf(['BILLING', 'PAID', 'CLOSED']);
          expect(before.body.subtotal, 'known subtotal before Refire').to.exist;
          expect(before.body.current_version, 'version before Refire').to.be.a('number');
          const subtotal = String(before.body.subtotal);
          const version = before.body.current_version;
          const itemCount = before.body.items.length;
          const originalLineTotal = String(item.line_total);

          return request(origin, '/api/v1/kitchen/queue', token).then((active) => {
            expect(ticketsFor(active, orderId, itemId, 'active queue before'),
              'no active ticket on SERVED item').to.have.length(0);
            return request(origin, '/api/v1/kitchen/queue?status=DONE', token);
          }).then((done) => {
            expect(ticketsFor(done, orderId, itemId, 'DONE queue before'),
              'one completed original ticket').to.have.length(1);
            return request(origin, `${orderPath}/items/${itemId}/refire`, token, 'POST', key);
          }).then((refired) => {
            expect(itemIn(refired, orderId, itemId, 'POST Refire').status).eq('REFIRED');
            expect(refired.body.current_version, 'version after Refire').eq(version + 1);
            expect(refired.body.items, 'no additional order item').to.have.length(itemCount);
            return request(origin, orderPath, token);
          }).then((after) => {
            const afterItem = itemIn(after, orderId, itemId, 'GET after Refire');
            expect(afterItem.status, 'persisted target status').eq('REFIRED');
            expect(after.body.current_version, 'persisted version').eq(version + 1);
            expect(after.body.items, 'same item count').to.have.length(itemCount);
            expect(String(afterItem.line_total), 'target line total unchanged').eq(originalLineTotal);
            expect(String(after.body.subtotal), 'subtotal unchanged after Refire').eq(subtotal);
            return request(origin, '/api/v1/kitchen/queue', token);
          }).then((activeAfter) => {
            const tickets = ticketsFor(activeAfter, orderId, itemId, 'active queue after');
            expect(tickets, 'one new Refire ticket').to.have.length(1);
            expect(tickets[0].status, 'new ticket queued').eq('QUEUED');
            return note(`TC-021: order ${orderId}; item ${itemId}; Refire QUEUED ticket ${tickets[0].id}; subtotal ${subtotal} -> ${subtotal}; version ${version} -> ${version + 1}`);
          });
        });
      });
    });
  });
});
