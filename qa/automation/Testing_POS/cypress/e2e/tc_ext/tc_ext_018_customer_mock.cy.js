// TC_EXT_018 temporary STAGING MOCK UI baseline; not API integration acceptance.
// This spec captures the actual text to distinguish selector mismatch from changed staging UI.
describe('TC_EXT_018 | Customer mock staging UI baseline',()=>{
  it('renders the agreed mock title and summary counts',()=>{
    cy.env(['POS_BASE_URL']).then(env=>{
      const base=String(env.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
      cy.visit(base+'/customer');
      cy.document().then(doc=>{
        const raw=(doc.body?.innerText||'').replace(/\s+/g,' ').trim();
        cy.log('Observed page title: '+doc.title);
        cy.log('Observed body excerpt: '+raw.slice(0,500));
      });
      cy.contains('h1',/Customer\s+menu/i).should('be.visible');
      // Exact casing can differ between the HTML and CSS text-transform.
      // Match content case-insensitively; do not omit required indicators.
      cy.contains(/mock\s+interface/i).should('be.visible');
      cy.contains(/qr\s+ordering\s+mock/i).should('be.visible');
      cy.contains(/8\s+categories/i).should('be.visible');
      cy.contains(/36\s+sample\s+items/i).should('be.visible');
      cy.contains(/mock\s+cart/i).should('be.visible');
      cy.contains(/staging\s+foundation\s+online/i).should('be.visible');
      cy.contains(/Luồng\s+giao\s+diện\s+sẽ\s+được\s+nối\s+sau\s+khi\s+UX\s+được\s+duyệt/i).should('be.visible');
      cy.screenshot('TC_EXT_018_customer_mock_baseline');
    });
  });
});
