// DES-QA-05 preflight: every network request in this spec is GET.
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
  const get = (origin, path, token) => cy.request({
    method: 'GET',
    url: origin + path,
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    failOnStatusCode: false,
    log: false,
    timeout: 20000,
  });

  it('PF-01 | /health responds and reports ok', () => {
    cy.env(['POS_BASE_URL']).then((e) => {
      get(base(e.POS_BASE_URL), '/health').then((response) => {
        expect(response.status, 'GET /health status').eq(200);
        expect(response.body?.status, 'health status').eq('ok');
      });
    });
  });

  it('PF-02 | available menu exposes station fixture candidates', function () {
    cy.env(['POS_BASE_URL', 'DES05_MENU_TOKEN']).then((e) => {
      get(base(e.POS_BASE_URL), '/api/v1/menu?available_only=true', e.DES05_MENU_TOKEN)
        .then((response) => {
          if (!e.DES05_MENU_TOKEN && [401, 403].includes(response.status)) {
            cy.log('PENDING: menu read requires a QA token');
            this.skip();
            return;
          }
          expect(response.status, 'GET available menu status').eq(200);
          const items = rows(response.body, ['items', 'menu_items', 'results']);
          expect(items, 'menu collection').to.be.an('array');
          const candidates = items.filter((item) => item.is_available !== false && item.station_id);
          const stations = new Set(candidates.map((item) => String(item.station_id)));
          cy.log(`Available items with station_id: ${candidates.length}; distinct stations: ${stations.size}`);
          if (stations.size < 6) {
            cy.log('PENDING: fewer than six distinct station fixture candidates; mapping remains unconfirmed');
            this.skip();
            return;
          }
          cy.log('PREFLIGHT ONLY: six station IDs observed; routing and station mapping are untested');
        });
    });
  });

  it('PF-03 | Kitchen JWT can read the queue', function () {
    cy.env(['POS_BASE_URL', 'EXT_KITCHEN_TOKEN']).then((e) => {
      if (!e.EXT_KITCHEN_TOKEN) {
        cy.log('PENDING: configure EXT_KITCHEN_TOKEN locally or in CI secrets');
        this.skip();
        return;
      }
      get(base(e.POS_BASE_URL), '/api/v1/kitchen/queue', e.EXT_KITCHEN_TOKEN)
        .then((response) => {
          expect(response.status, 'GET Kitchen Queue status').eq(200);
          const entries = rows(response.body, ['entries', 'queue', 'items', 'results']);
          expect(entries, 'Kitchen Queue collection').to.be.an('array');
          cy.log(`Queue entries observed: ${entries.length}; no routing assertion performed`);
        });
    });
  });

  it('PF-04 | isolated QA order contains a SERVED item for Refire', function () {
    cy.env(['POS_BASE_URL', 'EXT_REFIRE_SUPERVISOR_TOKEN', 'EXT_REFIRE_ORDER_ID'])
      .then((e) => {
        if (!e.EXT_REFIRE_SUPERVISOR_TOKEN || !e.EXT_REFIRE_ORDER_ID) {
          cy.log('PENDING: isolated QA Order ID and supervisor JWT are required');
          this.skip();
          return;
        }
        expect(e.EXT_REFIRE_ORDER_ID, 'QA order UUID').to.match(uuid);
        get(base(e.POS_BASE_URL), '/api/v1/orders/' + e.EXT_REFIRE_ORDER_ID,
          e.EXT_REFIRE_SUPERVISOR_TOKEN).then((response) => {
          expect(response.status, 'GET QA order status').eq(200);
          const order = response.body?.order || response.body?.data?.order || response.body?.data || response.body;
          expect(order?.items, 'QA order items').to.be.an('array');
          const served = order.items.filter((item) => item.status === 'SERVED');
          cy.log(`SERVED items observed: ${served.length}; subtotal: ${String(order.subtotal ?? 'unavailable')}`);
          if (!served.length) {
            cy.log('PENDING: confirmed QA order has no SERVED item');
            this.skip();
            return;
          }
          cy.log('PREFLIGHT ONLY: no Refire request or billing comparison performed');
        });
      });
  });
});
