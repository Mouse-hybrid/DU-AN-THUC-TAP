// DES05-TC-014 performs two state changes on one isolated QA item.
// Opt in only after reserving the fixture and confirming its cleanup plan.
// The audit actors require separate evidence; the public Order API does not expose them.
describe('DES-QA-05 | TC-014 Pickup then Served on isolated QA order', () => {
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

  const verifyItem = (response, orderId, itemId, expectedStatus, label) => {
    expect(response.status, label).eq(200);
    expect(response.body?.id, `${label} order ID`).eq(orderId);
    expect(response.body?.items, `${label} items`).to.be.an('array');
    const item = response.body.items.find((entry) => entry.id === itemId);
    expect(item, `${label} exact item`).to.exist;
    expect(item.status, `${label} item status`).eq(expectedStatus);
    return item;
  };

  it('TC-014 | READY to PICKED_UP to SERVED', function () {
    cy.env([
      'POS_BASE_URL', 'EXT_WAITER_USERNAME', 'EXT_WAITER_PASSWORD',
      'DES05_TC014_ORDER_ID', 'DES05_TC014_ITEM_ID',
      'DES05_TC014_PICKUP_KEY', 'DES05_TC014_SERVED_KEY',
      'DES05_TC014_RUN', 'DES05_TC014_CLEANUP_CONFIRMED',
    ]).then((e) => {
      if (e.DES05_TC014_RUN !== 'PICKUP_AND_SERVE_ON_ISOLATED_ORDER' ||
          e.DES05_TC014_CLEANUP_CONFIRMED !== 'YES') {
        return note('TC-014 PENDING: isolated QA fixture and cleanup plan must be explicitly approved locally')
          .then(() => this.skip());
      }
      if (!e.DES05_TC014_ORDER_ID || !e.DES05_TC014_ITEM_ID ||
          !e.DES05_TC014_PICKUP_KEY || !e.DES05_TC014_SERVED_KEY ||
          !e.EXT_WAITER_USERNAME || !e.EXT_WAITER_PASSWORD) {
        return note('TC-014 PENDING: QA Order/Item IDs, two fresh keys, or Waiter login missing')
          .then(() => this.skip());
      }

      const orderId = String(e.DES05_TC014_ORDER_ID);
      const itemId = String(e.DES05_TC014_ITEM_ID);
      const pickupKey = String(e.DES05_TC014_PICKUP_KEY);
      const servedKey = String(e.DES05_TC014_SERVED_KEY);
      expect(orderId, 'isolated QA Order UUID').to.match(uuid);
      expect(itemId, 'isolated QA Item UUID').to.match(uuid);
      expect(pickupKey, 'fresh Pickup key UUID').to.match(uuid);
      expect(servedKey, 'fresh Served key UUID').to.match(uuid);
      expect(servedKey, 'distinct Served key').not.eq(pickupKey);
      const origin = String(e.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      const itemPath = `/api/v1/orders/${orderId}/items/${itemId}`;

      cy.request({
        method: 'POST',
        url: origin + '/api/v1/auth/login',
        body: {
          username: String(e.EXT_WAITER_USERNAME),
          password: String(e.EXT_WAITER_PASSWORD),
        },
        failOnStatusCode: false,
        log: false,
        timeout: 20000,
      }).then((login) => {
        expect(login.status, 'Waiter login').eq(200);
        expect(login.body?.staff?.role, 'Pickup/Serve role').eq('WAITER');
        const token = login.body?.access_token;
        expect(token, 'Waiter access token').to.be.a('string').and.not.be.empty;

        return request(origin, `/api/v1/orders/${orderId}`, token)
          .then((before) => {
            verifyItem(before, orderId, itemId, 'READY', 'before Pickup');
            return request(origin, `${itemPath}/pickup`, token, 'POST', pickupKey);
          })
          .then((pickedUp) => {
            verifyItem(pickedUp, orderId, itemId, 'PICKED_UP', 'POST Pickup');
            return request(origin, `/api/v1/orders/${orderId}`, token);
          })
          .then((afterPickup) => {
            verifyItem(afterPickup, orderId, itemId, 'PICKED_UP', 'GET after Pickup');
            return request(origin, `${itemPath}/served`, token, 'POST', servedKey);
          })
          .then((served) => {
            verifyItem(served, orderId, itemId, 'SERVED', 'POST Served');
            return request(origin, `/api/v1/orders/${orderId}`, token);
          })
          .then((afterServed) => {
            verifyItem(afterServed, orderId, itemId, 'SERVED', 'GET after Served');
            return note(`TC-014: order ${orderId}; item ${itemId}; READY -> PICKED_UP -> SERVED; audit actor requires separate check`);
          });
      });
    });
  });
});
