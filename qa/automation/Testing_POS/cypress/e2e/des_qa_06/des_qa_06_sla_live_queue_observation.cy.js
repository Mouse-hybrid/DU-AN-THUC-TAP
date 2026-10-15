// PF-19 samples the live Queue without modifying business data.
// It verifies only observed entries outside a rounding/latency guard around
// 8, 12 and 15 minutes. Exact BVA cases TC-001..009 remain Not Executed.
describe('DES-QA-06 | live SLA Queue observation', () => {
  const note = (message) => cy.task('des06Note', message, { log: false });
  const expectedBand = (minutes) => {
    if (minutes >= 15) return 'CRITICAL';
    if (minutes >= 12) return 'DELAYED';
    if (minutes >= 8) return 'WARNING';
    return 'NORMAL';
  };

  it('PF-19 | observed IN_PROGRESS tickets agree with elapsed SLA bands', function () {
    return cy.env(['POS_BASE_URL', 'DES06_KITCHEN_USERNAME', 'DES06_KITCHEN_PASSWORD'], { log: false })
      .then((env) => {
        const base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
        const username = String(env.DES06_KITCHEN_USERNAME || '');
        const password = String(env.DES06_KITCHEN_PASSWORD || '');
        if (!username || !password) {
          return note('PF-19 PENDING: Kitchen credentials not configured locally')
            .then(() => this.skip());
        }
        return cy.request({
          method: 'POST', url: `${base}/api/v1/auth/login`,
          body: { username, password }, failOnStatusCode: false, log: false, timeout: 20000,
        }).then((login) => {
          expect(login.status, 'Kitchen login HTTP').eq(200);
          const token = login.body?.access_token;
          expect(token, 'Kitchen JWT').to.be.a('string').and.not.be.empty;
          return cy.request({
            method: 'GET', url: `${base}/version`,
            failOnStatusCode: false, log: false, timeout: 20000,
          }).then((version) => {
            expect(version.status, 'version HTTP').eq(200);
            return cy.request({
              method: 'GET', url: `${base}/api/v1/kitchen/queue?status=IN_PROGRESS`,
              headers: { Authorization: `Bearer ${token}` },
              failOnStatusCode: false, log: false, timeout: 20000,
            }).then((queue) => ({ queue, commit: version.body?.short_commit || version.body?.commit }));
          });
        });
      }).then((result) => {
        if (!result) return;
        const { queue, commit } = result;
        expect(queue.status, 'IN_PROGRESS Queue HTTP').eq(200);
        expect(queue.body, 'Queue entries').to.be.an('array');
        if (!queue.body.length) {
          return note(`PF-19 PENDING: staging ${commit}; no IN_PROGRESS ticket to observe`)
            .then(() => this.skip());
        }

        const counts = { NORMAL: 0, WARNING: 0, DELAYED: 0, CRITICAL: 0 };
        const samples = [];
        let guarded = 0;
        for (const entry of queue.body) {
          expect(entry.status, `ticket ${entry.id} state`).eq('IN_PROGRESS');
          const minutes = entry.elapsed_minutes;
          expect(typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0,
            `ticket ${entry.id} elapsed_minutes`).eq(true);
          expect(Number.isFinite(Date.parse(entry.started_at)),
            `ticket ${entry.id} started_at`).eq(true);

          // elapsed_minutes is rounded by the API; a sample close to a boundary
          // cannot establish which side of the exact second the server used.
          if ([8, 12, 15].some((threshold) => Math.abs(minutes - threshold) <= 0.15)) {
            guarded += 1;
            continue;
          }
          const expected = expectedBand(minutes);
          expect(entry.sla_status, `ticket ${entry.id} at ${minutes} min`).eq(expected);
          counts[expected] += 1;
          if (samples.length < 4) samples.push(`${entry.id}:${minutes}/${expected}`);
        }
        const verified = Object.values(counts).reduce((sum, count) => sum + count, 0);
        if (!verified) {
          return note(`PF-19 PENDING: staging ${commit}; ${guarded} ticket(s) too close to SLA boundaries for a conclusive sample`)
            .then(() => this.skip());
        }
        return note(`PF-19 PASS: staging ${commit}; ${verified} ticket(s) verified ` +
          `NORMAL=${counts.NORMAL}, WARNING=${counts.WARNING}, DELAYED=${counts.DELAYED}, CRITICAL=${counts.CRITICAL}; ` +
          `${guarded} near-boundary sample(s) excluded; sample ${samples.join(', ')}; ` +
          'exact TC-001..009 boundaries and KDS UI untested');
      });
  });
});
