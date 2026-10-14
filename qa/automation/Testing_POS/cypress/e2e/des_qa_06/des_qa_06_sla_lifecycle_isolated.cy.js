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

  const setupFixture = (context, multiple = false) => request('GET', '/api/v1/tables', tokens.waiter)
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
          const other = multiple && menu.body.find((entry) =>
            entry.is_available && entry.station_id && entry.station_id !== item.station_id);
          if (multiple && !other) return note('DES06-TC-015 PENDING: fewer than two mapped stations; no data changed')
            .then(() => context.skip());
          const menuItems = multiple ? [item, other] : [item];
          return reserve(available).then((table) => {
            if (!table) return note('DES06 lifecycle PENDING: no table could be reserved')
              .then(() => context.skip());
            return request('POST', '/api/v1/orders', tokens.waiter, { table_session_id: fixture.sessionId })
              .then((order) => {
                expect(order.status, 'create order').eq(201);
                fixture.orderId = order.body?.id;
                expect(fixture.orderId, 'created order ID').to.be.a('string').and.not.be.empty;
                return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter, {
                  items: menuItems.map((entry) => ({
                    menu_item_id: entry.id, quantity: 1, note: 'DES06 SLA isolated',
                  })),
                });
              }).then((added) => {
                expect(added.status, 'add isolated item').eq(201);
                fixture.itemIds = menuItems.map((entry) =>
                  added.body?.items?.find((addedItem) => addedItem.menu_item_id === entry.id)?.id);
                fixture.stationIds = menuItems.map((entry) => entry.station_id);
                fixture.itemId = fixture.itemIds[0];
                fixture.stationId = item.station_id;
                fixture.itemIds.forEach((id) => expect(id, 'created item ID').to.be.a('string').and.not.be.empty);
                return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter);
              }).then((sent) => {
                expect(sent.status, 'Send to Kitchen').eq(200);
                expect(sent.body?.kitchen_queue_entries_created, 'ticket count').eq(menuItems.length);
                return note(`DES06 lifecycle fixture: table ${fixture.tableCode}; order ${fixture.orderId}; items ${fixture.itemIds.join(',')}; stations ${fixture.stationIds.join(',')}`);
              });
          });
        });
    });

  const itemStatus = (expected, itemId = fixture.itemId) => request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.kitchen)
    .then((response) => {
      expect(response.status, 'GET own order').eq(200);
      expect(response.body?.id, 'own order ID').eq(fixture.orderId);
      const item = response.body?.items?.find((entry) => entry.id === itemId);
      expect(item, 'own item').to.exist;
      expect(item.status, 'item status').eq(expected);
      return item;
    });

  const queueStatus = (expected, itemId = fixture.itemId, stationId = fixture.stationId) => request('GET',
    `/api/v1/kitchen/queue?status=${encodeURIComponent(expected)}`, tokens.kitchen)
    .then((response) => {
      expect(response.status, `queue ${expected}`).eq(200);
      const matches = response.body.filter((entry) =>
        entry.order_id === fixture.orderId && entry.order_item_id === itemId);
      expect(matches, `exactly one ${expected} ticket for own item`).to.have.length(1);
      expect(matches[0].status, 'ticket status').eq(expected);
      expect(matches[0].station_id, 'menu station').eq(stationId);
      return matches[0];
    });

  const transition = (action, token, status, itemId = fixture.itemId) => request('POST',
    `/api/v1/orders/${fixture.orderId}/items/${itemId}/${action}`, token)
    .then((response) => {
      expect(response.status, `POST ${action}`).eq(200);
      expect(response.body?.items?.find((item) => item.id === itemId)?.status,
        `${action} response status`).eq(status);
      return itemStatus(status, itemId);
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
        .then(() => setupFixture(this, this.currentTest.title.includes('DES06-TC-015')));
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

  it('DES06-TC-015 | one READY item does not stop another station ticket timer', () => {
    const [first, second] = fixture.itemIds;
    const [, secondStation] = fixture.stationIds;
    return queueStatus('QUEUED', first).then((firstQueued) => {
      expect(firstQueued.started_at, 'first timer not started').to.be.null;
      return queueStatus('QUEUED', second, secondStation);
    }).then((secondQueued) => {
      expect(secondQueued.started_at, 'second timer not started').to.be.null;
      return transition('start-cooking', tokens.kitchen, 'PREPARING', first);
    }).then(() => transition('start-cooking', tokens.kitchen, 'PREPARING', second))
      .then(() => queueStatus('IN_PROGRESS', first)).then((firstCooking) => {
        expect(firstCooking.started_at, 'first started_at').to.be.a('string').and.not.be.empty;
        return queueStatus('IN_PROGRESS', second, secondStation);
      }).then((secondCooking) => {
        expect(secondCooking.started_at, 'second started_at').to.be.a('string').and.not.be.empty;
        expect(secondCooking.elapsed_minutes, 'second timer running').to.be.a('number');
        return transition('mark-ready', tokens.kitchen, 'READY', first).then(() =>
          queueStatus('DONE', first)).then((firstDone) => {
          expect(firstDone.elapsed_minutes, 'READY timer stopped').to.be.null;
          return queueStatus('IN_PROGRESS', second, secondStation);
        }).then((stillCooking) => {
          expect(stillCooking.id, 'second ticket unchanged').eq(secondCooking.id);
          expect(stillCooking.started_at, 'second timer start retained').eq(secondCooking.started_at);
          expect(stillCooking.elapsed_minutes, 'second timer still running').to.be.a('number');
          return request('GET', '/api/v1/kitchen/queue', tokens.kitchen);
        }).then((active) => {
          expect(active.status, 'active queue').eq(200);
          const own = active.body.filter((entry) => entry.order_id === fixture.orderId);
          expect(own.map((entry) => entry.order_item_id), 'only second ticket remains active').deep.eq([second]);
          return note(`DES06-TC-015 assertions OK: order ${fixture.orderId}; READY ${first} timer stopped; IN_PROGRESS ${second} on station ${secondStation} timer running; cleanup follows`);
        });
      });
  });
});
