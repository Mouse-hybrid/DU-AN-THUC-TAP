// TC-019 checks a duplicate against a seeded category without creating data.
// TC-020/021 use separate QA categories, then archive them in afterEach.
describe('DES-QA-06 | category duplicate and update cases', () => {
  let origin;
  let token;
  let categoryName;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des06Note', message, { log: false });
  const request = (method, path, body) => cy.request({
    method, url: origin + path, log: false, failOnStatusCode: false, timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'Idempotency-Key': key() } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  const list = () => request('GET', '/api/v1/menu/categories').then((response) => {
    expect(response.status, 'GET all categories').eq(200);
    expect(response.body, 'categories').to.be.an('array');
    return response.body;
  });
  const createFixture = () => {
    categoryName = `DES06-QA-${key()}`;
    return request('POST', '/api/v1/menu/categories', {
      name: categoryName, sort_order: 9000, is_active: true,
    }).then((created) => {
      expect(created.status, 'create own QA category').eq(201);
      expect(created.body?.id, 'own category ID').to.be.a('string').and.not.be.empty;
      expect(created.body?.name, 'own category name').eq(categoryName);
      return note(`DES06 category fixture: ${created.body.id}; name ${categoryName}`)
        .then(() => created.body);
    });
  };

  beforeEach(function () {
    categoryName = null;
    token = null;
    return cy.env(['POS_BASE_URL', 'DES06_ADMIN_USERNAME', 'DES06_ADMIN_PASSWORD'], { log: false })
      .then((env) => {
        origin = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
        const username = String(env.DES06_ADMIN_USERNAME ?? '');
        const password = String(env.DES06_ADMIN_PASSWORD ?? '');
        if (!username || !password) {
          return note('DES06 category cases PENDING: admin credentials absent; no mutation')
            .then(() => this.skip());
        }
        return cy.request({
          method: 'POST', url: origin + '/api/v1/auth/login', body: { username, password },
          failOnStatusCode: false, log: false, timeout: 20000,
        }).then((login) => {
          expect(login.status, 'admin login').eq(200);
          expect(login.body?.staff?.role, 'Supervisor role').eq('SUPERVISOR');
          token = login.body?.access_token;
          expect(typeof token === 'string' && token.length > 0, 'Supervisor JWT present').eq(true);
        });
      });
  });

  afterEach(() => {
    if (!categoryName || !token) return;
    return request('GET', '/api/v1/menu/categories').then((listed) => {
      if (listed.status !== 200 || !Array.isArray(listed.body)) {
        throw new Error(`CLEANUP REQUIRED: ${categoryName}; list HTTP ${listed.status}`);
      }
      const matches = listed.body.filter((category) => category.name === categoryName);
      if (!matches.length) return note(`DES06 cleanup: ${categoryName} not found; no archive needed`);
      if (matches.length !== 1 || !matches[0].id) {
        throw new Error(`CLEANUP REQUIRED: ${categoryName}; ${matches.length} records`);
      }
      const category = matches[0];
      const archive = category.is_active
        ? request('PATCH', `/api/v1/menu/categories/${category.id}`, { is_active: false })
        : cy.wrap({ status: 200, body: category }, { log: false });
      return archive.then((response) => {
        if (response.status !== 200 || response.body?.is_active !== false) {
          throw new Error(`CLEANUP REQUIRED: category ${category.id}; archive HTTP ${response.status}`);
        }
        return request('GET', '/api/v1/menu/categories?active_only=true');
      }).then((active) => {
        if (active.status !== 200 || !Array.isArray(active.body) ||
          active.body.some((entry) => entry.id === category.id)) {
          throw new Error(`CLEANUP REQUIRED: category ${category.id}; active GET HTTP ${active.status}`);
        }
        return note(`DES06 archive: category ${category.id} is_active=false; inactive record remains in staging`);
      });
    });
  });

  it('DES06-TC-019 | duplicate category name returns 409 without a second record', function () {
    return request('GET', '/api/v1/menu/categories?active_only=true').then((response) => {
      expect(response.status, 'active categories').eq(200);
      expect(response.body, 'active category list').to.be.an('array');
      const source = response.body.find((category) =>
        category.is_active === true && category.name && !category.name.startsWith('DES06-QA-'));
      if (!source) return note('DES06-TC-019 PENDING: no suitable active category; no mutation')
        .then(() => this.skip());
      return list().then((before) => {
        const original = before.filter((entry) => entry.name === source.name);
        expect(original, 'one existing category with the tested name').to.have.length(1);
        return request('POST', '/api/v1/menu/categories', {
          name: source.name, sort_order: source.sort_order, is_active: true,
        }).then((duplicate) => ({ duplicate, before, source }));
      });
    }).then((result) => {
      if (!result) return;
      const { duplicate, before, source } = result;
      expect(duplicate.status, 'same-name POST with new Idempotency-Key').eq(409);
      return list().then((after) => {
        expect(after.map((entry) => entry.id).sort(), 'category IDs unchanged').to.deep.eq(
          before.map((entry) => entry.id).sort());
        expect(after.filter((entry) => entry.name === source.name), 'no unintended duplicate').to.have.length(1);
        return note(`DES06-TC-019 assertions OK: existing category ${source.id}; duplicate HTTP 409; category IDs unchanged`);
      });
    });
  });

  it('DES06-TC-020 | update own category sort_order and verify GET', () =>
    createFixture().then((category) =>
      request('PATCH', `/api/v1/menu/categories/${category.id}`, { sort_order: 9001 })
        .then((updated) => {
          expect(updated.status, 'sort_order PATCH').eq(200);
          expect(updated.body?.id, 'same category').eq(category.id);
          expect(updated.body?.sort_order, 'updated sort_order response').eq(9001);
          return list();
        }).then((categories) => {
          const persisted = categories.find((entry) => entry.id === category.id);
          expect(persisted, 'QA category persisted').to.exist;
          expect(persisted.sort_order, 'GET sort_order after PATCH').eq(9001);
          expect(persisted.name, 'QA category name unchanged').eq(categoryName);
          return note(`DES06-TC-020 assertions OK: category ${category.id}; sort_order 9000 -> 9001; archive follows`);
        }))
  );

  it('DES06-TC-021 | empty PATCH returns 422 and leaves own category unchanged', () =>
    createFixture().then((category) =>
      list().then((before) => {
        const original = before.find((entry) => entry.id === category.id);
        expect(original, 'QA category exists').to.exist;
        return request('PATCH', `/api/v1/menu/categories/${category.id}`, {})
          .then((rejected) => ({ rejected, original }));
      }).then(({ rejected, original }) => {
        expect(rejected.status, 'empty category PATCH').eq(422);
        return list().then((after) => {
          expect(after.find((entry) => entry.id === category.id), 'category unchanged after rejection')
            .to.deep.eq(original);
          return note(`DES06-TC-021 assertions OK: category ${category.id}; empty PATCH 422, GET unchanged; archive follows`);
        });
      }))
  );
});
