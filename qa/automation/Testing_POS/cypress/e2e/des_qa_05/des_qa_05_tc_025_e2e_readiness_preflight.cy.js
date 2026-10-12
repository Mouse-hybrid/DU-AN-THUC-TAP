// TC-025 readiness only: read OpenAPI and Kitchen stations; never create or change data.
// A Passing readiness check does not mark the mixed-routing/modifier/lifecycle E2E Passed.
describe('DES-QA-05 | TC-025 mixed-routing E2E readiness preflight', () => {
  const note = (message) => cy.task('des05Note', message, { log: false });
  const pending = (message, context) => note(message)
    .then(() => cy.log(`${message} (video evidence pause: 3 seconds)`).wait(3000, { log: false }))
    .then(() => context.skip());
  const base = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const get = (origin, path, token) => cy.request({
    method: 'GET',
    url: origin + path,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    failOnStatusCode: false,
    log: false,
    timeout: 20000,
  });
  const resolveSchema = (document, schema) => {
    if (!schema?.$ref) return schema;
    if (!schema.$ref.startsWith('#/')) return null;
    return schema.$ref.slice(2).split('/').reduce(
      (part, key) => part?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document
    );
  };

  it('PF-09 | add-item OpenAPI documents modifier input needed by TC-025', function () {
    cy.env(['POS_BASE_URL']).then((e) => get(base(e.POS_BASE_URL), '/openapi.json'))
      .then((response) => {
        expect(response.status, 'GET staging OpenAPI').eq(200);
        const document = response.body;
        const addItem = document?.paths?.['/api/v1/orders/{order_id}/items']?.post;
        expect(addItem, 'POST add-item operation').to.be.an('object');
        const bodySchema = resolveSchema(
          document, addItem.requestBody?.content?.['application/json']?.schema
        );
        expect(bodySchema, 'add-item body schema').to.be.an('object');
        const itemSchema = resolveSchema(document, bodySchema.properties?.items?.items);
        expect(itemSchema, 'add-item line schema').to.be.an('object');
        const modifierFields = Object.keys(itemSchema.properties || {})
          .filter((field) => /modifier/i.test(field));
        if (!modifierFields.length) {
          return pending('PF-09 PENDING: add-item API lacks modifier input; TC-025 mixed-routing/modifier E2E cannot run against this contract', this);
        }
        return note(`PF-09: modifier input documented as ${modifierFields.join(', ')}; TC-025 E2E still unexecuted`);
      });
  });

  it('PF-10 | Kitchen exposes at least six distinct station fixtures', function () {
    cy.env(['POS_BASE_URL', 'EXT_KITCHEN_TOKEN', 'EXT_KITCHEN_USERNAME',
      'EXT_KITCHEN_PASSWORD']).then((e) => {
      const origin = base(e.POS_BASE_URL);
      if (e.EXT_KITCHEN_TOKEN) return cy.wrap(String(e.EXT_KITCHEN_TOKEN), { log: false })
        .then((token) => ({ origin, token }));
      if (!e.EXT_KITCHEN_USERNAME || !e.EXT_KITCHEN_PASSWORD) {
        return pending('PF-10 PENDING: Kitchen JWT or local QA credentials missing; cannot count staging stations', this);
      }
      return cy.request({
        method: 'POST',
        url: origin + '/api/v1/auth/login',
        body: {
          username: String(e.EXT_KITCHEN_USERNAME),
          password: String(e.EXT_KITCHEN_PASSWORD),
        },
        failOnStatusCode: false,
        log: false,
        timeout: 20000,
      }).then((login) => {
        expect(login.status, 'Kitchen login').eq(200);
        expect(login.body?.staff?.role, 'Kitchen role').eq('KITCHEN');
        expect(login.body?.access_token, 'Kitchen token').to.be.a('string').and.not.be.empty;
        return { origin, token: login.body.access_token };
      });
    }).then((auth) => {
      if (!auth) return;
      return get(auth.origin, '/api/v1/kitchen/stations', auth.token).then((response) => {
        expect(response.status, 'GET Kitchen stations').eq(200);
        expect(response.body, 'station list').to.be.an('array');
        const ids = new Set(response.body.map((station) => station.id).filter(Boolean));
        if (ids.size < 6) {
          return pending(`PF-10 PENDING: only ${ids.size} distinct Kitchen station IDs; TC-025 needs six mapped stations`, this);
        }
        return note(`PF-10: ${ids.size} Kitchen station IDs observed; menu mapping and full lifecycle remain untested`);
      });
    });
  });
});
