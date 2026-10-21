// ENV-QA-03: login only, then GET version/stations/menu. No fixture or order mutation.
// A ready fixture is not a Passed result for DES05-TC-002 or modifier routing.
describe('ENV-QA-03 | six-station menu fixture inventory', () => {
  const base = (value) => String(value || 'http://160.191.47.17').replace(/\/+$/, '');
  const note = (message) => cy.task('des05Note', message, { log: false });
  const request = (origin, path, token) => cy.request({
    method: 'GET', url: origin + path,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    failOnStatusCode: false, log: false, timeout: 20000,
  });
  const login = (origin, username, password) => cy.request({
    method: 'POST', url: origin + '/api/v1/auth/login',
    body: { username, password }, failOnStatusCode: false, log: false, timeout: 20000,
  }).then((response) => {
    expect(response.status, `${username} login`).eq(200);
    expect(response.body?.staff?.role, `${username} role`).eq(username === 'kitchen' ? 'KITCHEN' : 'WAITER');
    expect(response.body?.access_token, `${username} JWT`).to.be.a('string').and.not.be.empty;
    return response.body.access_token;
  });

  it('lists active stations and available menu mappings for one outlet', function () {
    cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD']).then((env) => {
      const origin = base(env.POS_BASE_URL);
      const password = String(env.DES05_SEED_PASSWORD || '');
      if (!password) {
        return note('ENV-QA-03 PENDING: QA credentials missing; no business GET executed')
          .then(() => this.skip());
      }
      return request(origin, '/version').then((version) => {
        expect(version.status, 'staging version').eq(200);
        const commit = version.body?.commit || version.body?.short_commit || 'unknown';
        return note(`ENV-QA-03 staging commit ${commit}; account login and GET only`);
      }).then(() => login(origin, 'kitchen', password))
        .then((kitchenToken) => request(origin, '/api/v1/kitchen/stations', kitchenToken))
        .then((stationsResponse) => {
          expect(stationsResponse.status, 'Kitchen stations').eq(200);
          expect(stationsResponse.body, 'station array').to.be.an('array');
          const active = stationsResponse.body.filter((station) => station.is_active !== false);
          const ids = active.map((station) => String(station.id || ''));
          expect(ids.every(Boolean), 'active stations have IDs').eq(true);
          expect(new Set(ids).size, 'active station IDs unique').eq(ids.length);
          return login(origin, 'waiter', password).then((waiterToken) =>
            request(origin, '/api/v1/menu?available_only=true', waiterToken)
          ).then((menuResponse) => {
            expect(menuResponse.status, 'available menu').eq(200);
            expect(menuResponse.body, 'menu array').to.be.an('array');
            const items = menuResponse.body.filter((item) => item.is_available !== false);
            const byStation = new Map(ids.map((id) => [id, []]));
            const orphanIds = [];
            for (const item of items) {
              const id = String(item.station_id || '');
              if (byStation.has(id)) byStation.get(id).push(String(item.id || ''));
              else orphanIds.push(String(item.id || ''));
            }
            const ready = [...byStation.values()].filter((mapped) => mapped.length > 0).length;
            return cy.wrap(active, { log: false }).each((station) => {
              const mapped = byStation.get(String(station.id));
              return note(`ENV-QA-03 station ${station.id} (${station.name || 'unnamed'}): ` +
                `available menu items ${mapped.length}; sample item ${mapped[0] || '-'}`);
            }).then(() => note(`ENV-QA-03 inventory: active stations ${active.length}; ` +
              `stations with available items ${ready}/6; unmapped/unknown-station items ${orphanIds.length}`))
              .then(() => {
                if (ready < 6) {
                  return note(`ENV-QA-03 PENDING: ${ready}/6 mapped active stations; ` +
                    'request isolated station/menu fixtures from BE; DES05-TC-002 not executed')
                    .then(() => this.skip());
                }
                return note('ENV-QA-03 READY: six active stations have available menu items; ' +
                  'DES05-TC-002 Send and modifier behavior still untested');
              });
          });
        });
    });
  });
});
