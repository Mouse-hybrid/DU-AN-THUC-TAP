// TC-018 creates one uniquely named QA category and archives it after the test.
// The API does not expose category DELETE: archived records remain in staging.
describe('DES-QA-06 | TC-018 create isolated QA category', () => {
  let origin;
  let token;
  let categoryName;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des06Note', message, { log: false });
  const request = (method, path, body) => cy.request({
    method, url: origin + path, failOnStatusCode: false, log: false, timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'Idempotency-Key': key() } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });

  beforeEach(function () {
    categoryName = null;
    token = null;
    return cy.env(['POS_BASE_URL', 'DES06_ADMIN_USERNAME', 'DES06_ADMIN_PASSWORD'], { log: false })
      .then((env) => {
        origin = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
        const username = String(env.DES06_ADMIN_USERNAME ?? '');
        const password = String(env.DES06_ADMIN_PASSWORD ?? '');
        if (!username || !password) {
          return note('DES06-TC-018 PENDING: admin credentials absent; no category created')
            .then(() => this.skip());
        }
        return cy.request({
          method: 'POST', url: origin + '/api/v1/auth/login', body: { username, password },
          failOnStatusCode: false, log: false, timeout: 20000,
        }).then((login) => {
          expect(login.status, 'admin login').eq(200);
          expect(login.body?.staff?.role, 'admin is Supervisor').eq('SUPERVISOR');
          token = login.body?.access_token;
          expect(typeof token === 'string' && token.length > 0, 'Supervisor JWT present').eq(true);
        });
      });
  });

  afterEach(() => {
    if (!categoryName || !token) return;
    return request('GET', '/api/v1/menu/categories').then((listed) => {
      if (listed.status !== 200 || !Array.isArray(listed.body)) {
        throw new Error(`CLEANUP REQUIRED: category ${categoryName}; list HTTP ${listed.status}`);
      }
      const matches = listed.body.filter((category) => category.name === categoryName);
      if (!matches.length) return note(`DES06-TC-018 cleanup: category ${categoryName} not found; no archive needed`);
      if (matches.length !== 1 || !matches[0].id) {
        throw new Error(`CLEANUP REQUIRED: category ${categoryName}; ${matches.length} matching records`);
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
          throw new Error(`CLEANUP REQUIRED: category ${category.id}; active list HTTP ${active.status}`);
        }
        return note(`DES06-TC-018 archive: category ${category.id} is_active=false; absent from active list; inactive record remains in staging`);
      });
    });
  });

  it('DES06-TC-018 | Supervisor creates a valid QA category', () => {
    categoryName = `DES06-QA-${key()}`;
    const payload = { name: categoryName, sort_order: 9000, is_active: true };
    return request('GET', '/api/v1/menu/categories').then((before) => {
      expect(before.status, 'category list before create').eq(200);
      expect(before.body, 'category list before create').to.be.an('array');
      expect(before.body.some((entry) => entry.name === categoryName), 'unique QA name').eq(false);
      return request('POST', '/api/v1/menu/categories', payload);
    }).then((created) => {
      expect(created.status, 'create category HTTP').eq(201);
      expect(created.body?.id, 'new category ID').to.be.a('string').and.not.be.empty;
      expect(created.body?.name, 'persisted category name').eq(payload.name);
      expect(created.body?.sort_order, 'persisted sort_order').eq(payload.sort_order);
      expect(created.body?.is_active, 'new category is active').eq(true);
      return request('GET', '/api/v1/menu/categories').then((listed) => ({ created: created.body, listed }));
    }).then(({ created, listed }) => {
      expect(listed.status, 'category list after create').eq(200);
      expect(listed.body, 'category list after create').to.be.an('array');
      const matches = listed.body.filter((entry) => entry.id === created.id);
      expect(matches, 'exactly one QA category persisted').to.have.length(1);
      expect(matches[0].name, 'GET category name').eq(payload.name);
      expect(matches[0].sort_order, 'GET category sort_order').eq(payload.sort_order);
      expect(matches[0].is_active, 'GET category active').eq(true);
      return note(`DES06-TC-018 assertions OK: category ${created.id}; name ${categoryName}; POST 201 and GET persisted; archive follows`);
    });
  });
});
