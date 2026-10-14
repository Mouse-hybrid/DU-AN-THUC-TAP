// TC-027..031 each provision a tagged QA item on a seeded category/station.
// All created items are disabled in afterEach; the API does not delete menu items.
describe('DES-QA-06 | isolated Menu update and query cases', () => {
  let origin;
  let token;
  let categoryId;
  let stationId;
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
  const search = (query = itemName) => request('GET', `/api/v1/menu?q=${encodeURIComponent(query)}`);
  const available = () => request('GET', '/api/v1/menu?available_only=true');
  const createFixture = (isAvailable = true) => {
    itemName = `DES06-QA-ITEM-${key()}`;
    return request('POST', '/api/v1/menu', {
      name: itemName, price: '31700.00', category_id: categoryId,
      station_id: stationId, is_available: isAvailable,
    }).then((created) => {
      expect(created.status, 'create own QA item').eq(201);
      expect(created.body?.id, 'own QA item ID').to.be.a('string').and.not.be.empty;
      expect(created.body?.name, 'own QA item name').eq(itemName);
      expect(created.body?.is_available, 'initial availability').eq(isAvailable);
      return note(`DES06 item fixture: ${created.body.id}; name ${itemName}; available ${isAvailable}`)
        .then(() => created.body);
    });
  };
  const findOwn = (id) => search().then((response) => {
    expect(response.status, 'GET own QA item by name').eq(200);
    expect(response.body, 'name search results').to.be.an('array');
    const matches = response.body.filter((entry) => entry.id === id);
    expect(matches, 'one own QA item').to.have.length(1);
    return matches[0];
  });

  beforeEach(function () {
    itemName = null;
    token = null;
    return cy.env(['POS_BASE_URL', 'DES06_ADMIN_USERNAME', 'DES06_ADMIN_PASSWORD'], { log: false })
      .then((env) => {
        origin = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
        const username = String(env.DES06_ADMIN_USERNAME ?? '');
        const password = String(env.DES06_ADMIN_PASSWORD ?? '');
        if (!username || !password) {
          return note('DES06 Menu updates PENDING: Supervisor credentials absent; no item created')
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
          return request('GET', '/api/v1/menu/categories?active_only=true');
        }).then((categories) => {
          expect(categories.status, 'active category GET').eq(200);
          expect(categories.body, 'active categories').to.be.an('array');
          categoryId = categories.body.find((entry) => entry.is_active && entry.id)?.id;
          return request('GET', '/api/v1/kitchen/stations');
        }).then((stations) => {
          expect(stations.status, 'station GET').eq(200);
          expect(stations.body, 'station list').to.be.an('array');
          stationId = stations.body.find((entry) => entry.is_active && entry.id)?.id;
          if (!categoryId || !stationId) {
            return note('DES06 Menu updates PENDING: active category/station absent; no item created')
              .then(() => this.skip());
          }
        });
      });
  });

  afterEach(() => {
    if (!itemName || !token) return;
    return search().then((response) => {
      if (response.status !== 200 || !Array.isArray(response.body)) {
        throw new Error(`CLEANUP REQUIRED: item ${itemName}; search HTTP ${response.status}`);
      }
      const matches = response.body.filter((entry) => entry.name === itemName);
      if (!matches.length) return note(`DES06 Menu cleanup: item ${itemName} not found; no disable needed`);
      if (matches.length !== 1 || !matches[0].id) {
        throw new Error(`CLEANUP REQUIRED: item ${itemName}; ${matches.length} exact-name records`);
      }
      const item = matches[0];
      const disable = item.is_available
        ? request('PATCH', `/api/v1/menu/${item.id}`, { is_available: false })
        : cy.wrap({ status: 200, body: item }, { log: false });
      return disable.then((result) => {
        if (result.status !== 200 || result.body?.is_available !== false) {
          throw new Error(`CLEANUP REQUIRED: item ${item.id}; disable HTTP ${result.status}`);
        }
        return available();
      }).then((listed) => {
        if (listed.status !== 200 || !Array.isArray(listed.body) ||
          listed.body.some((entry) => entry.id === item.id)) {
          throw new Error(`CLEANUP REQUIRED: item ${item.id}; available GET HTTP ${listed.status}`);
        }
        return note(`DES06 Menu cleanup: item ${item.id} is_available=false; inactive record remains in staging`);
      });
    });
  });

  it('DES06-TC-027 | update own item price and verify GET', () =>
    createFixture().then((item) =>
      request('PATCH', `/api/v1/menu/${item.id}`, { price: '32700.00' })
        .then((updated) => {
          expect(updated.status, 'price PATCH').eq(200);
          expect(updated.body?.id, 'same item ID').eq(item.id);
          expect(Number(updated.body?.price), 'updated price').eq(32700);
          return findOwn(item.id);
        }).then((persisted) => {
          expect(Number(persisted.price), 'GET persisted price').eq(32700);
          expect(persisted.name, 'name unchanged').eq(itemName);
          return note(`DES06-TC-027 API assertions OK: item ${item.id}; price 31700 -> 32700; audit log requires separate DB evidence; cleanup follows`);
        }))
  );

  it('DES06-TC-028 | disable own item in available-only menu', () =>
    createFixture().then((item) =>
      request('PATCH', `/api/v1/menu/${item.id}`, { is_available: false })
        .then((updated) => {
          expect(updated.status, 'availability PATCH').eq(200);
          expect(updated.body?.is_available, 'disabled response').eq(false);
          return findOwn(item.id);
        }).then((persisted) => {
          expect(persisted.is_available, 'GET disabled state').eq(false);
          return available();
        }).then((listed) => {
          expect(listed.status, 'GET available-only menu').eq(200);
          expect(listed.body, 'available-only menu').to.be.an('array');
          expect(listed.body.some((entry) => entry.id === item.id), 'disabled item hidden').eq(false);
          return note(`DES06-TC-028 assertions OK: item ${item.id}; is_available=false; absent from available-only menu`);
        }))
  );

  it('DES06-TC-029 | unique QA name search returns matching item only', () =>
    createFixture().then((item) => search(itemName.toLowerCase()).then((found) => {
      expect(found.status, 'case-insensitive name search').eq(200);
      expect(found.body, 'name search results').to.be.an('array');
      expect(found.body.filter((entry) => entry.id === item.id), 'QA item returned').to.have.length(1);
      expect(found.body.every((entry) => String(entry.name).toLowerCase().includes(itemName.toLowerCase())),
        'all hits contain the unique name').eq(true);
      expect(found.body, 'unique full-name query has one result').to.have.length(1);
      return note(`DES06-TC-029 assertions OK: item ${item.id}; case-insensitive query matches only tagged QA item; cleanup follows`);
    }))
  );

  it('DES06-TC-030 | category_id filter returns only selected category including QA item', () =>
    createFixture().then((item) =>
      request('GET', `/api/v1/menu?category_id=${encodeURIComponent(categoryId)}`)
        .then((filtered) => {
          expect(filtered.status, 'category filter GET').eq(200);
          expect(filtered.body, 'filtered menu').to.be.an('array');
          expect(filtered.body.some((entry) => entry.id === item.id), 'QA item in category').eq(true);
          expect(filtered.body.every((entry) => entry.category_id === categoryId),
            'all items in requested category').eq(true);
          return note(`DES06-TC-030 assertions OK: item ${item.id}; category ${categoryId}; ${filtered.body.length} item(s), all correctly filtered; cleanup follows`);
        }))
  );

  it('DES06-TC-031 | restore disabled QA item to available-only menu', () =>
    createFixture(false).then((item) => available().then((before) => {
      expect(before.status, 'available menu before restore').eq(200);
      expect(before.body, 'available items before restore').to.be.an('array');
      expect(before.body.some((entry) => entry.id === item.id), 'disabled item absent initially').eq(false);
      return request('PATCH', `/api/v1/menu/${item.id}`, { is_available: true });
    }).then((restored) => {
      expect(restored.status, 'restore PATCH').eq(200);
      expect(restored.body?.is_available, 'restored response').eq(true);
      return available();
    }).then((after) => {
      expect(after.status, 'available menu after restore').eq(200);
      expect(after.body, 'available items after restore').to.be.an('array');
      expect(after.body.some((entry) => entry.id === item.id), 'restored item available').eq(true);
      return note(`DES06-TC-031 assertions OK: item ${item.id}; false -> true and available-only menu includes item; cleanup follows`);
    }))
  );
});
