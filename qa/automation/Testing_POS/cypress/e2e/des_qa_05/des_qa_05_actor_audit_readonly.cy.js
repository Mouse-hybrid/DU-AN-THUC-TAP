// Historical actor evidence for DES05-TC-012 and TC-019. No business mutation.
// If staging was reset, audit may survive while order/version records are gone.
describe('DES-QA-05 | historical actor audit, read only', () => {
  const start = {
    order: '6407fcc8-ae62-410d-a9e9-a00e44a57f7f',
    item: 'd6f9ccbd-0637-4c75-b81e-7f059e7afb5e',
  };
  const refire = {
    order: 'a46347fa-6677-4548-8684-fe3641a64012',
    item: '5921a380-111f-4ace-9a89-0e8133c599c6',
    version: 4,
  };
  let base;
  let token;
  const note = (message) => cy.task('des05Note', message, { log: false });
  const get = (path) => cy.request({
    method: 'GET', url: base + path, failOnStatusCode: false, log: false,
    timeout: 20000, headers: { Authorization: `Bearer ${token}` },
  });
  const actor = (row, action, item, username, role) => {
    expect(row, `${action} audit row for ${item}`).to.exist;
    expect(row.action).eq(action);
    expect(row.entity_id).eq(item);
    expect(row.staff_username, `${action} username`).eq(username);
    expect(row.staff_role, `${action} role`).eq(role);
    expect(Number.isNaN(Date.parse(row.created_at)), `${action} created_at parses`).eq(false);
  };

  before(function () {
    return cy.env(['POS_BASE_URL', 'DES05_AUDIT_PASSWORD', 'DES05_EXPECTED_COMMIT'])
      .then((env) => {
        base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
        if (!env.DES05_AUDIT_PASSWORD) {
          return note('Audit evidence PENDING: admin password not configured locally')
            .then(() => this.skip());
        }
        return cy.request({ method: 'GET', url: base + '/version',
          failOnStatusCode: false, log: false, timeout: 20000,
        }).then((version) => {
          expect(version.status, 'GET /version').eq(200);
          const commit = String(version.body?.commit || version.body?.short_commit || '');
          const expected = String(env.DES05_EXPECTED_COMMIT || 'd466a3d');
          return note(`Audit evidence staging commit ${commit.slice(0, 12)}; expected ${expected}`)
            .then(() => {
              expect(commit.toLowerCase().startsWith(expected.toLowerCase()),
                'audit API deployment commit').eq(true);
              return cy.request({
                method: 'POST', url: base + '/api/v1/auth/login', log: false,
                failOnStatusCode: false, timeout: 20000,
                body: { username: 'admin', password: String(env.DES05_AUDIT_PASSWORD) },
              });
            }).then((login) => {
              expect(login.status, 'admin login').eq(200);
              token = login.body?.access_token;
              expect(token, 'admin JWT').to.be.a('string').and.not.be.empty;
            });
        });
      });
  });

  it('AE-012 | Start Cooking audit records Kitchen actor and timestamp', () => {
    const byItem = `/api/v1/audit-logs?entity_id=${start.item}&action=ORDER_ITEM_START_COOKING`;
    return get(`/api/v1/audit-logs?order_id=${start.order}&limit=500`).then((response) => {
      if (response.status === 404) {
        return note('AE-012: old order absent after possible reset; querying preserved audit by item')
          .then(() => get(byItem));
      }
      expect(response.status, 'GET audit by order').eq(200);
      return response;
    }).then((response) => {
      expect(response.status, 'GET TC-012 audit').eq(200);
      expect(response.body, 'audit rows').to.be.an('array');
      const row = response.body.find((entry) =>
        entry.action === 'ORDER_ITEM_START_COOKING' && entry.entity_id === start.item);
      actor(row, 'ORDER_ITEM_START_COOKING', start.item, 'kitchen', 'KITCHEN');
      return note(`AE-012 PASS: order ${start.order}; item ${start.item}; ` +
        `action ${row.action}; actor ${row.staff_username}/${row.staff_role}; at ${row.created_at}`);
    });
  });

  it('AE-019 | Refire audit records Supervisor actor and timestamp', () =>
    get(`/api/v1/audit-logs?entity_id=${refire.item}&action=ORDER_ITEM_REFIRED`)
      .then((response) => {
        expect(response.status, 'GET TC-019 audit').eq(200);
        expect(response.body, 'audit rows').to.be.an('array');
        const row = response.body.find((entry) =>
          entry.action === 'ORDER_ITEM_REFIRED' && entry.entity_id === refire.item);
        actor(row, 'ORDER_ITEM_REFIRED', refire.item, 'admin', 'SUPERVISOR');
        return note(`AE-019 PASS: order ${refire.order}; item ${refire.item}; ` +
          `action ${row.action}; actor ${row.staff_username}/${row.staff_role}; at ${row.created_at}`);
      }));

  it('VE-019 | Refire snapshot version 4 records Supervisor actor', function () {
    return get(`/api/v1/orders/${refire.order}/versions`).then((response) => {
      if (response.status === 404) {
        return note('VE-019 PENDING: historical order/version absent after possible staging reset; audit evidence remains separate')
          .then(() => this.skip());
      }
      expect(response.status, 'GET TC-019 versions').eq(200);
      expect(response.body, 'version rows').to.be.an('array');
      const row = response.body.find((version) => version.version_number === refire.version);
      expect(row, `saved snapshot for version ${refire.version}`).to.exist;
      expect(row.created_by_username, 'version actor').eq('admin');
      expect(row.created_by_role, 'version role').eq('SUPERVISOR');
      expect(row.snapshot, 'saved refire snapshot').to.exist;
      expect(Number.isNaN(Date.parse(row.created_at)), 'version created_at parses').eq(false);
      return note(`VE-019 PASS: order ${refire.order}; version ${row.version_number}; ` +
        `actor ${row.created_by_username}/${row.created_by_role}; at ${row.created_at}; snapshot present`);
    });
  });
});
