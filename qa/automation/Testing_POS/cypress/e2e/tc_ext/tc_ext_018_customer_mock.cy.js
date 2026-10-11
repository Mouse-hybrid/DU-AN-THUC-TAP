// TC_EXT_018 temporary staging MOCK UI acceptance (not API integration acceptance).
// Scoped to the screenshot baseline approved on 2026-10-11.
describe('TC_EXT_018 | Customer mock staging UI baseline',()=>{
  it('renders title, mock label, category count and sample item count',()=>{
    cy.env(['POS_BASE_URL']).then(env=>{
      const base=String(env.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
      cy.visit(base+'/customer');
      cy.contains('h1','Customer menu').should('be.visible');
      cy.contains('MOCK INTERFACE').should('be.visible');
      cy.contains('QR ORDERING MOCK').should('be.visible');
      cy.contains('8 categories').should('be.visible');
      cy.contains('36 sample items').should('be.visible');
      cy.contains('Mock cart').should('be.visible');
      cy.contains('Staging foundation online').should('be.visible');
      cy.contains('Luồng giao diện sẽ được nối sau khi UX được duyệt').should('be.visible');
      cy.screenshot('TC_EXT_018_customer_mock_staging_PASS_evidence');
    });
  });
});
