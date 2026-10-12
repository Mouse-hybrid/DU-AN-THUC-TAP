// TC-011 contract preflight only. No order, menu, or kitchen data is changed.
// A Passed result here does not mean DES05-TC-011 has been executed.
describe('DES-QA-05 | TC-011 invalid modifier contract preflight', () => {
  const resolveSchema = (document, schema) => {
    if (!schema?.$ref) return schema;
    if (!schema.$ref.startsWith('#/')) return null;
    return schema.$ref.slice(2).split('/').reduce(
      (part, key) => part?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document
    );
  };

  it('PF-05 | add-item API documents modifier input', function () {
    cy.env(['POS_BASE_URL']).then((environment) => {
      const origin = String(environment.POS_BASE_URL || 'http://160.191.47.17')
        .replace(/\/+$/, '');

      cy.request({
        method: 'GET',
        url: origin + '/openapi.json',
        failOnStatusCode: false,
        log: false,
        timeout: 20000,
      }).then((response) => {
        expect(response.status, 'GET /openapi.json status').eq(200);
        const document = response.body;
        const request = document?.paths?.['/api/v1/orders/{order_id}/items']?.post;
        expect(request, 'POST add-item operation').to.be.an('object');
        const bodySchema = resolveSchema(
          document, request.requestBody?.content?.['application/json']?.schema
        );
        expect(bodySchema, 'add-item request body schema').to.be.an('object');
        const itemSchema = resolveSchema(document, bodySchema.properties?.items?.items);
        expect(itemSchema, 'add-item line schema').to.be.an('object');

        const fields = Object.keys(itemSchema.properties || {})
          .filter((name) => /modifier/i.test(name));
        if (!fields.length) {
          return cy.task('des05Note',
            'PF-05 PENDING: add-item API has no modifier field; TC-011 cannot run against this contract',
            { log: false }).then(() => this.skip());
        }
        cy.log(`Modifier input documented: ${fields.join(', ')}`);
        cy.log('CONTRACT ONLY: no invalid modifier request or order/queue assertion was run');
      });
    });
  });
});
