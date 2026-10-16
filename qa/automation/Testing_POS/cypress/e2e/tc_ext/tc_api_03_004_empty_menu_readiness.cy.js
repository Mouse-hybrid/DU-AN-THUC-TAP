// Phase 1 TC_API_03_004: a scoped empty q response is a contract preflight;
// it cannot substitute for a genuinely empty outlet menu.
describe('Phase 1 | TC_API_03_004 empty Menu readiness', () => {
  const base = 'http://160.191.47.17';
  let token;
  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des05Note', `[Phase 1] ${message}`, { log: false });
  const menu = (path) => cy.request({
    method: 'GET', url: base + path, log: false,
    failOnStatusCode: false, timeout: 20000,
    headers: { Authorization: `Bearer ${token}` },
  });

  before(function () {
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) return note('TC_API_03_004 PENDING: local PIN missing')
        .then(() => this.skip());
      return cy.request({
        method: 'POST', url: base + '/api/v1/auth/login',
        body: { username: 'cashier', password: String(env.DES05_SEED_PASSWORD) },
        failOnStatusCode: false, log: false, timeout: 20000,
      }).then((login) => {
        expect(login.status, 'Cashier login').eq(200);
        token = login.body?.access_token;
        expect(token, 'Cashier JWT').to.be.a('string').and.not.be.empty;
      });
    });
  });

  it('PF-EMPTY-03 | unmatched q has an empty array response', () => {
    const query = `PHASE1-NO-MENU-${key()}`;
    return menu(`/api/v1/menu?q=${encodeURIComponent(query)}`).then((response) => {
      expect(response.status, 'filtered Menu GET').eq(200);
      expect(response.body, 'filtered Menu response shape').to.deep.eq([]);
      return note(`PF-EMPTY-03 PASS: q=${query} returned HTTP 200 and []; global empty-menu fixture not verified`);
    });
  });

  it('TC_API_03_004 | entire outlet Menu GET is empty', function () {
    return menu('/api/v1/menu').then((response) => {
      expect(response.status, 'unfiltered Menu GET').eq(200);
      expect(response.body, 'unfiltered Menu response shape').to.be.an('array');
      if (response.body.length > 0) {
        return note(`TC_API_03_004 PENDING: current outlet Menu has ${response.body.length} item(s); no data changed`)
          .then(() => this.skip());
      }
      expect(response.body, 'actual global empty outlet Menu').to.deep.eq([]);
      return note('TC_API_03_004 PASS: unfiltered outlet Menu HTTP 200 []');
    });
  });
});
