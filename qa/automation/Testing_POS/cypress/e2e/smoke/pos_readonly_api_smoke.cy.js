// Read-only POS API smoke tests. No table/order/menu mutations.
// Cypress 16: sensitive variables are accessed via cy.env().
describe('POS staging | Read-only API smoke', () => {
  let env={}, token='';
  const url = p => String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/$/,'') + '/api/v1' + p;
  const get = (p, authorized=true) => cy.request({
    method:'GET',url:url(p),headers:authorized ? {Authorization:'Bearer '+token}: {},
    failOnStatusCode:false
  });
  const list = b => Array.isArray(b) ? b :
    ['items','data','results','categories','tables','menu_items'].reduce(
      (found,k)=>found || (Array.isArray(b?.[k]) ? b[k]:null),null
    );
  before(() => {
    cy.env(['POS_BASE_URL','POS_USERNAME','POS_PASSWORD']).then(values=>{
      env=values;
      expect(env.POS_USERNAME,'POS_USERNAME set').to.be.a('string').and.not.be.empty;
      expect(env.POS_PASSWORD,'POS_PASSWORD set').to.be.a('string').and.not.be.empty;
      cy.request({
        method:'POST',url:url('/auth/login'),
        body:{username:env.POS_USERNAME,password:env.POS_PASSWORD},
        failOnStatusCode:false
      }).then(response=>{
        expect(response.status,'staging login').eq(200);
        token=response.body.access_token || response.body?.data?.access_token;
        expect(token,'JWT').to.be.a('string').and.not.be.empty;
      });
    });
  });
  it('SMOKE_AUTH_001 | unauthenticated table list is blocked',()=>{
    get('/tables',false).then(r=>expect(r.status).eq(401));
  });
  it('SMOKE_TABLE_001 | authenticated tables have valid IDs/statuses',()=>{
    get('/tables').then(r=>{
      expect(r.status).eq(200);
      const tables=list(r.body);
      expect(tables,'table collection').to.be.an('array');
      expect(tables.length,'at least one staging table').to.be.greaterThan(0);
      tables.forEach(t=>{
        expect(t.id,'table id').to.exist;
        expect(t.status,'table status').to.be.oneOf(['AVAILABLE','OCCUPIED','CLEANING','RESERVED','OUT_OF_SERVICE']);
      });
    });
  });
  it('SMOKE_MENU_001 | menu catalogue is readable',()=>{
    get('/menu').then(r=>{
      expect(r.status).eq(200);
      const items=list(r.body);
      expect(items,'menu collection').to.be.an('array');
      expect(items.length,'menu fixtures').to.be.greaterThan(0);
      items.forEach(i=>{
        expect(i.id,'menu item id').to.exist;
        expect(i.category_id,'menu category id').to.exist;
      });
    });
  });
  it('SMOKE_CATEGORY_001 | active category filter has no inactive entries',()=>{
    get('/menu/categories?active_only=true').then(r=>{
      expect(r.status).eq(200);
      const cats=list(r.body);
      expect(cats,'categories collection').to.be.an('array');
      cats.forEach(c=>expect(c.is_active,'active-only flag').eq(true));
    });
  });
});
