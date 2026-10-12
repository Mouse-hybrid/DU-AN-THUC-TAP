// PF-08 checks whether an Expeditor-only action is documented for DES05-TC-018.
// It only reads OpenAPI; no unauthorized action or state assertion is performed.
describe('DES-QA-05 | TC-018 Expeditor RBAC contract preflight', () => {
  const note = (message) => cy.task('des05Note', message, { log: false });
  const pending = (message, context) => note(message)
    .then(() => cy.log(`${message} (video evidence pause: 3 seconds)`).wait(3000, { log: false }))
    .then(() => context.skip());

  it('PF-08 | OpenAPI documents an Expeditor action for RBAC testing', function () {
    cy.env(['POS_BASE_URL']).then((e) => {
      const origin = String(e.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      cy.request({
        method: 'GET',
        url: origin + '/openapi.json',
        failOnStatusCode: false,
        log: false,
        timeout: 20000,
      }).then((response) => {
        expect(response.status, 'GET staging OpenAPI').eq(200);
        expect(response.body?.paths, 'OpenAPI paths').to.be.an('object');
        const actions = Object.entries(response.body.paths).flatMap(([path, operations]) =>
          Object.entries(operations)
            .filter(([method, operation]) =>
              ['post', 'put', 'patch', 'delete'].includes(method) &&
              /expeditor/i.test([
                path,
                operation?.operationId,
                ...(operation?.tags || []),
              ].join(' ')))
            .map(([method]) => `${method.toUpperCase()} ${path}`)
        );

        if (!actions.length) {
          return pending('PF-08 PENDING: OpenAPI has no documented Expeditor action; TC-018 endpoint remains TBD', this);
        }
        cy.log(`Expeditor action candidates: ${actions.join(', ')}`);
        return note(`PF-08: OpenAPI documents ${actions.length} Expeditor action candidate(s); TC-018 Cashier/Customer RBAC and no-mutation assertions remain untested`);
      });
    });
  });
});
