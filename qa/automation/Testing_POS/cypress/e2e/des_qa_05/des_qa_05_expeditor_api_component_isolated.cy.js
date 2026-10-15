// Partial API coverage for DES05-TC-016/017/025 on two seeded stations.
// No Expeditor endpoint, UI, modifier or six-station behavior is asserted.
describe('DES-QA-05 | mixed-station readiness API component', () => {
  let base;
  let password;
  let tokens;
  let fixture;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des05Note', message, { log: false });
  const req = (method, path, token, body) => cy.request({
    method, url: base + path, failOnStatusCode: false, log: false, timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'Idempotency-Key': key() }),
    },
    ...(body === undefined ? {} : { body }),
  });
  const login = (username) => cy.request({
    method: 'POST', url: base + '/api/v1/auth/login',
    body: { username, password: String(password) },
    failOnStatusCode: false, log: false, timeout: 20000,
  }).then((response) => {
    expect(response.status, `${username} login`).eq(200);
    expect(response.body?.access_token, `${username} token`).to.be.a('string').and.not.be.empty;
    return response.body.access_token;
  });

  const reserve = (tables) => {
    if (!tables.length) return cy.wrap(null, { log: false });
    const table = tables.shift();
    return req('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter,
      { guest_count: 2 }).then((opened) => {
      if (opened.status === 409) return reserve(tables);
      expect(opened.status, `open ${table.code}`).eq(201);
      fixture = { tableId: table.id, tableCode: table.code, sessionId: opened.body?.id };
      expect(fixture.sessionId, 'session ID').to.be.a('string').and.not.be.empty;
      return table;
    });
  };

  const setup = (context) => req('GET', '/api/v1/menu?available_only=true', tokens.waiter)
    .then((menu) => {
      expect(menu.status, 'GET menu').eq(200);
      expect(menu.body, 'available menu').to.be.an('array');
      const byStation = new Map();
      menu.body.filter((item) => item.is_available && item.station_id)
        .forEach((item) => { if (!byStation.has(item.station_id)) byStation.set(item.station_id, item); });
      if (byStation.size < 2) {
        return note(`DES05 API component PENDING: ${byStation.size}/2 mapped stations; no mutation`)
          .then(() => context.skip());
      }
      const selected = [...byStation.values()].slice(0, 2);
      return req('GET', '/api/v1/tables', tokens.waiter).then((response) => {
        expect(response.status, 'GET tables').eq(200);
        const available = response.body.filter((table) =>
          /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
        if (!available.length) return note('DES05 API component PENDING: B1-B4 unavailable; no mutation')
          .then(() => context.skip());
        return reserve(available).then((table) => {
          if (!table) return note('DES05 API component PENDING: no table reserved')
            .then(() => context.skip());
          return req('POST', '/api/v1/orders', tokens.waiter,
            { table_session_id: fixture.sessionId }).then((order) => {
            expect(order.status, 'create order').eq(201);
            fixture.orderId = order.body?.id;
            expect(fixture.orderId, 'order ID').to.be.a('string').and.not.be.empty;
            return req('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter, {
              items: selected.map((item) => ({
                menu_item_id: item.id, quantity: 1, note: 'DES05 mixed-station API component',
              })),
            });
          }).then((added) => {
            expect(added.status, 'add two items').eq(201);
            expect(added.body?.items, 'created items').to.have.length(2);
            fixture.items = selected.map((menuItem) => {
              const matches = added.body.items.filter((item) => item.menu_item_id === menuItem.id);
              expect(matches, `own item from ${menuItem.id}`).to.have.length(1);
              return { id: matches[0].id, stationId: menuItem.station_id };
            });
            return req('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter);
          }).then((sent) => {
            expect(sent.status, 'send two items').eq(200);
            expect(sent.body?.kitchen_queue_entries_created, 'two tickets').eq(2);
            return note(`DES05 API component fixture: ${fixture.tableCode}; order ${fixture.orderId}; ` +
              `items ${fixture.items.map((item) => item.id).join(',')}; ` +
              `stations ${fixture.items.map((item) => item.stationId).join(',')}`);
          });
        });
      });
    });

  const action = (item, step, token, expected) => req('POST',
    `/api/v1/orders/${fixture.orderId}/items/${item.id}/${step}`, token)
    .then((response) => {
      expect(response.status, `${step} HTTP`).eq(200);
      expect(response.body?.items?.find((entry) => entry.id === item.id)?.status,
        `${step} item status`).eq(expected);
    });

  const orderStatuses = (expected) => req('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter)
    .then((response) => {
      expect(response.status, 'GET own order').eq(200);
      fixture.items.forEach((item, index) => {
        expect(response.body?.items?.find((entry) => entry.id === item.id)?.status,
          `own order item ${index + 1}`).eq(expected[index]);
      });
    });

  const queueEntry = (item, status) => req('GET',
    `/api/v1/kitchen/queue?station_id=${item.stationId}&status=${status}`, tokens.kitchen)
    .then((response) => {
      expect(response.status, `${status} station queue HTTP`).eq(200);
      const own = response.body.filter((entry) => entry.order_id === fixture.orderId);
      expect(own, `only own item in ${item.stationId} ${status}`).to.have.length(1);
      expect(own[0].order_item_id, 'correct station item').eq(item.id);
      expect(own[0].station_id, 'menu routing').eq(item.stationId);
      expect(own[0].status, 'queue ticket status').eq(status);
      return own[0];
    });

  beforeEach(function () {
    fixture = null;
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD', 'DES05_TC025_ONLY']).then((env) => {
      if (env.DES05_TC025_ONLY && !this.currentTest.title.startsWith('API-COMP-025')) {
        return this.skip();
      }
      base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      password = env.DES05_SEED_PASSWORD;
      if (!password) return note('DES05 API component PENDING: local password absent')
        .then(() => this.skip());
      tokens = {};
      return login('waiter').then((token) => { tokens.waiter = token; })
        .then(() => login('kitchen')).then((token) => { tokens.kitchen = token; })
        .then(() => login('cashier')).then((token) => { tokens.cashier = token; })
        .then(() => setup(this));
    });
  });

  afterEach(() => {
    if (!fixture) return;
    const { orderId, tableId, tableCode } = fixture;
    if (!orderId) throw new Error(`CLEANUP REQUIRED: ${tableCode} (${tableId}) has session without order`);
    return req('POST', `/api/v1/orders/${orderId}/request-billing`, tokens.waiter)
      .then((billing) => {
        if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} billing HTTP ${billing.status}`);
        return req('POST', `/api/v1/orders/${orderId}/pay`, tokens.cashier);
      }).then((paid) => {
        if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} pay HTTP ${paid.status}`);
        return req('POST', `/api/v1/orders/${orderId}/close`, tokens.cashier);
      }).then((closed) => {
        if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} close HTTP ${closed.status}`);
        return req('POST', `/api/v1/tables/${tableId}/mark-clean`, tokens.waiter);
      }).then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`DES05 API component cleanup: ${tableCode} AVAILABLE; order ${orderId} CLOSED`);
      });
  });

  it('API-COMP-016 | mixed stations retain one READY and one PREPARING item', () => {
    const [ready, cooking] = fixture.items;
    return action(ready, 'start-cooking', tokens.kitchen, 'PREPARING')
      .then(() => action(cooking, 'start-cooking', tokens.kitchen, 'PREPARING'))
      .then(() => action(ready, 'mark-ready', tokens.kitchen, 'READY'))
      .then(() => orderStatuses(['READY', 'PREPARING']))
      .then(() => queueEntry(ready, 'DONE'))
      .then(() => queueEntry(cooking, 'IN_PROGRESS'))
      .then(() => note(`API-COMP-016 PASS: order ${fixture.orderId}; ` +
        `READY/DONE ${ready.id} at ${ready.stationId}; ` +
        `PREPARING/IN_PROGRESS ${cooking.id} at ${cooking.stationId}; Expeditor UI untested`));
  });

  it('API-COMP-017 | both stations READY then Waiter picks up both items', () => {
    const [first, second] = fixture.items;
    return action(first, 'start-cooking', tokens.kitchen, 'PREPARING')
      .then(() => action(second, 'start-cooking', tokens.kitchen, 'PREPARING'))
      .then(() => action(first, 'mark-ready', tokens.kitchen, 'READY'))
      .then(() => action(second, 'mark-ready', tokens.kitchen, 'READY'))
      .then(() => orderStatuses(['READY', 'READY']))
      .then(() => queueEntry(first, 'DONE'))
      .then(() => queueEntry(second, 'DONE'))
      .then(() => action(first, 'pickup', tokens.waiter, 'PICKED_UP'))
      .then(() => action(second, 'pickup', tokens.waiter, 'PICKED_UP'))
      .then(() => orderStatuses(['PICKED_UP', 'PICKED_UP']))
      .then(() => note(`API-COMP-017 PASS: order ${fixture.orderId}; ` +
        `two station tickets DONE, both items PICKED_UP; Expeditor UI untested`));
  });

  it('API-COMP-025 | two stations complete lifecycle and one served item is refired', () => {
    const [first, second] = fixture.items;
    let originalTicketId;
    let refireTicketId;
    let versionBefore;
    return action(first, 'start-cooking', tokens.kitchen, 'PREPARING')
      .then(() => action(second, 'start-cooking', tokens.kitchen, 'PREPARING'))
      .then(() => action(first, 'mark-ready', tokens.kitchen, 'READY'))
      .then(() => action(second, 'mark-ready', tokens.kitchen, 'READY'))
      .then(() => queueEntry(first, 'DONE')).then((ticket) => { originalTicketId = ticket.id; })
      .then(() => queueEntry(second, 'DONE'))
      .then(() => action(first, 'pickup', tokens.waiter, 'PICKED_UP'))
      .then(() => action(second, 'pickup', tokens.waiter, 'PICKED_UP'))
      .then(() => action(first, 'served', tokens.waiter, 'SERVED'))
      .then(() => action(second, 'served', tokens.waiter, 'SERVED'))
      .then(() => orderStatuses(['SERVED', 'SERVED']))
      .then(() => req('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter))
      .then((before) => {
        expect(before.status, 'GET before Refire').eq(200);
        versionBefore = before.body?.current_version;
        expect(versionBefore, 'version before Refire').to.be.a('number');
        return login('admin');
      }).then((admin) => req('POST',
        `/api/v1/orders/${fixture.orderId}/items/${first.id}/refire`, admin))
      .then((refired) => {
        expect(refired.status, 'Refire HTTP').eq(200);
        expect(refired.body?.current_version, 'Refire version +1').eq(versionBefore + 1);
        expect(refired.body?.items, 'same two order items').to.have.length(2);
        expect(refired.body.items.find((item) => item.id === first.id)?.status,
          'refired item status').eq('REFIRED');
        return queueEntry(first, 'QUEUED');
      }).then((ticket) => {
        refireTicketId = ticket.id;
        expect(refireTicketId, 'new ticket differs from completed ticket').not.eq(originalTicketId);
        return queueEntry(second, 'DONE');
      }).then(() => action(first, 'start-cooking', tokens.kitchen, 'PREPARING'))
      .then(() => queueEntry(first, 'IN_PROGRESS'))
      .then(() => action(first, 'mark-ready', tokens.kitchen, 'READY'))
      .then(() => action(first, 'pickup', tokens.waiter, 'PICKED_UP'))
      .then(() => action(first, 'served', tokens.waiter, 'SERVED'))
      .then(() => orderStatuses(['SERVED', 'SERVED']))
      .then(() => req('GET',
        `/api/v1/kitchen/queue?station_id=${first.stationId}&status=DONE`, tokens.kitchen))
      .then((queue) => {
        expect(queue.status, 'DONE queue HTTP').eq(200);
        const own = queue.body.filter((entry) =>
          entry.order_id === fixture.orderId && entry.order_item_id === first.id);
        expect(own.map((entry) => entry.id).sort(), 'original and Refire tickets DONE')
          .to.deep.eq([originalTicketId, refireTicketId].sort());
        return note(`API-COMP-025 PASS: order ${fixture.orderId}; two stations ${first.stationId},${second.stationId}; ` +
          `both items served; Refire ${originalTicketId} -> ${refireTicketId} cooked and served; ` +
          `version ${versionBefore} -> ${versionBefore + 1}; modifier and six-station E2E untested`);
      });
  });
});
