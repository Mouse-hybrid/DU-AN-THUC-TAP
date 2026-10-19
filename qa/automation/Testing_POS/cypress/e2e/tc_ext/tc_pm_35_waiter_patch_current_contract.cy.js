// Phase 1 TC_PM_35: the approved rule permits Waiter PATCH on CREATED only.
// The legacy 403 expectation is superseded; SENT edits must return 409.
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
      if (!env.DES05_SEED_PASSWORD) return note('TC_PM_35 PENDING: local PIN missing')
        .then(() => this.skip());
      const password = String(env.DES05_SEED_PASSWORD);
      return login('waiter', password).then((token) => { tokens.waiter = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((tables) => {
          expect(tables.status, 'tables GET').eq(200);
          const available = tables.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          if (!available.length) return note('TC_PM_35 PENDING: no AVAILABLE B1-B4 table')
            .then(() => this.skip());
          return request('GET', '/api/v1/menu?available_only=true', tokens.waiter)
            .then((menu) => {
              expect(menu.status, 'menu GET').eq(200);
              const item = menu.body.find((entry) => entry.is_available && entry.station_id);
              if (!item) return note('TC_PM_35 PENDING: no mapped menu item')
                .then(() => this.skip());
              fixture.menuId = item.id;
              return reserve(available).then((table) => {
                if (!table) return note('TC_PM_35 PENDING: table reservation lost')
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
                  note: 'Phase1 TC_PM_35' }] });
            }).then((added) => {
              if (!added) return;
              expect(added.status, 'add own item').eq(201);
              fixture.itemId = added.body?.items?.[0]?.id;
              expect(fixture.itemId, 'own item ID').to.be.a('string').and.not.be.empty;
              return note(`TC_PM_35 fixture: ${fixture.tableCode}; order ${fixture.orderId}; own CREATED item ${fixture.itemId}`);
            });
        });
    });
  });

  it('TC_PM_35 | Waiter may update CREATED but not SENT item', () =>
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
        fixture.sentVersion = after.body.current_version;
        fixture.sentSubtotal = Number(after.body.subtotal);
        return note(`TC_PM_35 CREATED PASS: Waiter PATCH HTTP 200, quantity 1 -> 2, version ${fixture.previousVersion} -> ${fixture.sentVersion}; approved contract replaces historical 403`);
      }).then(() => request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`,
        tokens.waiter)).then((sent) => {
        expect(sent.status, 'send own order').eq(200);
        fixture.sentToKitchen = true;
        return request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter);
      }).then((sentOrder) => {
        expect(sentOrder.status, 'SENT order GET').eq(200);
        expect(sentOrder.body?.items.find((entry) => entry.id === fixture.itemId)?.status,
          'item after Send').eq('SENT');
        fixture.sentVersion = sentOrder.body.current_version;
        fixture.sentSubtotal = Number(sentOrder.body.subtotal);
        return request('PATCH', `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}`,
          tokens.waiter, { quantity: 3 });
      }).then((rejected) => {
        expect(rejected.status, 'SENT item cannot be edited').eq(409);
        return request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter);
      }).then((unchanged) => {
        expect(unchanged.status, 'unchanged order GET').eq(200);
        const item = unchanged.body?.items.find((entry) => entry.id === fixture.itemId);
        expect(item?.status, 'item remains SENT').eq('SENT');
        expect(item?.quantity, 'quantity unchanged after 409').eq(2);
        expect(unchanged.body.current_version, 'version unchanged after 409')
          .eq(fixture.sentVersion);
        expect(Number(unchanged.body.subtotal), 'subtotal unchanged after 409')
          .eq(fixture.sentSubtotal);
        return note(`TC_PM_35 SENT PASS: Waiter PATCH own SENT item HTTP 409; quantity 2, version ${fixture.sentVersion}, subtotal ${fixture.sentSubtotal} unchanged; cleanup follows`);
      }));

  afterEach(() => {
    if (!fixture.sessionId) return;
    if (!fixture.orderId) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session without order`);
    const send = fixture.sentToKitchen
      ? cy.wrap({ status: 200 }, { log: false })
      : request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter);
    return send
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
        return note(`TC_PM_35 cleanup: ${fixture.tableCode} AVAILABLE; order ${fixture.orderId} CLOSED`);
      });
  });
});
