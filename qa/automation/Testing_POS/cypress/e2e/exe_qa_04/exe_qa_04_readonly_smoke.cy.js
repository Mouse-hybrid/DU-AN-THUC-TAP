// EXE-QA-04 smoke: login is the only POST. No table/order/menu/queue mutation.
// These checks establish build and read-only contract readiness, not business-case PASS.
describe('EXE-QA-04 | Sprint 2 KDS and WebSocket read-only smoke', () => {
  let base;
  let expectedCommit;
  let password;
  const tokens = {};
  const note = (message) => cy.task('exe04Note', message, { log: false });
  const get = (path, token) => cy.request({
    method: 'GET', url: base + path, failOnStatusCode: false, log: false,
    timeout: 20000, headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const login = (username, role) => cy.request({
    method: 'POST', url: base + '/api/v1/auth/login',
    body: { username, password }, failOnStatusCode: false, log: false, timeout: 20000,
  }).then((response) => {
    expect(response.status, `${username} login`).eq(200);
    expect(response.body?.staff?.role, `${username} role`).eq(role);
    const token = response.body?.access_token;
    expect(token, `${username} JWT`).to.be.a('string').and.not.be.empty;
    return token;
  });

  const probeSocket = (channel) => cy.then({ log: false }, () =>
    new Cypress.Promise((resolve, reject) => {
      const url = `${base.replace(/^http/, 'ws')}/api/v1/ws?token=${encodeURIComponent(tokens.kitchen)}&channel=${channel}`;
      const socket = new WebSocket(url);
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error(`${channel} WebSocket ping timed out`)), 10000);
      socket.onopen = () => socket.send('ping');
      socket.onerror = () => finish(new Error(`${channel} WebSocket handshake failed`));
      socket.onclose = () => finish(new Error(`${channel} WebSocket closed before pong`));
      socket.onmessage = (event) => {
        let message;
        if (event.data === 'pong') return finish();
        try { message = JSON.parse(event.data); }
        catch { return finish(new Error(`${channel} WebSocket returned invalid JSON`)); }
        if (message.type === 'pong') finish();
      };
    }));

  before(() => cy.env(['POS_BASE_URL', 'EXE04_EXPECTED_COMMIT', 'EXE04_SEED_PASSWORD'], { log: false })
    .then((env) => {
      base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      expectedCommit = String(env.EXE04_EXPECTED_COMMIT || '').trim();
      password = String(env.EXE04_SEED_PASSWORD || '');
      expect(password, 'shared staging PIN supplied locally').not.eq('');
    }));

  it('PF-01 | health, version and live OpenAPI match the smoke contract', () => {
    get('/health').then((health) => {
      expect(health.status, 'health HTTP').eq(200);
      expect(health.body?.status, 'health status').eq('ok');
      return get('/version');
    }).then((version) => {
      expect(version.status, 'version HTTP').eq(200);
      const commit = String(version.body?.commit || '');
      expect(commit, 'staging commit').not.eq('');
      if (expectedCommit) expect(commit.startsWith(expectedCommit), 'expected staging build').eq(true);
      return get('/openapi.json').then((schema) => ({ commit, schema }));
    }).then(({ commit, schema }) => {
      expect(schema.status, 'OpenAPI HTTP').eq(200);
      const paths = schema.body?.paths || {};
      for (const path of ['/api/v1/kitchen/queue', '/api/v1/kitchen/stations',
        '/api/v1/orders', '/api/v1/orders/{order_id}', '/api/v1/orders/{order_id}/versions',
        '/api/v1/audit-logs']) {
        expect(paths[path]?.get, `GET ${path} in OpenAPI`).to.exist;
      }
      const operations = Object.values(paths).reduce((count, path) => count +
        Object.keys(path).filter((method) => /^(get|post|put|patch|delete)$/i.test(method)).length, 0);
      return note(`PF-01 PASS: staging commit ${commit.slice(0, 12)}; health/OpenAPI 200; ${Object.keys(paths).length} paths, ${operations} REST operations; WebSocket is outside OpenAPI`);
    });
  });

  it('PF-02 | Kitchen Queue and station filter are readable', function () {
    login('kitchen', 'KITCHEN').then((token) => {
      tokens.kitchen = token;
      return get('/api/v1/kitchen/stations', token);
    }).then((stations) => {
      expect(stations.status, 'station GET').eq(200);
      expect(stations.body, 'stations').to.be.an('array');
      const ids = stations.body.map((station) => String(station.id));
      expect(new Set(ids).size, 'unique station IDs').eq(ids.length);
      return get('/api/v1/kitchen/queue', tokens.kitchen)
        .then((queue) => ({ ids, queue }));
    }).then(({ ids, queue }) => {
      expect(queue.status, 'Queue GET').eq(200);
      expect(queue.body, 'active Queue').to.be.an('array');
      expect(queue.body.every((entry) => ['QUEUED', 'IN_PROGRESS'].includes(entry.status)),
        'active Queue statuses').eq(true);
      if (!ids.length) return note('PF-02 PENDING: no station fixture; Queue GET 200, filter not exercised')
        .then(() => this.skip());
      return get(`/api/v1/kitchen/queue?station_id=${encodeURIComponent(ids[0])}`, tokens.kitchen)
        .then((filtered) => {
          expect(filtered.status, 'station-filtered Queue GET').eq(200);
          expect(filtered.body, 'station-filtered Queue').to.be.an('array');
          expect(filtered.body.every((entry) => entry.station_id === ids[0]),
            'all entries belong to selected station').eq(true);
          return note(`PF-02 PASS: ${ids.length} stations; active Queue ${queue.body.length}; station filter HTTP 200 with ${filtered.body.length} entries. Six-station routing not asserted`);
        });
    });
  });

  it('PF-03 | authenticated kitchen and tables WebSockets answer ping', () => {
    expect(tokens.kitchen, 'Kitchen login from PF-02').to.be.a('string').and.not.be.empty;
    probeSocket('kitchen').then(() => probeSocket('tables'))
      .then(() => note('PF-03 PASS: kitchen and tables WebSocket handshakes/pong; event delivery, reconnect and UI not asserted'));
  });

  it('PF-04 | Supervisor reads order version and audit endpoints', function () {
    login('admin', 'SUPERVISOR').then((token) => {
      tokens.admin = token;
      return get('/api/v1/orders?limit=20', token);
    }).then((orders) => {
      expect(orders.status, 'Orders GET').eq(200);
      expect(orders.body, 'Orders').to.be.an('array');
      if (!orders.body.length) return note('PF-04 PENDING: no order fixture; Orders GET 200; version/audit records not exercised')
        .then(() => this.skip());
      const orderId = orders.body[0].id;
      return get(`/api/v1/orders/${orderId}`, tokens.admin).then((detail) => {
        expect(detail.status, 'Order detail GET').eq(200);
        expect(detail.body?.id, 'selected order ID').eq(orderId);
        expect(detail.body?.current_version, 'current_version').to.be.a('number').and.greaterThan(0);
        return get(`/api/v1/orders/${orderId}/versions`, tokens.admin)
          .then((versions) => ({ orderId, currentVersion: detail.body.current_version, versions }));
      }).then(({ orderId, currentVersion, versions }) => {
        expect(versions.status, 'Order versions GET').eq(200);
        expect(versions.body, 'snapshot versions').to.be.an('array');
        expect(versions.body.every((entry) => {
          const number = entry.version_number ?? entry.version;
          return Number.isInteger(number) && number <= currentVersion;
        }), 'snapshot version bounds').eq(true);
        return get(`/api/v1/audit-logs?order_id=${orderId}`, tokens.admin)
          .then((audit) => ({ orderId, currentVersion, versionCount: versions.body.length, audit }));
      }).then(({ orderId, currentVersion, versionCount, audit }) => {
        expect(audit.status, 'Audit GET').eq(200);
        expect(audit.body, 'audit rows').to.be.an('array');
        return note(`PF-04 PASS: order ${orderId}; current_version ${currentVersion}; snapshot rows ${versionCount}; audit rows ${audit.body.length}. Write precondition/conflict not asserted`);
      });
    });
  });
});
