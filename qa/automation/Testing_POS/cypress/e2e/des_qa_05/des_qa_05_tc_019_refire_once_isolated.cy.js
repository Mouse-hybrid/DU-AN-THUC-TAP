// DES05-TC-019 refires one SERVED item on a dedicated QA order.
// This changes staging data. Reserve the fixture and confirm its cleanup plan first.
// The public Order API exposes the version; audit actor/history require separate evidence.
describe('DES-QA-05 | TC-019 Refire once on isolated QA order', () => {
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
  const matchingQueue = (response, orderId, itemId, label) => {
    expect(response.status, `${label} status`).eq(200);
    expect(response.body, label).to.be.an('array');
    return response.body.filter((entry) =>
      entry.order_id === orderId && entry.order_item_id === itemId);
  };
  const matchingItem = (response, orderId, itemId, label) => {
    expect(response.status, `${label} status`).eq(200);
    expect(response.body?.id, `${label} order ID`).eq(orderId);
    expect(response.body?.items, `${label} items`).to.be.an('array');
    const items = response.body.items.filter((entry) => entry.id === itemId);
    expect(items, `${label} exact item once`).to.have.length(1);
    return items[0];
  };

  it('TC-019 | SERVED to REFIRED; new QUEUED ticket on original station; version increments', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_USERNAME', 'EXT_REFIRE_SUPERVISOR_PASSWORD',
      'DES05_TC019_ORDER_ID', 'DES05_TC019_ITEM_ID', 'DES05_TC019_IDEMPOTENCY_KEY',
      'DES05_TC019_RUN', 'DES05_TC019_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC019_RUN !== 'REFIRE_ON_ISOLATED_SERVED_ITEM' ||
          e.DES05_TC019_CLEANUP_CONFIRMED !== 'YES') {
        return pending('TC-019 PENDING: isolated SERVED fixture and cleanup plan must be explicitly approved locally', this);
      }
      if (!e.DES05_TC019_ORDER_ID || !e.DES05_TC019_ITEM_ID ||
          !e.DES05_TC019_IDEMPOTENCY_KEY || !e.EXT_REFIRE_SUPERVISOR_USERNAME ||
          !e.EXT_REFIRE_SUPERVISOR_PASSWORD) {
        return pending('TC-019 PENDING: QA Order/Item IDs, fresh key, or Supervisor login missing', this);
      }

      const orderId = String(e.DES05_TC019_ORDER_ID);
      const itemId = String(e.DES05_TC019_ITEM_ID);
      const key = String(e.DES05_TC019_IDEMPOTENCY_KEY);
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
          const item = matchingItem(before, orderId, itemId, 'before Refire');
          expect(item.status, 'isolated item status').eq('SERVED');
          expect(before.body.status, 'order is open').not.to.be.oneOf(['BILLING', 'PAID', 'CLOSED']);
          expect(before.body.current_version, 'current version').to.be.a('number');
          const priorVersion = before.body.current_version;
          const priorItems = before.body.items.length;

          return request(origin, '/api/v1/kitchen/queue', token).then((active) => {
            expect(matchingQueue(active, orderId, itemId, 'active queue before Refire'),
              'no existing active ticket for SERVED item').to.have.length(0);
            return request(origin, '/api/v1/kitchen/queue?status=DONE', token);
          }).then((done) => {
            const oldEntries = matchingQueue(done, orderId, itemId, 'DONE queue before Refire');
            expect(oldEntries, 'one original completed ticket').to.have.length(1);
            const original = oldEntries[0];
            expect(original.id, 'original queue ticket ID').to.match(uuid);
            expect(original.station_id, 'original station ID').to.match(uuid);

            return request(origin, `${orderPath}/items/${itemId}/refire`, token, 'POST', key)
              .then((refired) => {
                expect(matchingItem(refired, orderId, itemId, 'POST Refire').status).eq('REFIRED');
                expect(refired.body.current_version, 'response version').eq(priorVersion + 1);
                expect(refired.body.items, 'no extra order item').to.have.length(priorItems);
                return request(origin, orderPath, token);
              }).then((after) => {
                expect(matchingItem(after, orderId, itemId, 'GET after Refire').status).eq('REFIRED');
                expect(after.body.current_version, 'persisted version').eq(priorVersion + 1);
                expect(after.body.items, 'persisted item count').to.have.length(priorItems);
                return request(origin, '/api/v1/kitchen/queue', token);
              }).then((activeAfter) => {
                const tickets = matchingQueue(activeAfter, orderId, itemId, 'active queue after Refire');
                expect(tickets, 'one new Refire ticket').to.have.length(1);
                expect(tickets[0].status, 'new ticket status').eq('QUEUED');
                expect(tickets[0].id, 'new queue ticket ID').to.match(uuid).and.not.eq(original.id);
                expect(tickets[0].station_id, 'same station as original ticket').eq(original.station_id);
                return note(`TC-019: order ${orderId}; item ${itemId}; SERVED -> REFIRED; version ${priorVersion} -> ${priorVersion + 1}; original ticket ${original.id}; new QUEUED ticket ${tickets[0].id}; station ${original.station_id}; audit actor requires separate check`);
              });
          });
        });
      });
    });
  });
});
