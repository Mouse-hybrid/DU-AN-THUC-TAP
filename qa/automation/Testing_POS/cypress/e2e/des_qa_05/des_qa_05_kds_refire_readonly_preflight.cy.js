// DES-QA-05 preflight: business data requests are GET; optional login obtains a JWT.
// A passing preflight never marks any DES05 functional testcase as Passed.
describe('DES-QA-05 | KDS routing and Refire read-only preflight', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const rows = (body, names) => {
    if (Array.isArray(body)) return body;
    for (const name of names) {
      if (Array.isArray(body?.[name])) return body[name];
      if (Array.isArray(body?.data?.[name])) return body.data[name];
    }
    if (Array.isArray(body?.data)) return body.data;
    return null;
  };
  const base = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const note = (message) => cy.task('des05Note', message, { log: false });
  const get = (origin, path, token) => cy.request({
    method: 'GET',
    url: origin + path,
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    failOnStatusCode: false,
    log: false,
    timeout: 20000,
  });
  const tokenFor = (origin, token, username, password) => {
    if (token) return cy.wrap(token, { log: false });
    const account = String(username ?? '');
    const secret = String(password ?? '');
    if (!account && !secret) return cy.wrap(null, { log: false });
    if (!account || !secret) throw new Error('QA login credentials incomplete');
    return cy.request({
      method: 'POST',
      url: origin + '/api/v1/auth/login',
      body: { username: account, password: secret },
      failOnStatusCode: false,
      log: false,
      timeout: 20000,
    }).then((response) => {
      expect(response.status, 'QA login status').eq(200);
      const accessToken = response.body?.access_token || response.body?.data?.access_token;
      expect(accessToken, 'QA access token').to.be.a('string').and.not.be.empty;
      return accessToken;
    });
  };

  it('PF-01 | /health responds and reports ok', () => {
    cy.env(['POS_BASE_URL']).then((e) => {
      get(base(e.POS_BASE_URL), '/health').then((response) => {
        expect(response.status, 'GET /health status').eq(200);
        expect(response.body?.status, 'health status').eq('ok');
      });
    });
  });

  it('PF-02 | available menu exposes station fixture candidates', function () {
    cy.env(['POS_BASE_URL', 'DES05_MENU_TOKEN', 'POS_USERNAME', 'POS_PASSWORD']).then((e) => {
      const origin = base(e.POS_BASE_URL);
      tokenFor(origin, e.DES05_MENU_TOKEN, e.POS_USERNAME, e.POS_PASSWORD).then((token) =>
        get(origin, '/api/v1/menu?available_only=true', token)
        .then((response) => {
          if (!token && [401, 403].includes(response.status)) {
            return note(`PF-02 PENDING: Menu HTTP ${response.status}; QA token required`)
              .then(() => this.skip());
          }
          expect(response.status, 'GET available menu status').eq(200);
          const items = rows(response.body, ['items', 'menu_items', 'results']);
          expect(items, 'menu collection').to.be.an('array');
          const candidates = items.filter((item) => item.is_available !== false && item.station_id);
          const stations = new Set(candidates.map((item) => String(item.station_id)));
          if (stations.size < 6) {
            return note(`PF-02 PENDING: Menu HTTP 200; station candidates ${candidates.length}; distinct station IDs ${stations.size}; need six mapped fixtures`)
              .then(() => this.skip());
          }
          note(`PF-02: Menu HTTP 200; station candidates ${candidates.length}; distinct station IDs ${stations.size}`);
          cy.log('PREFLIGHT ONLY: six station IDs observed; routing and station mapping are untested');
        }));
    });
  });

  it('PF-03 | Kitchen JWT can read the queue', function () {
    cy.env(['POS_BASE_URL', 'EXT_KITCHEN_TOKEN', 'EXT_KITCHEN_USERNAME', 'EXT_KITCHEN_PASSWORD']).then((e) => {
      const origin = base(e.POS_BASE_URL);
      tokenFor(origin, e.EXT_KITCHEN_TOKEN, e.EXT_KITCHEN_USERNAME, e.EXT_KITCHEN_PASSWORD)
        .then((token) => {
          if (!token) {
            return note('PF-03 PENDING: Kitchen JWT or local QA credentials not configured')
              .then(() => this.skip());
          }
          return get(origin, '/api/v1/kitchen/queue', token);
        })
        .then((response) => {
          expect(response.status, 'GET Kitchen Queue status').eq(200);
          const entries = rows(response.body, ['entries', 'queue', 'items', 'results']);
          expect(entries, 'Kitchen Queue collection').to.be.an('array');
          note(`PF-03: Kitchen Queue HTTP ${response.status}; entries ${entries.length}; routing untested`);
        });
    });
  });

  it('PF-04 | isolated QA order contains a SERVED item for Refire', function () {
    cy.env(['POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_TOKEN', 'EXT_REFIRE_SUPERVISOR_USERNAME',
      'EXT_REFIRE_SUPERVISOR_PASSWORD', 'EXT_REFIRE_ORDER_ID'])
      .then((e) => {
        if (!e.EXT_REFIRE_ORDER_ID) {
          return note('PF-04 PENDING: isolated QA Order ID not configured')
            .then(() => this.skip());
        }
        expect(e.EXT_REFIRE_ORDER_ID, 'QA order UUID').to.match(uuid);
        const origin = base(e.POS_BASE_URL);
        tokenFor(origin, e.EXT_REFIRE_SUPERVISOR_TOKEN, e.EXT_REFIRE_SUPERVISOR_USERNAME,
          e.EXT_REFIRE_SUPERVISOR_PASSWORD).then((token) => {
          if (!token) {
            return note('PF-04 PENDING: supervisor JWT or local QA credentials not configured')
              .then(() => this.skip());
          }
          return get(origin, '/api/v1/orders/' + e.EXT_REFIRE_ORDER_ID, token);
        }).then((response) => {
          expect(response.status, 'GET QA order status').eq(200);
          const order = response.body?.order || response.body?.data?.order || response.body?.data || response.body;
          expect(order?.items, 'QA order items').to.be.an('array');
          const served = order.items.filter((item) => item.status === 'SERVED');
          cy.log(`SERVED items observed: ${served.length}; subtotal: ${String(order.subtotal ?? 'unavailable')}`);
          if (!served.length) {
            return note('PF-04 PENDING: QA order has no SERVED item')
              .then(() => this.skip());
          }
          cy.log('PREFLIGHT ONLY: no Refire request or billing comparison performed');
        });
      });
  });
});
