// DES05-TC-024 deliberately Refires a SERVED item for the second time.
// Fixture must have exactly two DONE tickets: original and completed first Refire.
// The public API exposes distinct queue ticket IDs, not an "-R2" display label.
describe('DES-QA-05 | TC-024 second deliberate Refire on isolated QA order', () => {
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
    const items = response.body.items.filter((item) => item.id === itemId);
    expect(items, `${label} target item`).to.have.length(1);
    return items[0];
  };
  const ticketsFor = (response, orderId, itemId, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body, label).to.be.an('array');
    return response.body.filter((ticket) =>
      ticket.order_id === orderId && ticket.order_item_id === itemId);
  };

  it('TC-024 | new key creates a distinct third ticket, not an idempotent replay', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_USERNAME', 'EXT_REFIRE_SUPERVISOR_PASSWORD',
      'DES05_TC024_ORDER_ID', 'DES05_TC024_ITEM_ID', 'DES05_TC024_IDEMPOTENCY_KEY',
      'DES05_TC024_FIRST_REFIRE_KEY',
      'DES05_TC024_RUN', 'DES05_TC024_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC024_RUN !== 'SECOND_REFIRE_ON_ISOLATED_SERVED_ITEM' ||
          e.DES05_TC024_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-024 PENDING: isolated re-served fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC024_ORDER_ID || !e.DES05_TC024_ITEM_ID ||
          !e.DES05_TC024_IDEMPOTENCY_KEY || !e.DES05_TC024_FIRST_REFIRE_KEY ||
          !e.EXT_REFIRE_SUPERVISOR_USERNAME ||
          !e.EXT_REFIRE_SUPERVISOR_PASSWORD) {
        return pending('TC-024 PENDING: QA Order/Item IDs, first/new keys, or Supervisor login missing', this);
      }

      const orderId = String(e.DES05_TC024_ORDER_ID);
      const itemId = String(e.DES05_TC024_ITEM_ID);
      const key = String(e.DES05_TC024_IDEMPOTENCY_KEY);
      const firstKey = String(e.DES05_TC024_FIRST_REFIRE_KEY);
      expect(orderId, 'isolated QA Order UUID').to.match(uuid);
      expect(itemId, 'isolated QA Item UUID').to.match(uuid);
      expect(key, 'new Idempotency-Key UUID').to.match(uuid);
      expect(firstKey, 'first Refire key UUID').to.match(uuid);
      expect(key, 'distinct second Refire key').not.eq(firstKey);
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
          expect(itemIn(before, orderId, itemId, 'before second Refire').status,
            'item served again after first Refire').eq('SERVED');
          expect(before.body.status, 'order open').not.to.be.oneOf(['BILLING', 'PAID', 'CLOSED']);
          expect(before.body.current_version, 'version before').to.be.a('number');
          const priorVersion = before.body.current_version;
          const itemCount = before.body.items.length;

          return request(origin, '/api/v1/kitchen/queue', token).then((active) => {
            expect(ticketsFor(active, orderId, itemId, 'active queue before'),
              'no active ticket before second Refire').to.have.length(0);
            return request(origin, '/api/v1/kitchen/queue?status=DONE', token);
          }).then((done) => {
            const completed = ticketsFor(done, orderId, itemId, 'DONE queue before');
            expect(completed, 'original and first Refire completed tickets').to.have.length(2);
            const priorIds = completed.map((ticket) => ticket.id);
            expect(new Set(priorIds).size, 'two distinct completed tickets').eq(2);
            completed.forEach((ticket) => expect(ticket.station_id, 'completed ticket station').eq(completed[0].station_id));

            return request(origin, `${orderPath}/items/${itemId}/refire`, token, 'POST', key)
              .then((refired) => {
                expect(itemIn(refired, orderId, itemId, 'POST second Refire').status).eq('REFIRED');
                expect(refired.body.current_version, 'one more version').eq(priorVersion + 1);
                expect(refired.body.items, 'no additional order item').to.have.length(itemCount);
                return request(origin, orderPath, token);
              }).then((after) => {
                expect(itemIn(after, orderId, itemId, 'GET after second Refire').status).eq('REFIRED');
                expect(after.body.current_version, 'persisted version').eq(priorVersion + 1);
                expect(after.body.items, 'same order item count').to.have.length(itemCount);
                return request(origin, '/api/v1/kitchen/queue', token);
              }).then((activeAfter) => {
                const tickets = ticketsFor(activeAfter, orderId, itemId, 'active queue after');
                expect(tickets, 'one new active ticket').to.have.length(1);
                expect(tickets[0].status, 'new ticket queued').eq('QUEUED');
                expect(tickets[0].id, 'third ticket UUID').to.match(uuid);
                expect(priorIds, 'third ticket has a new ID').not.to.include(tickets[0].id);
                expect(tickets[0].station_id, 'original station retained').eq(completed[0].station_id);
                return request(origin, '/api/v1/kitchen/queue?status=DONE', token)
                  .then((doneAfter) => {
                    expect(ticketsFor(doneAfter, orderId, itemId, 'DONE queue after')
                      .map((ticket) => ticket.id).sort(), 'prior tickets remain DONE')
                      .to.deep.eq(priorIds.sort());
                    return note(`TC-024: order ${orderId}; item ${itemId}; new Refire ticket ${tickets[0].id}; two prior DONE tickets retained; version ${priorVersion} -> ${priorVersion + 1}; -R2 display label requires separate UI evidence`);
                  });
              });
          });
        });
      });
    });
  });
});
