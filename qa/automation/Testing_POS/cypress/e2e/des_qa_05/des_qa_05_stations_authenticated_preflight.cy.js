// Account-only, read-only KDS station inventory and station filter audit.
// Passing these checks does not prove six-station routing or a business testcase.
describe('DES-QA-05 | authenticated Kitchen station preflight', () => {
  const origin = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const note = (message) => cy.task('des05Note', message, { log: false });
  const get = (base, path, token) => cy.request({
    method: 'GET', url: base + path,
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false, log: false, timeout: 20000,
  });
  const kitchenAuth = (env, context) => {
    const base = origin(env.POS_BASE_URL);
    if (env.EXT_KITCHEN_TOKEN) return cy.wrap({ base, token: String(env.EXT_KITCHEN_TOKEN) }, { log: false });
    if (!env.EXT_KITCHEN_USERNAME || !env.EXT_KITCHEN_PASSWORD) {
      return note('PF-15/16 PENDING: Kitchen credentials not configured').then(() => context.skip());
    }
    return cy.request({
      method: 'POST', url: base + '/api/v1/auth/login',
      body: { username: String(env.EXT_KITCHEN_USERNAME), password: String(env.EXT_KITCHEN_PASSWORD) },
      failOnStatusCode: false, log: false, timeout: 20000,
    }).then((response) => {
      expect(response.status, 'Kitchen login').eq(200);
      expect(response.body?.staff?.role, 'Kitchen role').eq('KITCHEN');
      const token = response.body?.access_token;
      expect(token, 'Kitchen JWT').to.be.a('string').and.not.be.empty;
      return { base, token };
    });
  };

  it('PF-15 | Kitchen JWT lists actual station IDs', function () {
    cy.env(['POS_BASE_URL', 'EXT_KITCHEN_TOKEN', 'EXT_KITCHEN_USERNAME', 'EXT_KITCHEN_PASSWORD'])
      .then((env) => kitchenAuth(env, this))
      .then((auth) => {
        if (!auth) return;
        return get(auth.base, '/api/v1/kitchen/stations', auth.token).then((response) => {
          expect(response.status, 'GET Kitchen stations').eq(200);
          expect(response.body, 'stations').to.be.an('array').and.not.be.empty;
          const ids = response.body.map((station) => station.id);
          expect(ids.every(Boolean), 'all stations have IDs').eq(true);
          expect(new Set(ids).size, 'unique station IDs').eq(ids.length);
          return note(`PF-15: authenticated Kitchen stations HTTP 200; distinct station IDs ${ids.length}; six-station routing untested`);
        });
      });
  });

  it('PF-16 | station-filtered queue partitions current active entries', function () {
    cy.env(['POS_BASE_URL', 'EXT_KITCHEN_TOKEN', 'EXT_KITCHEN_USERNAME', 'EXT_KITCHEN_PASSWORD'])
      .then((env) => kitchenAuth(env, this))
      .then((auth) => {
        if (!auth) return;
        return get(auth.base, '/api/v1/kitchen/stations', auth.token).then((stations) => {
          expect(stations.status, 'GET stations').eq(200);
          expect(stations.body, 'stations').to.be.an('array').and.not.be.empty;
          return get(auth.base, '/api/v1/kitchen/queue', auth.token).then((all) => {
            expect(all.status, 'GET active queue').eq(200);
            expect(all.body, 'active entries').to.be.an('array');
            if (!all.body.length) {
              return note('PF-16 PENDING: active queue empty; station filter cannot be evidenced')
                .then(() => this.skip());
            }
            const stationIds = stations.body.map((station) => String(station.id));
            expect(new Set(stationIds).size, 'unique station IDs').eq(stationIds.length);
            const expected = all.body.map((entry) => String(entry.id)).sort();
            expect(new Set(expected).size, 'unique queue entry IDs').eq(expected.length);
            expect(all.body.every((entry) => stationIds.includes(String(entry.station_id))),
              'every queue entry belongs to a listed station').eq(true);
            const observed = [];
            return cy.wrap(stationIds, { log: false }).each((id) =>
              get(auth.base, '/api/v1/kitchen/queue?station_id=' + encodeURIComponent(id), auth.token)
                .then((filtered) => {
                  expect(filtered.status, 'filtered queue HTTP').eq(200);
                  expect(filtered.body, 'filtered queue entries').to.be.an('array');
                  expect(filtered.body.every((entry) => String(entry.station_id) === id),
                    'filtered entries match requested station').eq(true);
                  observed.push(...filtered.body.map((entry) => String(entry.id)));
                })
            ).then(() => {
              expect(observed.sort(), 'each active queue entry appears once across stations').to.deep.eq(expected);
              return note(`PF-16: ${expected.length} active entries partitioned across ${stationIds.length} stations; Send to Kitchen routing untested`);
            });
          });
        });
      });
  });
});
