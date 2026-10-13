// Public, read-only KDS station readiness checks. No JWT and no business testcase is executed.
describe('DES-QA-05 | Kitchen stations route and contract preflight', () => {
  const origin = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const note = (message) => cy.task('des05Note', message, { log: false });

  it('PF-13 | stations route rejects a request without JWT', () => {
    cy.env(['POS_BASE_URL']).then((env) => cy.request({
      method: 'GET',
      url: origin(env.POS_BASE_URL) + '/api/v1/kitchen/stations',
      failOnStatusCode: false,
      log: false,
      timeout: 20000,
    })).then((response) => {
      expect(response.status, 'GET /kitchen/stations without JWT').eq(401);
      return note('PF-13: GET /api/v1/kitchen/stations without JWT returned 401; authenticated station count not checked');
    });
  });

  it('PF-14 | live OpenAPI documents secured station list', () => {
    cy.env(['POS_BASE_URL']).then((env) => cy.request({
      method: 'GET',
      url: origin(env.POS_BASE_URL) + '/openapi.json',
      failOnStatusCode: false,
      log: false,
      timeout: 20000,
    })).then((response) => {
      expect(response.status, 'GET /openapi.json').eq(200);
      const operation = response.body?.paths?.['/api/v1/kitchen/stations']?.get;
      expect(operation, 'GET stations operation').to.be.an('object');
      expect(operation.security, 'stations JWT security').to.deep.include({ HTTPBearer: [] });
      const schema = operation.responses?.['200']?.content?.['application/json']?.schema;
      expect(schema?.type, 'stations response type').eq('array');
      expect(schema?.items?.['$ref'], 'station item schema').eq('#/components/schemas/KitchenStationOut');
      return note('PF-14: live OpenAPI documents secured GET /kitchen/stations and KitchenStationOut[]; routing and station count not checked');
    });
  });
});
