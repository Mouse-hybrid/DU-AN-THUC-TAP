// Phase 1 PF-PM35: verify the current PO-approved Waiter PATCH permission.
// The historical TC_PM_35 expects 403; this test must not mark that old
// expectation as passed without revising the testcase requirement.
describe('Phase 1 | TC_PM_35 current Waiter PATCH contract', () => {
  const base = 'http://160.191.47.17';
  let tokens = {};
  let fixture = {};
  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des05Note', `[Phase 1] ${message}`, { log: false });
  const request = (method, path, token, body) => cy.request({
    method, url: base + path, failOnStatusCode: false, log: false, timeout: 20000,
    headers: { Authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'Idempotency-Key': key() }) },
    ...(body === undefined ? {} : { body }),
  });
  const login = (username, password) => cy.request({
    method: 'POST', url: base + '/api/v1/auth/login',
    body: { username, password }, failOnStatusCode: false, log: false, timeout: 20000,
  }).then((response) => {
    expect(response.status, `${username} login`).eq(200);
    expect(response.body?.access_token, `${username} token`).to.be.a('string').and.not.be.empty;
    return response.body.access_token;
  });
  const reserve = (tables) => {
    if (!tables.length) return cy.wrap(null, { log: false });
    const table = tables.shift();
    return request('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter,
      { guest_count: 2 }).then((response) => {
      if (response.status === 409) return reserve(tables);
      expect(response.status, `open ${table.code}`).eq(201);
      fixture.tableId = table.id;
      fixture.tableCode = table.code;
      fixture.sessionId = response.body?.id;
      return table;
    });
  };

  beforeEach(function () {
    fixture = {};
    tokens = {};
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) return note('PF-PM35 PENDING: local PIN missing')
        .then(() => this.skip());
      const password = String(env.DES05_SEED_PASSWORD);
      return login('waiter', password).then((token) => { tokens.waiter = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((tables) => {
          expect(tables.status, 'tables GET').eq(200);
          const available = tables.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          if (!available.length) return note('PF-PM35 PENDING: no AVAILABLE B1-B4 table')
            .then(() => this.skip());
          return request('GET', '/api/v1/menu?available_only=true', tokens.waiter)
            .then((menu) => {
              expect(menu.status, 'menu GET').eq(200);
              const item = menu.body.find((entry) => entry.is_available && entry.station_id);
              if (!item) return note('PF-PM35 PENDING: no mapped menu item')
                .then(() => this.skip());
              fixture.menuId = item.id;
              return reserve(available).then((table) => {
                if (!table) return note('PF-PM35 PENDING: table reservation lost')
                  .then(() => this.skip());
                return request('POST', '/api/v1/orders', tokens.waiter,
                  { table_session_id: fixture.sessionId });
              });
            }).then((created) => {
              if (!created) return;
              expect(created.status, 'create own order').eq(201);
              fixture.orderId = created.body?.id;
              return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter,
                { items: [{ menu_item_id: fixture.menuId, quantity: 1,
                  note: 'Phase1 PF-PM35' }] });
            }).then((added) => {
              if (!added) return;
              expect(added.status, 'add own item').eq(201);
              fixture.itemId = added.body?.items?.[0]?.id;
              expect(fixture.itemId, 'own item ID').to.be.a('string').and.not.be.empty;
              return note(`PF-PM35 fixture: ${fixture.tableCode}; order ${fixture.orderId}; own CREATED item ${fixture.itemId}`);
            });
        });
    });
  });

  it('PF-PM35 | Waiter may update own CREATED item in current contract', () =>
    request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter)
      .then((before) => {
        expect(before.status, 'before order GET').eq(200);
        const original = before.body?.items?.find((entry) => entry.id === fixture.itemId);
        expect(original?.status, 'own item before Send').eq('CREATED');
        expect(original.quantity, 'initial quantity').eq(1);
        fixture.previousVersion = before.body.current_version;
        fixture.unitPrice = Number(original.unit_price);
        return request('PATCH', `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}`,
          tokens.waiter, { quantity: 2 });
      }).then((updated) => {
        expect(updated.status, 'current PO Waiter PATCH permission').eq(200);
        return request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter);
      }).then((after) => {
        expect(after.status, 'after order GET').eq(200);
        const item = after.body?.items?.find((entry) => entry.id === fixture.itemId);
        expect(item?.quantity, 'persisted quantity').eq(2);
        expect(after.body.current_version, 'version increment').eq(fixture.previousVersion + 1);
        expect(Number(after.body.subtotal), 'own order subtotal').eq(fixture.unitPrice * 2);
        return note(`PF-PM35 current-contract PASS: Waiter PATCH own CREATED item HTTP 200, quantity 1 -> 2, version ${fixture.previousVersion} -> ${after.body.current_version}; historical TC_PM_35 expected 403 and needs test-design update; cleanup follows`);
      }));

  afterEach(() => {
    if (!fixture.sessionId) return;
    if (!fixture.orderId) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session without order`);
    return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter)
      .then((sent) => {
        if (sent.status !== 200) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} send HTTP ${sent.status}`);
        return request('POST', `/api/v1/orders/${fixture.orderId}/request-billing`, tokens.waiter);
      }).then((billing) => {
        if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} billing HTTP ${billing.status}`);
        return request('POST', `/api/v1/orders/${fixture.orderId}/pay`, tokens.cashier);
      }).then((paid) => {
        if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} pay HTTP ${paid.status}`);
        return request('POST', `/api/v1/orders/${fixture.orderId}/close`, tokens.cashier);
      }).then((closed) => {
        if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} close HTTP ${closed.status}`);
        return request('POST', `/api/v1/tables/${fixture.tableId}/mark-clean`, tokens.waiter);
      }).then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`PF-PM35 cleanup: ${fixture.tableCode} AVAILABLE; order ${fixture.orderId} CLOSED`);
      });
  });
});
