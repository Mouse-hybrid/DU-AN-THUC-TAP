// Each test provisions its own order on an AVAILABLE B1-B4 table.
// The test pays/closes only its own order, then marks its own table clean.
// This spec checks the API timer state; UI indicators and exact SLA boundaries are separate cases.
describe('DES-QA-06 | isolated SLA timer lifecycle', () => {
  let base;
  let password;
  let tokens;
  let fixture;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des06Note', message, { log: false });
  const request = (method, path, token, body) => cy.request({
    method, url: base + path, failOnStatusCode: false, log: false, timeout: 20000,
    headers: { Authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'Idempotency-Key': key() }) },
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

  const reserve = (available) => {
    if (!available.length) return cy.wrap(null, { log: false });
    const table = available.shift();
    return request('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter, { guest_count: 2 })
      .then((response) => {
        if (response.status === 409) return reserve(available);
        expect(response.status, `open ${table.code}`).eq(201);
        fixture = { tableId: table.id, tableCode: table.code, sessionId: response.body?.id };
        expect(fixture.sessionId, 'session ID').to.be.a('string').and.not.be.empty;
        return table;
      });
  };

  const setupFixture = (context) => request('GET', '/api/v1/tables', tokens.waiter)
    .then((tables) => {
      expect(tables.status, 'GET tables').eq(200);
      expect(tables.body, 'table list').to.be.an('array');
      const available = tables.body.filter((table) =>
        /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
      if (!available.length) return note('DES06 lifecycle PENDING: B1-B4 unavailable; no data changed')
        .then(() => context.skip());
      return request('GET', '/api/v1/menu?available_only=true', tokens.waiter)
        .then((menu) => {
          expect(menu.status, 'GET menu').eq(200);
          expect(menu.body, 'menu list').to.be.an('array');
          const item = menu.body.find((entry) => entry.is_available && entry.station_id);
          expect(item, 'mapped menu item').to.exist;
          return reserve(available).then((table) => {
            if (!table) return note('DES06 lifecycle PENDING: no table could be reserved')
              .then(() => context.skip());
            return request('POST', '/api/v1/orders', tokens.waiter, { table_session_id: fixture.sessionId })
              .then((order) => {
                expect(order.status, 'create order').eq(201);
                fixture.orderId = order.body?.id;
                expect(fixture.orderId, 'created order ID').to.be.a('string').and.not.be.empty;
                return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter, {
                  items: [{ menu_item_id: item.id, quantity: 1, note: 'DES06 SLA isolated' }],
                });
              }).then((added) => {
                expect(added.status, 'add isolated item').eq(201);
                fixture.itemId = added.body?.items?.[0]?.id;
                fixture.stationId = item.station_id;
                expect(fixture.itemId, 'created item ID').to.be.a('string').and.not.be.empty;
                return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter);
              }).then((sent) => {
                expect(sent.status, 'Send to Kitchen').eq(200);
                expect(sent.body?.kitchen_queue_entries_created, 'one ticket created').eq(1);
                return note(`DES06 lifecycle fixture: table ${fixture.tableCode}; order ${fixture.orderId}; item ${fixture.itemId}; station ${fixture.stationId}`);
              });
          });
        });
    });

  const itemStatus = (expected) => request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.kitchen)
    .then((response) => {
      expect(response.status, 'GET own order').eq(200);
      expect(response.body?.id, 'own order ID').eq(fixture.orderId);
      const item = response.body?.items?.find((entry) => entry.id === fixture.itemId);
      expect(item, 'own item').to.exist;
      expect(item.status, 'item status').eq(expected);
      return item;
    });

  const queueStatus = (expected) => request('GET',
    `/api/v1/kitchen/queue?status=${encodeURIComponent(expected)}`, tokens.kitchen)
    .then((response) => {
      expect(response.status, `queue ${expected}`).eq(200);
      const matches = response.body.filter((entry) =>
        entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId);
      expect(matches, `exactly one ${expected} ticket for own item`).to.have.length(1);
      expect(matches[0].status, 'ticket status').eq(expected);
      expect(matches[0].station_id, 'menu station').eq(fixture.stationId);
      return matches[0];
    });

  const transition = (action, token, status) => request('POST',
    `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}/${action}`, token)
    .then((response) => {
      expect(response.status, `POST ${action}`).eq(200);
      expect(response.body?.items?.find((item) => item.id === fixture.itemId)?.status,
        `${action} response status`).eq(status);
      return itemStatus(status);
    });

  beforeEach(function () {
    fixture = null;
    return cy.env(['POS_BASE_URL', 'DES06_SEED_PASSWORD'], { log: false }).then((env) => {
      base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      password = env.DES06_SEED_PASSWORD;
      if (!password) return note('DES06 lifecycle PENDING: local staging password absent')
        .then(() => this.skip());
      tokens = {};
      return login('waiter').then((token) => { tokens.waiter = token; })
        .then(() => login('kitchen')).then((token) => { tokens.kitchen = token; })
        .then(() => login('cashier')).then((token) => { tokens.cashier = token; })
        .then(() => setupFixture(this));
    });
  });

  afterEach(() => {
    if (!fixture) return;
    const { orderId, tableId, tableCode } = fixture;
    if (!orderId) throw new Error(`CLEANUP REQUIRED: ${tableCode} (${tableId}) has a session but no order`);
    return request('POST', `/api/v1/orders/${orderId}/request-billing`, tokens.waiter)
      .then((billing) => {
        if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} billing HTTP ${billing.status}`);
        return request('POST', `/api/v1/orders/${orderId}/pay`, tokens.cashier);
      }).then((paid) => {
        if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} pay HTTP ${paid.status}`);
        return request('POST', `/api/v1/orders/${orderId}/close`, tokens.cashier);
      }).then((closed) => {
        if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} close HTTP ${closed.status}`);
        return request('POST', `/api/v1/tables/${tableId}/mark-clean`, tokens.waiter);
      }).then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`DES06 lifecycle cleanup: ${tableCode} AVAILABLE; order ${orderId} CLOSED`);
      });
  });

  it('DES06-TC-010 | SLA timer starts at Start Cooking, not Send', () => {
    return itemStatus('SENT').then(() => queueStatus('QUEUED')).then((queued) => {
      expect(queued.started_at, 'QUEUED ticket has no start timestamp').to.be.null;
      expect(queued.elapsed_minutes, 'QUEUED timer has not begun').to.be.null;
      expect(queued.sla_status, 'QUEUED SLA status').eq('NORMAL');
      return transition('start-cooking', tokens.kitchen, 'PREPARING')
        .then(() => queueStatus('IN_PROGRESS')).then((cooking) => {
          expect(cooking.id, 'same ticket transitions to IN_PROGRESS').eq(queued.id);
          expect(cooking.started_at, 'Start Cooking sets started_at').to.be.a('string').and.not.be.empty;
          expect(Number.isFinite(Date.parse(cooking.started_at)), 'started_at is a valid timestamp').eq(true);
          expect(Number.isFinite(Date.parse(queued.queued_at)), 'queued_at is a valid timestamp').eq(true);
          expect(Date.parse(cooking.started_at) >= Date.parse(queued.queued_at),
            'timer starts after ticket is queued').eq(true);
          expect(typeof cooking.elapsed_minutes === 'number' && cooking.elapsed_minutes >= 0,
            'IN_PROGRESS elapsed_minutes runs').eq(true);
          expect(cooking.sla_status, 'newly started SLA').eq('NORMAL');
          return note(`DES06-TC-010 assertions OK: order ${fixture.orderId}; item ${fixture.itemId}; QUEUED timer null, IN_PROGRESS started_at present; cleanup follows`);
        });
    });
  });

  it('DES06-TC-013 | READY stops the ticket SLA timer', () => {
    return transition('start-cooking', tokens.kitchen, 'PREPARING')
      .then(() => queueStatus('IN_PROGRESS')).then((cooking) => {
        expect(cooking.started_at, 'cooking started_at').to.be.a('string').and.not.be.empty;
        expect(typeof cooking.elapsed_minutes === 'number', 'cooking timer running').eq(true);
        return transition('mark-ready', tokens.kitchen, 'READY')
          .then(() => queueStatus('DONE')).then((done) => {
            expect(done.id, 'same ticket reaches DONE').eq(cooking.id);
            expect(done.started_at, 'start timestamp retained').eq(cooking.started_at);
            expect(done.elapsed_minutes, 'DONE timer is no longer running').to.be.null;
            expect(done.sla_status, 'DONE SLA is no longer alerting').eq('NORMAL');
            return request('GET', '/api/v1/kitchen/queue', tokens.kitchen).then((active) => {
              expect(active.status, 'active queue GET').eq(200);
              expect(active.body.some((entry) => entry.id === done.id),
                'DONE ticket absent from active Queue').eq(false);
              return note(`DES06-TC-013 assertions OK: order ${fixture.orderId}; ticket ${done.id}; READY/DONE timer null, active Queue excludes ticket; cleanup follows`);
            });
          });
      });
  });
});
