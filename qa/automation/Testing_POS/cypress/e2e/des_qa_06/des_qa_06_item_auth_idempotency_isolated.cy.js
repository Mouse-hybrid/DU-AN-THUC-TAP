// TC-032 tests missing auth; TC-037 tests exact-key replay.
// PF-09 covers only the invalid-JWT half of TC-033; expired-token coverage remains open.
describe('DES-QA-06 | Menu auth and idempotency', () => {
  let origin;
  let adminToken;
  let categoryId;
  let stationId;
  let itemName;
  let beforeIds;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des06Note', message, { log: false });
  const request = (method, path, token, body, idempotencyKey) => cy.request({
    method, url: origin + path, failOnStatusCode: false, log: false, timeout: 20000,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  const menu = () => request('GET', '/api/v1/menu', adminToken).then((response) => {
    expect(response.status, 'GET menu').eq(200);
    expect(response.body, 'all menu items').to.be.an('array');
    return response.body;
  });
  const unchanged = () => menu().then((items) => {
    expect(items.map((item) => item.id).sort(), 'menu IDs unchanged').to.deep.eq(beforeIds);
  });
  const payload = () => ({
    name: itemName, price: '31900.00', category_id: categoryId,
    station_id: stationId, is_available: true,
  });

  beforeEach(function () {
    itemName = null;
    adminToken = null;
    beforeIds = null;
    return cy.env(['POS_BASE_URL', 'DES06_ADMIN_USERNAME', 'DES06_ADMIN_PASSWORD'], { log: false })
      .then((env) => {
        origin = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
        const username = String(env.DES06_ADMIN_USERNAME ?? '');
        const password = String(env.DES06_ADMIN_PASSWORD ?? '');
        if (!username || !password) {
          return note('DES06 auth/replay PENDING: Supervisor credentials absent; no mutation')
            .then(() => this.skip());
        }
        return cy.request({
          method: 'POST', url: origin + '/api/v1/auth/login', body: { username, password },
          failOnStatusCode: false, log: false, timeout: 20000,
        }).then((login) => {
          expect(login.status, 'Supervisor login').eq(200);
          expect(login.body?.staff?.role, 'Supervisor role').eq('SUPERVISOR');
          adminToken = login.body?.access_token;
          expect(typeof adminToken === 'string' && adminToken.length > 0, 'JWT present').eq(true);
          return menu();
        }).then((items) => {
          beforeIds = items.map((item) => item.id).sort();
          return request('GET', '/api/v1/menu/categories?active_only=true', adminToken);
        }).then((categories) => {
          expect(categories.status, 'active category GET').eq(200);
          expect(categories.body, 'active categories').to.be.an('array');
          categoryId = categories.body.find((entry) => entry.is_active && entry.id)?.id;
          return request('GET', '/api/v1/kitchen/stations', adminToken);
        }).then((stations) => {
          expect(stations.status, 'stations GET').eq(200);
          expect(stations.body, 'stations').to.be.an('array');
          stationId = stations.body.find((entry) => entry.is_active && entry.id)?.id;
          if (!categoryId || !stationId) {
            return note('DES06 auth/replay PENDING: active category/station absent; no mutation')
              .then(() => this.skip());
          }
        });
      });
  });

  afterEach(() => {
    if (!itemName || !adminToken) return;
    return request('GET', `/api/v1/menu?q=${encodeURIComponent(itemName)}`, adminToken)
      .then((response) => {
        if (response.status !== 200 || !Array.isArray(response.body)) {
          throw new Error(`CLEANUP REQUIRED: item ${itemName}; search HTTP ${response.status}`);
        }
        const matches = response.body.filter((item) => item.name === itemName);
        if (!matches.length) return note(`DES06 auth/replay cleanup: ${itemName} not created`);
        if (matches.length !== 1 || !matches[0].id) {
          throw new Error(`CLEANUP REQUIRED: item ${itemName}; ${matches.length} exact-name records`);
        }
        const item = matches[0];
        const disable = item.is_available
          ? request('PATCH', `/api/v1/menu/${item.id}`, adminToken, { is_available: false })
          : cy.wrap({ status: 200, body: item }, { log: false });
        return disable.then((result) => {
          if (result.status !== 200 || result.body?.is_available !== false) {
            throw new Error(`CLEANUP REQUIRED: item ${item.id}; disable HTTP ${result.status}`);
          }
          return request('GET', '/api/v1/menu?available_only=true', adminToken);
        }).then((available) => {
          if (available.status !== 200 || !Array.isArray(available.body) ||
            available.body.some((entry) => entry.id === item.id)) {
            throw new Error(`CLEANUP REQUIRED: item ${item.id}; available GET HTTP ${available.status}`);
          }
          return note(`DES06 auth/replay cleanup: item ${item.id} is_available=false; inactive record remains in staging`);
        });
      });
  });

  it('DES06-TC-032 | missing JWT rejects menu mutation without data change', () => {
    itemName = `DES06-QA-NOAUTH-${key()}`;
    return request('POST', '/api/v1/menu', null, payload(), key()).then((rejected) => {
      expect(rejected.status, 'POST without JWT').eq(401);
      return unchanged();
    }).then(() => note('DES06-TC-032 assertions OK: POST without JWT -> HTTP 401; menu IDs unchanged'));
  });

  it('PF-09 | invalid JWT rejects mutation; expired-token branch of TC-033 remains open', () => {
    itemName = `DES06-QA-BADJWT-${key()}`;
    return request('POST', '/api/v1/menu', 'invalid.jwt.token', payload(), key()).then((rejected) => {
      expect(rejected.status, 'POST with invalid JWT').eq(401);
      return unchanged();
    }).then(() => note('PF-09: invalid JWT POST -> HTTP 401; menu IDs unchanged. TC-033 expired JWT untested'));
  });

  it('DES06-TC-037 | same Idempotency-Key replays item creation without a duplicate', () => {
    itemName = `DES06-QA-REPLAY-${key()}`;
    const body = payload();
    const replayKey = key();
    return request('POST', '/api/v1/menu', adminToken, body, replayKey).then((created) => {
      expect(created.status, 'first create').eq(201);
      expect(created.body?.id, 'created item ID').to.be.a('string').and.not.be.empty;
      expect(created.body?.name, 'created item name').eq(itemName);
      return request('POST', '/api/v1/menu', adminToken, body, replayKey)
        .then((replayed) => ({ created, replayed }));
    }).then(({ created, replayed }) => {
      expect(replayed.status, 'same-key replay HTTP').eq(201);
      expect(replayed.body, 'same-key response body').to.deep.eq(created.body);
      return menu().then((items) => {
        expect(items.filter((item) => item.name === itemName), 'exactly one QA item').to.have.length(1);
        const newIds = items.map((item) => item.id).filter((id) => !beforeIds.includes(id));
        expect(newIds, 'only one new item ID').to.deep.eq([created.body.id]);
        return note(`DES06-TC-037 assertions OK: item ${created.body.id}; same-key replay 201/same response; one new ID; cleanup follows`);
      });
    });
  });
});
