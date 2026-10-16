// Phase 1 TC_EXT_001: upper valid guest_count boundary on an own available table.
// A sellable item is added solely to allow isolated order/table cleanup.
describe('Phase 1 | TC_EXT_001 guest_count upper boundary', () => {
  const base = 'http://160.191.47.17';
  let tokens;
  let fixture;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des05Note', `[Phase 1] ${message}`, { log: false });
  const request = (method, path, token, body) => cy.request({
    method, url: base + path, failOnStatusCode: false, timeout: 20000, log: false,
    headers: { Authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'Idempotency-Key': key() }) },
    ...(body === undefined ? {} : { body }),
  });
  const login = (username, password) => cy.request({
    method: 'POST', url: `${base}/api/v1/auth/login`, body: { username, password },
    failOnStatusCode: false, timeout: 20000, log: false,
  }).then((result) => {
    expect(result.status, `${username} login`).eq(200);
    expect(result.body?.access_token, `${username} JWT`).to.be.a('string').and.not.be.empty;
    return result.body.access_token;
  });
  const reserve = (available) => {
    if (!available.length) return cy.wrap(null, { log: false });
    const table = available.shift();
    return request('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter,
      { guest_count: 100 }).then((opened) => {
      if (opened.status === 409) return reserve(available);
      expect(opened.status, 'guest_count=100 HTTP').eq(201);
      fixture.tableId = table.id;
      fixture.tableCode = table.code;
      fixture.sessionId = opened.body?.id;
      expect(fixture.sessionId, 'new session').to.be.a('string').and.not.be.empty;
      expect(opened.body?.table_id, 'session belongs to own table').eq(table.id);
      expect(opened.body?.guest_count, 'upper valid guest_count').eq(100);
      fixture.opened = opened.body;
      return table;
    });
  };

  beforeEach(function () {
    tokens = {};
    fixture = {};
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) {
        return note('TC_EXT_001 PENDING: local staging PIN missing').then(() => this.skip());
      }
      const password = String(env.DES05_SEED_PASSWORD);
      return login('waiter', password).then((token) => { tokens.waiter = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((tables) => {
          expect(tables.status, 'GET tables').eq(200);
          const available = tables.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          return request('GET', '/api/v1/menu?available_only=true', tokens.cashier)
            .then((menu) => ({ available, menu }));
        }).then(({ available, menu }) => {
          expect(menu.status, 'GET available menu').eq(200);
          const mapped = menu.body.find((item) => item.is_available && item.station_id);
          if (!available.length || !mapped) {
            return note('TC_EXT_001 PENDING: no own B1-B4 table or mapped menu; no mutation')
              .then(() => this.skip());
          }
          fixture.menuId = mapped.id;
          return reserve(available).then((table) => {
            if (!table) return note('TC_EXT_001 PENDING: table reservation lost').then(() => this.skip());
            return request('POST', '/api/v1/orders', tokens.cashier,
              { table_session_id: fixture.sessionId });
          }).then((created) => {
            expect(created.status, 'create own order').eq(201);
            fixture.orderId = created.body?.id;
            expect(fixture.orderId, 'own order ID').to.be.a('string').and.not.be.empty;
            return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.cashier,
              { items: [{ menu_item_id: fixture.menuId, quantity: 1,
                note: 'Phase1 TC_EXT_001 cleanup item' }] });
          }).then((added) => {
            expect(added.status, 'add own cleanup item').eq(201);
            expect(added.body?.items, 'one cleanup item').to.have.length(1);
            return note(`TC_EXT_001 fixture: ${fixture.tableCode}; session ${fixture.sessionId}; ` +
              `guest_count=100; order ${fixture.orderId}`);
          });
        });
    });
  });

  it('TC_EXT_001 | Waiter can open a table with guest_count=100', () =>
    request('GET', `/api/v1/tables/${fixture.tableId}`, tokens.waiter)
      .then((table) => {
        expect(table.status, 'GET own table').eq(200);
        expect(table.body?.status, 'table occupied').eq('OCCUPIED');
        expect(table.body?.current_session?.id, 'same session').eq(fixture.sessionId);
        return request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.cashier);
      }).then((ownOrder) => {
        expect(ownOrder.status, 'GET own order').eq(200);
        expect(ownOrder.body?.table_session_id, 'order uses boundary session')
          .eq(fixture.sessionId);
        return note(`TC_EXT_001 assertions OK: ${fixture.tableCode}; ` +
          `open-session HTTP 201 guest_count=100; session ${fixture.sessionId}; ` +
          `own table OCCUPIED and order ${fixture.orderId} bound to session; cleanup follows`);
      }));

  afterEach(() => {
    if (!fixture.tableId) return;
    if (!fixture.orderId) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session ${fixture.sessionId} without order`);
    }
    return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter)
      .then((sent) => {
        if (sent.status !== 200) throw new Error(`CLEANUP REQUIRED: own Send HTTP ${sent.status}`);
        return request('POST', `/api/v1/orders/${fixture.orderId}/request-billing`, tokens.waiter);
      }).then((billing) => {
        if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: own Billing HTTP ${billing.status}`);
        return request('POST', `/api/v1/orders/${fixture.orderId}/pay`, tokens.cashier);
      }).then((paid) => {
        if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: own Pay HTTP ${paid.status}`);
        return request('POST', `/api/v1/orders/${fixture.orderId}/close`, tokens.cashier);
      }).then((closed) => {
        if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: own Close HTTP ${closed.status}`);
        return request('POST', `/api/v1/tables/${fixture.tableId}/mark-clean`, tokens.waiter);
      }).then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`TC_EXT_001 cleanup: ${fixture.tableCode} AVAILABLE; order ${fixture.orderId} CLOSED`);
      });
  });
});
