// TC-023..026 reject invalid or unauthorized item creation.
// If a named QA item unexpectedly gets created, afterEach disables only that item.
describe('DES-QA-06 | negative menu item creation', () => {
  let origin;
  let adminToken;
  let cashierToken;
  let categoryId;
  let stationId;
  let attemptedName;
  let originalIds;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des06Note', message, { log: false });
  const request = (method, path, token, body) => cy.request({
    method, url: origin + path, log: false, failOnStatusCode: false, timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'Idempotency-Key': key() } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  const login = (username, password, role) => cy.request({
    method: 'POST', url: origin + '/api/v1/auth/login', body: { username, password },
    failOnStatusCode: false, log: false, timeout: 20000,
  }).then((response) => {
    expect(response.status, `${role} login`).eq(200);
    expect(response.body?.staff?.role, `${role} role`).eq(role);
    expect(typeof response.body?.access_token === 'string' && response.body.access_token.length > 0,
      `${role} JWT present`).eq(true);
    return response.body.access_token;
  });
  const menu = () => request('GET', '/api/v1/menu', adminToken).then((response) => {
    expect(response.status, 'GET all menu').eq(200);
    expect(response.body, 'menu array').to.be.an('array');
    return response.body;
  });
  const unchanged = () => menu().then((items) => {
    expect(items.map((item) => item.id).sort(), 'no menu item was created').to.deep.eq(originalIds);
    return items;
  });
  const newName = () => {
    attemptedName = `DES06-QA-INVALID-${key()}`;
    return attemptedName;
  };
  const validPayload = (name) => ({
    name, price: '31900.00', category_id: categoryId,
    station_id: stationId, is_available: true,
  });

  beforeEach(function () {
    attemptedName = null;
    originalIds = null;
    adminToken = null;
    cashierToken = null;
    return cy.env([
      'POS_BASE_URL', 'DES06_ADMIN_USERNAME', 'DES06_ADMIN_PASSWORD',
      'DES06_CASHIER_USERNAME', 'DES06_CASHIER_PASSWORD',
    ], { log: false }).then((env) => {
      origin = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      const adminUser = String(env.DES06_ADMIN_USERNAME ?? '');
      const adminPassword = String(env.DES06_ADMIN_PASSWORD ?? '');
      const cashierUser = String(env.DES06_CASHIER_USERNAME ?? '');
      const cashierPassword = String(env.DES06_CASHIER_PASSWORD ?? '');
      if (!adminUser || !adminPassword || !cashierUser || !cashierPassword) {
        return note('DES06 item negatives PENDING: local Admin/Cashier credentials absent; no mutation')
          .then(() => this.skip());
      }
      return login(adminUser, adminPassword, 'SUPERVISOR').then((jwt) => { adminToken = jwt; })
        .then(() => login(cashierUser, cashierPassword, 'CASHIER'))
        .then((jwt) => { cashierToken = jwt; })
        .then(() => menu()).then((items) => { originalIds = items.map((item) => item.id).sort(); })
        .then(() => request('GET', '/api/v1/menu/categories?active_only=true', adminToken))
        .then((categories) => {
          expect(categories.status, 'active category GET').eq(200);
          expect(categories.body, 'active categories').to.be.an('array');
          categoryId = categories.body.find((item) => item.is_active && item.id)?.id;
          return request('GET', '/api/v1/kitchen/stations', adminToken);
        }).then((stations) => {
          expect(stations.status, 'station GET').eq(200);
          expect(stations.body, 'stations').to.be.an('array');
          stationId = stations.body.find((item) => item.is_active && item.id)?.id;
          if (!categoryId || !stationId) {
            return note('DES06 item negatives PENDING: active category/station absent; no mutation')
              .then(() => this.skip());
          }
        });
    });
  });

  afterEach(() => {
    if (!adminToken || !originalIds) return;
    if (!attemptedName) {
      return menu().then((items) => {
        const additions = items.filter((item) => !originalIds.includes(item.id));
        if (additions.length) {
          throw new Error(`CLEANUP REQUIRED: unnamed invalid payload; unexpected item IDs ${additions.map((item) => item.id).join(',')}`);
        }
      });
    }
    return request('GET', `/api/v1/menu?q=${encodeURIComponent(attemptedName)}`, adminToken)
      .then((response) => {
        if (response.status !== 200 || !Array.isArray(response.body)) {
          throw new Error(`CLEANUP REQUIRED: ${attemptedName}; search HTTP ${response.status}`);
        }
        const matches = response.body.filter((item) => item.name === attemptedName);
        if (!matches.length) return;
        return cy.wrap(matches, { log: false }).each((item) => {
          if (!item.id) throw new Error(`CLEANUP REQUIRED: ${attemptedName}; missing item ID`);
          if (!item.is_available) return;
          return request('PATCH', `/api/v1/menu/${item.id}`, adminToken, { is_available: false })
            .then((disabled) => {
              if (disabled.status !== 200 || disabled.body?.is_available !== false) {
                throw new Error(`CLEANUP REQUIRED: item ${item.id}; disable HTTP ${disabled.status}`);
              }
            });
        }).then(() => {
          throw new Error(`Unexpected QA item ${attemptedName} was created and disabled; inactive record remains in staging`);
        });
      });
  });

  it('DES06-TC-023 | invalid price returns 422 without a new item', () => {
    const payload = { ...validPayload(newName()), price: 0 };
    return request('POST', '/api/v1/menu', adminToken, payload).then((response) => {
      expect(response.status, 'price zero rejected').eq(422);
      return unchanged();
    }).then(() => note('DES06-TC-023 assertions OK: price 0 -> HTTP 422; menu IDs unchanged'));
  });

  it('DES06-TC-024 | empty name returns 422 without a new item', () => {
    const payload = validPayload('');
    return request('POST', '/api/v1/menu', adminToken, payload).then((response) => {
      expect(response.status, 'empty name rejected').eq(422);
      return unchanged();
    }).then(() => note('DES06-TC-024 assertions OK: empty name -> HTTP 422; menu IDs unchanged'));
  });

  it('DES06-TC-025 | nonexistent category returns 404 without an orphan item', () => {
    const missingId = key();
    const payload = { ...validPayload(newName()), category_id: missingId };
    return request('GET', '/api/v1/menu/categories', adminToken).then((categories) => {
      expect(categories.status, 'category list').eq(200);
      expect(categories.body.some((category) => category.id === missingId), 'category truly absent').eq(false);
      return request('POST', '/api/v1/menu', adminToken, payload);
    }).then((response) => {
      expect(response.status, 'unknown category rejected').eq(404);
      return unchanged();
    }).then(() => note('DES06-TC-025 assertions OK: nonexistent category -> HTTP 404; menu IDs unchanged'));
  });

  it('DES06-TC-026 | Cashier cannot create a menu item', () => {
    const payload = validPayload(newName());
    return request('POST', '/api/v1/menu', cashierToken, payload).then((response) => {
      expect(response.status, 'Cashier forbidden to create item').eq(403);
      return unchanged();
    }).then(() => note('DES06-TC-026 assertions OK: Cashier POST -> HTTP 403; menu IDs unchanged'));
  });
});
