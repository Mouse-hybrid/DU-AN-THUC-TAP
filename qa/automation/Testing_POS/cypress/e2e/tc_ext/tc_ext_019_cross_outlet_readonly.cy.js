// Phase 1 TC_EXT_019: two distinct authorized QA outlets and an order owned
// by outlet B are required. This test never creates or changes an order.
describe('Phase 1 | TC_EXT_019 cross-outlet Order isolation', () => {
  const base = 'http://160.191.47.17';
  const note = (message) => cy.task('des05Note', `[Phase 1] ${message}`, { log: false });
  const login = (username, password) => cy.request({
    method: 'POST', url: base + '/api/v1/auth/login',
    body: { username, password }, failOnStatusCode: false,
    log: false, timeout: 20000,
  }).then((response) => {
    expect(response.status, `${username} login`).eq(200);
    expect(response.body?.access_token, 'QA JWT').to.be.a('string').and.not.be.empty;
    expect(response.body?.staff?.outlet_id, 'account outlet ID')
      .to.be.a('string').and.not.be.empty;
    return response.body;
  });
  const getOrder = (id, token) => cy.request({
    method: 'GET', url: `${base}/api/v1/orders/${id}`,
    failOnStatusCode: false, log: false, timeout: 20000,
    headers: { Authorization: `Bearer ${token}` },
  });

  it('TC_EXT_019 | A cannot read a verified order owned by B', function () {
    return cy.env(['POS_BASE_URL', 'PHASE1_OUTLET_A_USERNAME',
      'PHASE1_OUTLET_A_PASSWORD', 'PHASE1_OUTLET_B_USERNAME',
      'PHASE1_OUTLET_B_PASSWORD', 'PHASE1_OUTLET_B_ORDER_ID'], { log: false })
      .then((env) => {
        if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
          throw new Error('SAFETY: approved staging only');
        }
        const required = ['PHASE1_OUTLET_A_USERNAME', 'PHASE1_OUTLET_A_PASSWORD',
          'PHASE1_OUTLET_B_USERNAME', 'PHASE1_OUTLET_B_PASSWORD',
          'PHASE1_OUTLET_B_ORDER_ID'];
        if (required.some((name) => !env[name])) {
          return note('TC_EXT_019 PENDING: two outlet credentials and an isolated outlet B order ID are required')
            .then(() => this.skip());
        }
        const orderId = String(env.PHASE1_OUTLET_B_ORDER_ID);
        expect(orderId, 'known QA order ID').to.match(/^[0-9a-fA-F-]{36}$/);
        return login(String(env.PHASE1_OUTLET_B_USERNAME),
          String(env.PHASE1_OUTLET_B_PASSWORD)).then((b) =>
          login(String(env.PHASE1_OUTLET_A_USERNAME),
            String(env.PHASE1_OUTLET_A_PASSWORD)).then((a) => ({ a, b })))
          .then(({ a, b }) => {
            if (a.staff.outlet_id === b.staff.outlet_id) {
              return note(`TC_EXT_019 PENDING: both accounts belong to outlet ${a.staff.outlet_id}; no cross-outlet request made`)
                .then(() => this.skip());
            }
            return getOrder(orderId, b.access_token).then((owned) => {
              expect(owned.status, 'B can GET its own QA order').eq(200);
              expect(owned.body?.id, 'verified B order ID').eq(orderId);
              return getOrder(orderId, a.access_token).then((foreign) => {
                return note(`TC_EXT_019 observed: A outlet ${a.staff.outlet_id}; B outlet ${b.staff.outlet_id}; B GET own order HTTP ${owned.status}; A GET B order HTTP ${foreign.status}; read-only`)
                  .then(() => {
                    expect(foreign.status, 'cross-outlet order is hidden').eq(404);
                    expect(foreign.body?.id, 'B order ID not leaked').to.be.undefined;
                    return note('TC_EXT_019 assertions OK: no B order data returned to A; no mutation');
                  });
              });
            });
          });
      });
  });
});
