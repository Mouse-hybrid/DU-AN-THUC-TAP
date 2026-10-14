// TC-022 creates one QA item using an existing active category and station.
// The API has no menu item DELETE; the item is disabled after verification.
describe('DES-QA-06 | TC-022 create isolated QA menu item', () => {
  let origin;
  let token;
  let itemName;

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
  const search = () => request('GET', `/api/v1/menu?q=${encodeURIComponent(itemName)}`);

  beforeEach(function () {
    itemName = null;
    token = null;
    return cy.env(['POS_BASE_URL', 'DES06_ADMIN_USERNAME', 'DES06_ADMIN_PASSWORD'], { log: false })
      .then((env) => {
        origin = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
        const username = String(env.DES06_ADMIN_USERNAME ?? '');
        const password = String(env.DES06_ADMIN_PASSWORD ?? '');
        if (!username || !password) {
          return note('DES06-TC-022 PENDING: Supervisor credentials absent; no item created')
            .then(() => this.skip());
        }
        return cy.request({
          method: 'POST', url: origin + '/api/v1/auth/login', body: { username, password },
          failOnStatusCode: false, log: false, timeout: 20000,
        }).then((login) => {
          expect(login.status, 'Supervisor login').eq(200);
          expect(login.body?.staff?.role, 'Supervisor role').eq('SUPERVISOR');
          token = login.body?.access_token;
          expect(typeof token === 'string' && token.length > 0, 'Supervisor JWT present').eq(true);
        });
      });
  });

  afterEach(() => {
    if (!itemName || !token) return;
    return search().then((listed) => {
      if (listed.status !== 200 || !Array.isArray(listed.body)) {
        throw new Error(`CLEANUP REQUIRED: item ${itemName}; search HTTP ${listed.status}`);
      }
      const matches = listed.body.filter((item) => item.name === itemName);
      if (!matches.length) return note(`DES06-TC-022 cleanup: item ${itemName} not found; no disable needed`);
      if (matches.length !== 1 || !matches[0].id) {
        throw new Error(`CLEANUP REQUIRED: item ${itemName}; ${matches.length} exact-name records`);
      }
      const item = matches[0];
      const disable = item.is_available
        ? request('PATCH', `/api/v1/menu/${item.id}`, { is_available: false })
        : cy.wrap({ status: 200, body: item }, { log: false });
      return disable.then((response) => {
        if (response.status !== 200 || response.body?.is_available !== false) {
          throw new Error(`CLEANUP REQUIRED: item ${item.id}; disable HTTP ${response.status}`);
        }
        return request('GET', '/api/v1/menu?available_only=true');
      }).then((available) => {
        if (available.status !== 200 || !Array.isArray(available.body) ||
          available.body.some((entry) => entry.id === item.id)) {
          throw new Error(`CLEANUP REQUIRED: item ${item.id}; available GET HTTP ${available.status}`);
        }
        return note(`DES06-TC-022 cleanup: item ${item.id} is_available=false; absent from available menu; inactive record remains in staging`);
      });
    });
  });

  it('DES06-TC-022 | Supervisor creates QA item with category, station and price', function () {
    return request('GET', '/api/v1/menu/categories?active_only=true').then((categories) => {
      expect(categories.status, 'active category GET').eq(200);
      expect(categories.body, 'active categories').to.be.an('array');
      return request('GET', '/api/v1/kitchen/stations')
        .then((stations) => ({ categories: categories.body, stations }));
    }).then(({ categories, stations }) => {
      expect(stations.status, 'station GET').eq(200);
      expect(stations.body, 'station list').to.be.an('array');
      const category = categories.find((entry) => entry.is_active && entry.id);
      const station = stations.body.find((entry) => entry.is_active && entry.id);
      if (!category || !station) {
        return note('DES06-TC-022 PENDING: active category or station absent; no item created')
          .then(() => this.skip());
      }
      itemName = `DES06-QA-ITEM-${key()}`;
      const payload = {
        name: itemName, price: '31700.00', category_id: category.id,
        station_id: station.id, is_available: true,
      };
      return search().then((before) => {
        expect(before.status, 'QA item search before create').eq(200);
        expect(before.body, 'QA item search before create').to.be.an('array');
        expect(before.body.some((entry) => entry.name === itemName), 'unique QA item name').eq(false);
        return request('POST', '/api/v1/menu', payload);
      }).then((created) => {
        expect(created.status, 'create menu item').eq(201);
        expect(created.body?.id, 'new menu item ID').to.be.a('string').and.not.be.empty;
        expect(created.body?.name, 'created name').eq(itemName);
        expect(Number(created.body?.price), 'created price').eq(31700);
        expect(created.body?.category_id, 'created category').eq(category.id);
        expect(created.body?.station_id, 'created station').eq(station.id);
        expect(created.body?.is_available, 'created availability').eq(true);
        return search().then((listed) => ({ created: created.body, listed }));
      }).then(({ created, listed }) => {
        expect(listed.status, 'QA item GET after create').eq(200);
        expect(listed.body, 'QA item search').to.be.an('array');
        const matches = listed.body.filter((entry) => entry.id === created.id);
        expect(matches, 'one persisted QA item').to.have.length(1);
        expect(matches[0].name, 'persisted name').eq(itemName);
        expect(Number(matches[0].price), 'persisted price').eq(31700);
        expect(matches[0].category_id, 'persisted category').eq(category.id);
        expect(matches[0].station_id, 'persisted station').eq(station.id);
        return note(`DES06-TC-022 assertions OK: item ${created.id}; category ${category.id}; station ${station.id}; price 31700; disable follows`);
      });
    });
  });
});
