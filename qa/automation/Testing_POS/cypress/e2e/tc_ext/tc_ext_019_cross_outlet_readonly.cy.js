// Phase 1 TC_EXT_019: discover an existing QA2 order within outlet B, then
// verify ownership before attempting an outlet A GET. No business mutation.
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
          'PHASE1_OUTLET_B_USERNAME', 'PHASE1_OUTLET_B_PASSWORD'];
        if (required.some((name) => !env[name])) {
          return note('TC_EXT_019 PENDING: two outlet credentials are required')
            .then(() => this.skip());
        }
        const specifiedOrderId = String(env.PHASE1_OUTLET_B_ORDER_ID || '');
        if (specifiedOrderId) expect(specifiedOrderId, 'known QA order ID')
          .to.match(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/);
        return login(String(env.PHASE1_OUTLET_B_USERNAME),
          String(env.PHASE1_OUTLET_B_PASSWORD)).then((b) =>
          login(String(env.PHASE1_OUTLET_A_USERNAME),
            String(env.PHASE1_OUTLET_A_PASSWORD)).then((a) => ({ a, b })))
          .then(({ a, b }) => {
            if (a.staff.outlet_id === b.staff.outlet_id) {
              return note(`TC_EXT_019 PENDING: both accounts belong to outlet ${a.staff.outlet_id}; no cross-outlet request made`)
                .then(() => this.skip());
            }
            const resolveOrderId = specifiedOrderId ? cy.wrap(specifiedOrderId, { log: false }) :
              cy.request({
                method: 'GET', url: `${base}/api/v1/orders?limit=50`,
                headers: { Authorization: `Bearer ${b.access_token}` },
                failOnStatusCode: false, log: false, timeout: 20000,
              }).then((list) => {
                expect(list.status, 'outlet B order list').eq(200);
                expect(list.body, 'outlet B order summaries').to.be.an('array');
                const orders = list.body.filter((entry) =>
                  typeof entry.id === 'string' &&
                  /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(entry.id));
                const fixture = orders.find((entry) =>
                  entry.table_code === 'Q2-1' && entry.status === 'NEW') ||
                  orders.find((entry) => typeof entry.table_code === 'string' && /^Q2-/.test(entry.table_code)) ||
                  orders[0];
                if (fixture) return note(`TC_EXT_019 fixture: existing outlet B order ${fixture.id}; table ${fixture.table_code}; status ${fixture.status}; read-only`).then(() => fixture.id);
                return null;
              });
            return resolveOrderId.then((orderId) => {
              if (!orderId) return note('TC_EXT_019 PENDING: no existing QA order in outlet B list; provide an outlet B order UUID or seed a fixture in a coordinated reset; no cross-outlet GET')
                .then(() => this.skip());
              return getOrder(orderId, b.access_token).then((owned) => ({ orderId, owned }));
            }).then(({ orderId, owned }) => {
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
