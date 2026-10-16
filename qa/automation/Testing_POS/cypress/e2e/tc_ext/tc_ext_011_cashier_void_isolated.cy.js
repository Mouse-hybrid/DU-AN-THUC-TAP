// Phase 1 TC_EXT_011: Cashier attempts Void on an own two-item SENT order.
// Both items and their tickets must remain unchanged; cleanup stays isolated.
describe('Phase 1 | TC_EXT_011 Cashier Void forbidden', () => {
  let base;
  let password;
  let tokens;
  let fixture;

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
  const login = (username) => cy.request({
    method: 'POST', url: base + '/api/v1/auth/login',
    body: { username, password: String(password) },
    failOnStatusCode: false, log: false, timeout: 20000,
  }).then((response) => {
    expect(response.status, `${username} login`).eq(200);
    expect(response.body?.access_token, `${username} JWT`).to.be.a('string').and.not.be.empty;
    return response.body.access_token;
  });
  const ownOrder = () => request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.admin)
    .then((response) => {
      expect(response.status, 'GET own order').eq(200);
      expect(response.body?.id, 'own order').eq(fixture.orderId);
      return response.body;
    });
  const ownSubtotal = () => request('GET',
    `/api/v1/orders?table_id=${fixture.tableId}&limit=50`, tokens.admin)
    .then((response) => {
      expect(response.status, 'GET order summaries').eq(200);
      const own = response.body?.find((entry) => entry.id === fixture.orderId);
      expect(own, 'own order summary').to.exist;
      const amount = Number(own.subtotal);
      expect(Number.isFinite(amount), 'numeric subtotal').eq(true);
      return amount;
    });
  const reserve = (tables) => {
    if (!tables.length) return cy.wrap(null, { log: false });
    const table = tables.shift();
    return request('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter,
      { guest_count: 2 }).then((response) => {
      if (response.status === 409) return reserve(tables);
      expect(response.status, `open ${table.code}`).eq(201);
      fixture = { tableId: table.id, tableCode: table.code, sessionId: response.body?.id };
      expect(fixture.sessionId, 'new session ID').to.be.a('string').and.not.be.empty;
      return table;
    });
  };

  beforeEach(function () {
    fixture = null;
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD']).then((env) => {
      base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      password = env.DES05_SEED_PASSWORD;
      if (base !== 'http://160.191.47.17') throw new Error('SAFETY: approved staging only');
      if (!password) return note('TC_EXT_011 PENDING: local PIN missing').then(() => this.skip());
      tokens = {};
      return login('admin').then((value) => { tokens.admin = value; })
        .then(() => login('waiter')).then((value) => { tokens.waiter = value; })
        .then(() => login('cashier')).then((value) => { tokens.cashier = value; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((response) => {
          expect(response.status, 'GET tables').eq(200);
          expect(response.body, 'tables').to.be.an('array');
          const available = response.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          if (!available.length) return note('TC_EXT_011 PENDING: no AVAILABLE B1-B4 table')
            .then(() => this.skip());
          return request('GET', '/api/v1/menu?available_only=true', tokens.waiter)
            .then((menu) => {
              expect(menu.status, 'GET menu').eq(200);
              const mapped = menu.body.filter((item) => item.is_available && item.station_id);
              if (mapped.length < 2) return note('TC_EXT_011 PENDING: need two mapped menu items')
                .then(() => this.skip());
              return reserve(available).then((table) => {
                if (!table) return note('TC_EXT_011 PENDING: table reservation lost')
                  .then(() => this.skip());
                return request('POST', '/api/v1/orders', tokens.waiter,
                  { table_session_id: fixture.sessionId }).then((created) => {
                  expect(created.status, 'create order').eq(201);
                  fixture.orderId = created.body?.id;
                  expect(fixture.orderId, 'order ID').to.be.a('string').and.not.be.empty;
                  return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter,
                    { items: mapped.slice(0, 2).map((item) => ({
                      menu_item_id: item.id, quantity: 1, note: 'Phase1 TC_EXT_011',
                    })) });
                }).then((added) => {
                  expect(added.status, 'add two items').eq(201);
                  expect(added.body?.items, 'two own items').to.have.length(2);
                  fixture.voidItemId = added.body.items[0].id;
                  return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`,
                    tokens.waiter);
                }).then((sent) => {
                  expect(sent.status, 'send to kitchen').eq(200);
                  return ownOrder().then((order) => {
                    expect(order.items.filter((item) => item.status === 'SENT'), 'two SENT items')
                      .to.have.length(2);
                    return note(`TC_EXT_011 fixture: ${table.code}; order ${fixture.orderId}; item ${fixture.voidItemId}; two SENT items`);
                  });
                });
              });
            });
        });
    });
  });

  it('TC_EXT_011 | Cashier Void returns 403 without changing order or queue', () =>
    ownOrder().then((before) => ownSubtotal().then((subtotalBefore) =>
      request('GET', `/api/v1/kitchen/queue?status=QUEUED`, tokens.admin)
        .then((beforeQueue) => {
          expect(beforeQueue.status, 'queue before Void').eq(200);
          const ticketsBefore = beforeQueue.body.filter((entry) =>
            entry.order_id === fixture.orderId).map((entry) => entry.id).sort();
          expect(ticketsBefore, 'two own tickets').to.have.length(2);
          return request('POST',
            `/api/v1/orders/${fixture.orderId}/items/${fixture.voidItemId}/void`,
            tokens.cashier, { reason: 'Phase 1 QA Cashier authorization negative' })
            .then((rejected) => {
              expect(rejected.status, 'Cashier Void HTTP').eq(403);
              return ownOrder().then((after) => {
                expect(after.current_version, 'version unchanged').eq(before.current_version);
                expect(after.items.map((item) => [item.id, item.status]), 'items unchanged')
                  .to.deep.eq(before.items.map((item) => [item.id, item.status]));
                expect(after.items.find((item) => item.id === fixture.voidItemId)?.status,
                  'target remains SENT').eq('SENT');
                return ownSubtotal().then((subtotalAfter) => {
                  expect(subtotalAfter, 'subtotal unchanged').eq(subtotalBefore);
                  return request('GET', '/api/v1/kitchen/queue?status=QUEUED', tokens.admin);
                });
              });
            }).then((afterQueue) => {
              expect(afterQueue.status, 'queue after Void').eq(200);
              const ticketsAfter = afterQueue.body.filter((entry) =>
                entry.order_id === fixture.orderId).map((entry) => entry.id).sort();
              expect(ticketsAfter, 'same own tickets').to.deep.eq(ticketsBefore);
              return note(`TC_EXT_011 assertions OK: order ${fixture.orderId}; Cashier Void HTTP 403; ` +
                `item ${fixture.voidItemId} remains SENT; version/subtotal unchanged; ` +
                `two QUEUED tickets unchanged; cleanup follows`);
            });
        }))));

  afterEach(() => {
    if (!fixture) return;
    const { orderId, tableId, tableCode } = fixture;
    if (!orderId) throw new Error(`CLEANUP REQUIRED: ${tableCode} has session but no order`);
    return request('POST', `/api/v1/orders/${orderId}/request-billing`, tokens.waiter)
      .then((billing) => {
        if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} billing HTTP ${billing.status}`);
        return request('POST', `/api/v1/orders/${orderId}/pay`, tokens.cashier);
      }).then((paid) => {
        if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} pay HTTP ${paid.status}`);
        return request('POST', `/api/v1/orders/${orderId}/close`, tokens.cashier);
      }).then((closed) => {
        if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} close HTTP ${closed.status}`);
        return request('POST', `/api/v1/tables/${tableId}/mark-clean`, tokens.waiter);
      }).then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${tableCode} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`TC_EXT_011 cleanup: ${tableCode} AVAILABLE; order ${orderId} CLOSED`);
      });
  });
});
