// Read-only contract audit for TC-034..036. PF results never mark business cases Passed.
describe('DES-QA-06 | Menu contract readiness for TC-034..036', () => {
  let doc;
  const note = (message) => cy.task('des06Note', message, { log: false });

  before(() => cy.env(['POS_BASE_URL'], { log: false }).then(({ POS_BASE_URL }) => {
    const origin = String(POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
    return cy.request({
      method: 'GET', url: origin + '/openapi.json', failOnStatusCode: false,
      log: false, timeout: 20000,
    }).then((response) => {
      expect(response.status, 'live OpenAPI GET').eq(200);
      expect(response.body?.paths, 'OpenAPI paths').to.be.an('object');
      doc = response.body;
      return cy.request({
        method: 'GET', url: origin + '/version', failOnStatusCode: false,
        log: false, timeout: 20000,
      });
    }).then((version) => {
      expect(version.status, 'staging version GET').eq(200);
      return note(`Contract audit staging commit ${String(version.body?.short_commit || version.body?.commit || 'unknown').slice(0, 12)}`);
    });
  }));

  it('PF-10 | TC-034 price update version-precondition readiness', () => {
    const operation = doc.paths?.['/api/v1/menu/{item_id}']?.patch;
    expect(operation, 'PATCH menu item documented').to.exist;
    const parameters = (operation.parameters || []).map((parameter) => parameter.name?.toLowerCase());
    const bodyRef = operation.requestBody?.content?.['application/json']?.schema?.$ref;
    const bodyType = bodyRef?.split('/').pop();
    const fields = Object.keys(doc.components?.schemas?.[bodyType]?.properties || {});
    const hasVersion = parameters.some((name) => ['if-match', 'version', 'current_version'].includes(name)) ||
      fields.some((name) => ['version', 'current_version', 'expected_version'].includes(name));
    return note(hasVersion
      ? 'PF-10 READY: PATCH /menu/{item_id} documents a version precondition; TC-034 concurrency still untested'
      : 'PF-10 BLOCKED: PATCH /menu/{item_id} documents no version precondition; TC-034 conflict policy not specified');
  });

  it('PF-11 | TC-035 category DELETE readiness', () => {
    const category = doc.paths?.['/api/v1/menu/categories/{category_id}'];
    expect(category?.patch, 'PATCH category documented').to.exist;
    return note(category.delete
      ? 'PF-11 READY: DELETE /menu/categories/{category_id} documented; TC-035 reference behavior still untested'
      : 'PF-11 BLOCKED: no DELETE /menu/categories/{category_id}; TC-035 cannot execute through current API');
  });

  it('PF-12 | TC-036 menu pagination and sorting readiness', () => {
    const operation = doc.paths?.['/api/v1/menu']?.get;
    expect(operation, 'GET menu documented').to.exist;
    const parameters = (operation.parameters || []).map((parameter) => parameter.name?.toLowerCase());
    const hasPage = parameters.some((name) => ['limit', 'offset', 'page', 'page_size', 'per_page', 'cursor'].includes(name));
    const hasSort = parameters.some((name) => ['sort', 'sort_by', 'order', 'order_by'].includes(name));
    return note(hasPage && hasSort
      ? 'PF-12 READY: GET /menu documents pagination and sorting; TC-036 page behavior still untested'
      : `PF-12 BLOCKED: GET /menu pagination=${hasPage}, sorting=${hasSort}; TC-036 cannot verify requested page boundaries`);
  });
});
