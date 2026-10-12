// Read-only follow-up to the staging version audit: verifies GET /orders at runtime.
// This is a contract preflight, not a DES05 functional testcase.
describe('DES-QA-05 | GET orders list runtime preflight', () => {
  const origin = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const note = (message) => cy.task('des05Note', message, { log: false });
  const pending = (message, context) => note(message)
    .then(() => cy.log(`${message} (video evidence pause: 3 seconds)`).wait(3000, { log: false }))
    .then(() => context.skip());
  const getOrders = (base, token, query = '?limit=5') => cy.request({
    method: 'GET',
    url: base + '/api/v1/orders' + query,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    failOnStatusCode: false,
    log: false,
    timeout: 20000,
  });

  it('PF-11 | route exists and rejects a request without JWT', () => {
    cy.env(['POS_BASE_URL']).then((e) => getOrders(origin(e.POS_BASE_URL), null))
      .then((response) => {
        expect(response.status, 'GET /orders without JWT').eq(401);
        return note('PF-11: GET /api/v1/orders?limit=5 returned 401 without JWT (route exists; not 405)');
      });
  });

  it('PF-12 | authenticated GET /orders returns summary records', function () {
    cy.env(['POS_BASE_URL', 'POS_USERNAME', 'POS_PASSWORD']).then((e) => {
      if (!e.POS_USERNAME || !e.POS_PASSWORD) {
        return pending('PF-12 PENDING: seeded account login absent; authenticated GET /orders not executed', this);
      }
      const base = origin(e.POS_BASE_URL);
      return cy.request({
        method: 'POST',
        url: base + '/api/v1/auth/login',
        body: {
          username: String(e.POS_USERNAME),
          password: String(e.POS_PASSWORD),
        },
        failOnStatusCode: false,
        log: false,
        timeout: 20000,
      }).then((login) => {
        expect(login.status, 'Seeded user login HTTP (check local credentials)').eq(200);
        const token = login.body?.access_token || login.body?.data?.access_token;
        expect(token, 'access token').to.be.a('string').and.not.be.empty;
        return getOrders(base, token).then((list) => {
          expect(list.status, 'GET /orders with JWT').eq(200);
          expect(list.body, 'order summaries').to.be.an('array');
          expect(list.body.length, 'limit=5').to.be.at.most(5);
          list.body.forEach((order) => {
            expect(order.id, 'order ID').to.be.a('string');
            expect(order.table_code, 'table code').to.be.a('string');
            expect(order.status, 'order status').to.be.a('string');
            expect(order.current_version, 'order version').to.be.a('number');
            expect(order.item_count, 'item count').to.be.a('number');
            expect(order.subtotal, 'subtotal').to.exist;
          });
          return note(`PF-12: authenticated GET /api/v1/orders?limit=5 returned 200; ${list.body.length} summaries; no order data changed`);
        });
      });
    });
  });
});
