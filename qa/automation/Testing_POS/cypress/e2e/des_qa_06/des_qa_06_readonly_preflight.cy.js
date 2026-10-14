// DES-QA-06 preflight. Business-data requests use GET; POST is used only to obtain a JWT.
// Passing a PF check never marks any of the 37 DES06 business testcases as Passed.
describe('DES-QA-06 | SLA and Menu read-only preflight', () => {
  const originFor = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const note = (message) => cy.task('des06Note', message, { log: false });
  const get = (origin, path, token) => cy.request({
    method: 'GET',
    url: origin + path,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    failOnStatusCode: false,
    log: false,
    timeout: 20000,
  });
  const withRole = (role, context) => {
    const prefix = `DES06_${role}`;
    return cy.env(['POS_BASE_URL', `${prefix}_USERNAME`, `${prefix}_PASSWORD`], { log: false })
      .then((env) => {
        const origin = originFor(env.POS_BASE_URL);
        const username = String(env[`${prefix}_USERNAME`] ?? '');
        const password = String(env[`${prefix}_PASSWORD`] ?? '');
        if (!username || !password) {
          return note(`${role} credentials missing; authenticated preflight PENDING`)
            .then(() => context.skip());
        }
        return cy.request({
          method: 'POST',
          url: origin + '/api/v1/auth/login',
          body: { username, password },
          failOnStatusCode: false,
          log: false,
          timeout: 20000,
        }).then((response) => {
          expect(response.status, `${role} login HTTP`).eq(200);
          expect(response.body?.staff?.role === role, `${role} account role`).eq(true);
          const token = response.body?.access_token || response.body?.data?.access_token;
          expect(typeof token === 'string' && token.length > 0, `${role} JWT present`).eq(true);
          return { origin, token };
        });
      });
  };

  it('PF-01 | health and version identify the staging build', () => {
    cy.env(['POS_BASE_URL'], { log: false }).then(({ POS_BASE_URL }) => {
      const origin = originFor(POS_BASE_URL);
      return get(origin, '/health').then((health) => {
        expect(health.status, 'GET /health').eq(200);
        expect(health.body?.status, 'health status').eq('ok');
        return get(origin, '/version');
      }).then((version) => {
        expect(version.status, 'GET /version').eq(200);
        expect(typeof version.body?.commit === 'string' && version.body.commit.length > 0,
          'staging commit present').eq(true);
        return note(`PF-01: health HTTP 200; staging commit ${String(version.body.short_commit || version.body.commit).slice(0, 12)}`);
      });
    });
  });

  it('PF-02 | live OpenAPI documents the read-only SLA and Menu contract', () => {
    cy.env(['POS_BASE_URL'], { log: false }).then(({ POS_BASE_URL }) =>
      get(originFor(POS_BASE_URL), '/openapi.json').then((response) => {
        expect(response.status, 'GET /openapi.json').eq(200);
        const doc = response.body;
        for (const path of ['/api/v1/menu', '/api/v1/menu/categories', '/api/v1/kitchen/queue']) {
          const operation = doc?.paths?.[path]?.get;
          expect(Boolean(operation), `GET ${path} documented`).eq(true);
          expect(Boolean(operation.security?.length), `GET ${path} requires JWT`).eq(true);
          expect(operation.responses?.['200']?.content?.['application/json']?.schema?.type,
            `GET ${path} returns array`).eq('array');
        }
        const menuParams = doc.paths['/api/v1/menu'].get.parameters.map((parameter) => parameter.name);
        const queueParams = doc.paths['/api/v1/kitchen/queue'].get.parameters.map((parameter) => parameter.name);
        for (const name of ['q', 'category_id', 'available_only']) {
          expect(menuParams.includes(name), `Menu parameter ${name}`).eq(true);
        }
        for (const name of ['status', 'station_id', 'delayed_only']) {
          expect(queueParams.includes(name), `Queue parameter ${name}`).eq(true);
        }
        const fields = doc.components?.schemas?.KitchenQueueEntryOut?.properties || {};
        for (const name of ['started_at', 'elapsed_minutes', 'sla_status']) {
          expect(Boolean(fields[name]), `Queue field ${name}`).eq(true);
        }
        return note('PF-02: OpenAPI HTTP 200; secured Menu/Categories/Queue GET and SLA fields documented; no SLA boundary executed');
      })
    );
  });

  it('PF-03 | Cashier can read active categories and available menu', function () {
    withRole('CASHIER', this).then((auth) => {
      if (!auth) return;
      return get(auth.origin, '/api/v1/menu/categories?active_only=true', auth.token)
        .then((categories) => {
          expect(categories.status, 'GET active categories').eq(200);
          expect(categories.body, 'categories').to.be.an('array');
          expect(categories.body.every((category) => category.is_active === true),
            'active_only categories').eq(true);
          return get(auth.origin, '/api/v1/menu?available_only=true', auth.token)
            .then((menu) => ({ categories: categories.body, menu }));
        }).then(({ categories, menu }) => {
          expect(menu.status, 'GET available menu').eq(200);
          expect(menu.body, 'menu items').to.be.an('array');
          expect(menu.body.every((item) => item.is_available === true),
            'available_only menu items').eq(true);
          if (!categories.length || !menu.body.length) {
            return note(`PF-03 PENDING: categories ${categories.length}; available items ${menu.body.length}; no fixture candidates`)
              .then(() => this.skip());
          }
          const categoryIds = categories.map((category) => String(category.id));
          const menuIds = menu.body.map((item) => String(item.id));
          expect(new Set(categoryIds).size, 'unique category IDs').eq(categoryIds.length);
          expect(new Set(menuIds).size, 'unique menu item IDs').eq(menuIds.length);
          return note(`PF-03: Cashier GET HTTP 200; active categories ${categories.length}; available items ${menu.body.length}; no CRUD executed`);
        });
    });
  });

  it('PF-04 | Kitchen can read Queue and filter IN_PROGRESS', function () {
    withRole('KITCHEN', this).then((auth) => {
      if (!auth) return;
      return get(auth.origin, '/api/v1/kitchen/queue', auth.token).then((queue) => {
        expect(queue.status, 'GET active Queue').eq(200);
        expect(queue.body, 'active Queue entries').to.be.an('array');
        return get(auth.origin, '/api/v1/kitchen/queue?status=IN_PROGRESS', auth.token)
          .then((cooking) => ({ active: queue.body, cooking }));
      }).then(({ active, cooking }) => {
        expect(cooking.status, 'GET IN_PROGRESS Queue').eq(200);
        expect(cooking.body, 'IN_PROGRESS entries').to.be.an('array');
        expect(cooking.body.every((entry) => entry.status === 'IN_PROGRESS'),
          'Queue status filter').eq(true);
        for (const entry of cooking.body) {
          expect(Number.isFinite(Date.parse(entry.started_at)), 'IN_PROGRESS started_at').eq(true);
          expect(typeof entry.elapsed_minutes === 'number' && entry.elapsed_minutes >= 0,
            'IN_PROGRESS elapsed_minutes').eq(true);
          expect(['NORMAL', 'WARNING', 'DELAYED', 'CRITICAL'].includes(entry.sla_status),
            'IN_PROGRESS sla_status').eq(true);
        }
        return note(`PF-04: Kitchen Queue HTTP 200; active entries ${active.length}; IN_PROGRESS ${cooking.body.length}; no timer boundary asserted`);
      });
    });
  });

  it('PF-05 | delayed_only Queue contains only delayed cooking tickets', function () {
    withRole('KITCHEN', this).then((auth) => {
      if (!auth) return;
      return get(auth.origin, '/api/v1/kitchen/queue?delayed_only=true', auth.token)
        .then((response) => {
          expect(response.status, 'GET delayed Queue').eq(200);
          expect(response.body, 'delayed Queue entries').to.be.an('array');
          for (const entry of response.body) {
            expect(entry.status, 'delayed ticket state').eq('IN_PROGRESS');
            expect(['DELAYED', 'CRITICAL'].includes(entry.sla_status), 'delayed severity').eq(true);
            expect(typeof entry.elapsed_minutes === 'number' && entry.elapsed_minutes >= 12,
              'delayed elapsed_minutes').eq(true);
          }
          const observed = response.body.length ? 'observed' : 'no delayed ticket available';
          return note(`PF-05: delayed_only HTTP 200; entries ${response.body.length} (${observed}); exact 8/12/15-minute boundaries untested`);
        });
    });
  });

  it('PF-06 | business GET endpoints reject a missing JWT', () => {
    cy.env(['POS_BASE_URL'], { log: false }).then(({ POS_BASE_URL }) => {
      const origin = originFor(POS_BASE_URL);
      return cy.wrap(['/api/v1/menu', '/api/v1/menu/categories', '/api/v1/kitchen/queue'], { log: false })
        .each((path) => get(origin, path).then((response) => {
          expect(response.status, `GET ${path} without JWT`).eq(401);
        }))
        .then(() => note('PF-06: Menu/Categories/Queue GET without JWT returned 401; no business mutation executed'));
    });
  });
});
