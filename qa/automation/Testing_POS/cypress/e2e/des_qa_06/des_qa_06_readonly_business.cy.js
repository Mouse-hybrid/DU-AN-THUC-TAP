// DES-QA-06: TC-017 RBAC and seed-data discovery for TC-029/030.
// Business data is read only. Authentication uses POST /auth/login to obtain a JWT.
describe('DES-QA-06 | Kitchen SLA RBAC and Menu query discovery', () => {
  const originFor = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const note = (message) => cy.task('des06Note', message, { log: false });
  const get = (origin, path, token) => cy.request({
    method: 'GET', url: origin + path,
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false, log: false, timeout: 20000,
  });

  const login = (account, expectedRole, context) =>
    cy.env(['POS_BASE_URL', `DES06_${account}_USERNAME`, `DES06_${account}_PASSWORD`], { log: false })
      .then((env) => {
        const username = String(env[`DES06_${account}_USERNAME`] ?? '');
        const password = String(env[`DES06_${account}_PASSWORD`] ?? '');
        if (!username || !password) {
          return note(`${account} credentials absent; check PENDING`).then(() => context.skip());
        }
        const origin = originFor(env.POS_BASE_URL);
        return cy.request({
          method: 'POST', url: origin + '/api/v1/auth/login',
          body: { username, password }, failOnStatusCode: false,
          log: false, timeout: 20000,
        }).then((response) => {
          expect(response.status, `${account} login HTTP`).eq(200);
          expect(response.body?.staff?.role, `${account} account role`).eq(expectedRole);
          const token = response.body?.access_token || response.body?.data?.access_token;
          expect(typeof token === 'string' && token.length > 0, `${account} JWT present`).eq(true);
          return { origin, token };
        });
      });

  it('DES06-TC-017 | Cashier forbidden; Kitchen and Supervisor can view SLA queue', function () {
    login('CASHIER', 'CASHIER', this).then((cashier) => {
      if (!cashier) return;
      return get(cashier.origin, '/api/v1/kitchen/queue', cashier.token).then((denied) => {
        expect(denied.status, 'Cashier GET Kitchen Queue').eq(403);
        return login('KITCHEN', 'KITCHEN', this);
      }).then((kitchen) => {
        if (!kitchen) return;
        return get(kitchen.origin, '/api/v1/kitchen/queue', kitchen.token).then((allowed) => {
          expect(allowed.status, 'Kitchen GET Kitchen Queue').eq(200);
          expect(allowed.body, 'Kitchen queue body').to.be.an('array');
          return login('ADMIN', 'SUPERVISOR', this);
        });
      }).then((supervisor) => {
        if (!supervisor) return;
        return get(supervisor.origin, '/api/v1/kitchen/queue', supervisor.token).then((allowed) => {
          expect(allowed.status, 'Supervisor GET Kitchen Queue').eq(200);
          expect(allowed.body, 'Supervisor queue body').to.be.an('array');
          return note('DES06-TC-017: Cashier 403; Kitchen 200; Supervisor 200 for GET /kitchen/queue; no data changed; KDS UI not checked');
        });
      });
    });
  });

  it('PF-07 | seed menu supports a name query for future TC-029 fixture', function () {
    login('CASHIER', 'CASHIER', this).then((auth) => {
      if (!auth) return;
      return get(auth.origin, '/api/v1/menu', auth.token).then((all) => {
        expect(all.status, 'Menu list').eq(200);
        expect(all.body, 'Menu list body').to.be.an('array');
        const item = all.body.find((candidate) => typeof candidate.name === 'string' && candidate.name.trim());
        if (!item) return note('PF-07 PENDING: seed menu has no named item').then(() => this.skip());
        const query = item.name.trim();
        return get(auth.origin, `/api/v1/menu?q=${encodeURIComponent(query)}`, auth.token)
          .then((searched) => {
            expect(searched.status, 'Menu name query').eq(200);
            expect(searched.body, 'Menu search body').to.be.an('array');
            expect(searched.body.some((found) => found.id === item.id), 'seed item found').eq(true);
            expect(searched.body.every((found) => String(found.name).toLowerCase().includes(query.toLowerCase())),
              'all search hits contain query').eq(true);
            return note(`PF-07: Menu q query HTTP 200; ${searched.body.length} matching seed item(s); TC-029 awaits a tagged QA item`);
          });
      });
    });
  });

  it('PF-08 | seed menu supports category_id for future TC-030 fixture', function () {
    login('CASHIER', 'CASHIER', this).then((auth) => {
      if (!auth) return;
      return get(auth.origin, '/api/v1/menu/categories', auth.token).then((categories) => {
        expect(categories.status, 'Category list').eq(200);
        expect(categories.body, 'Category list body').to.be.an('array');
        return get(auth.origin, '/api/v1/menu', auth.token)
          .then((menu) => ({ categories: categories.body, menu }));
      }).then(({ categories, menu }) => {
        expect(menu.status, 'Menu list').eq(200);
        expect(menu.body, 'Menu list body').to.be.an('array');
        const ids = new Set(categories.map((category) => String(category.id)));
        const item = menu.body.find((candidate) => candidate.category_id && ids.has(String(candidate.category_id)));
        if (!item) return note('PF-08 PENDING: no seeded item with a listed category').then(() => this.skip());
        return get(auth.origin, `/api/v1/menu?category_id=${encodeURIComponent(item.category_id)}`, auth.token)
          .then((filtered) => {
            expect(filtered.status, 'Menu category filter').eq(200);
            expect(filtered.body, 'Filtered menu body').to.be.an('array');
            expect(filtered.body.some((found) => found.id === item.id), 'seed item in its category').eq(true);
            expect(filtered.body.every((found) => String(found.category_id) === String(item.category_id)),
              'all hits in requested category').eq(true);
            return note(`PF-08: Menu category_id filter HTTP 200; ${filtered.body.length} matching seed item(s); TC-030 awaits an isolated QA item`);
          });
      });
    });
  });
});
