/* Read-only QA fixture diagnostics. No token/password written to disk. */
const keys=['POS_BASE_URL','POS_USERNAME','POS_PASSWORD'];
const entries=b=>Array.isArray(b)?b:(Array.isArray(b?.items)?b.items:(Array.isArray(b?.data)?b.data:(Array.isArray(b?.results)?b.results:(Array.isArray(b?.categories)?b.categories:[]))));
describe('TC_EXT fixture diagnostics (read-only)',()=>{
  it('checks category/menu fixture availability and saves evidence',()=>{
    cy.env(keys).then(env=>{
      const base=(env.POS_BASE_URL||'http://160.191.47.17').replace(/\/$/,'');
      expect(env.POS_USERNAME,'QA username').to.be.a('string').and.not.be.empty;
      expect(env.POS_PASSWORD,'QA password').to.be.a('string').and.not.be.empty;
      cy.request({method:'POST',url:base+'/api/v1/auth/login',body:{username:env.POS_USERNAME,password:env.POS_PASSWORD},failOnStatusCode:false}).then(login=>{
        expect(login.status,'QA login').eq(200);
        const token=login.body.access_token||login.body?.data?.access_token;
        expect(token,'access token').to.be.a('string').and.not.be.empty;
        const h={Authorization:'Bearer '+token};
        cy.request({url:base+'/api/v1/menu/categories',headers:h,failOnStatusCode:false}).then(cat=>{
          expect(cat.status,'GET categories').eq(200);
          cy.request({url:base+'/api/v1/menu',headers:h,failOnStatusCode:false}).then(menu=>{
            expect(menu.status,'GET menu').eq(200);
            const cats=entries(cat.body),items=entries(menu.body);
            const hidden=cats.filter(x=>x.is_active===false);
            const linked=hidden.filter(category=>items.some(item=>String(item.category_id)===String(category.id)));
            const report={
              report_type:'read_only_fixture_diagnostics',
              created_at:new Date().toISOString(),
              categories_count:cats.length,
              inactive_categories_count:hidden.length,
              menu_items_count:items.length,
              inactive_categories_with_menu_items:linked.length,
              tc_ext_003: hidden.length?'fixture present':'inactive category fixture missing',
              tc_ext_004: linked.length?'fixture present':'need a menu item linked to an inactive category',
              available_menu_items_count:items.filter(i=>i.is_available===true).length,
              unavailable_menu_items_count:items.filter(i=>i.is_available===false).length,
              items_with_station_id_count:items.filter(i=>Boolean(i.station_id)).length,
              notes:'No credentials, tokens, or IDs are saved in this evidence.'
            };
            cy.request({url:base+'/api/v1/tables',headers:h,failOnStatusCode:false}).then(tables=>{
              expect(tables.status,'GET tables').eq(200);
              const tableList=entries(tables.body);
              report.available_tables_count=tableList.filter(t=>t.status==='AVAILABLE').length;
              report.occupied_tables_count=tableList.filter(t=>t.status==='OCCUPIED').length;
              report.tc_ext_001=report.available_tables_count?'available table exists; cleanup plan required':'blocked: no AVAILABLE tables';
              report.tc_ext_005='needs isolated menu-item and two chronological QA order fixtures';
              report.tc_ext_006=report.unavailable_menu_items_count?'unavailable item exists; isolated QA order required':'unavailable item fixture missing';
              report.tc_ext_007_008=report.available_menu_items_count?'sellable item exists; isolated NEW QA orders required':'sellable menu-item fixture missing';
              cy.writeFile('evidence/TC_EXT_001_009/fixture-diagnostics.json',report);
            });
            cy.log('TC_EXT_004: '+report.tc_ext_004);
            expect(report).to.have.property('report_type','read_only_fixture_diagnostics');
          });
        });
      });
    });
  });
});
