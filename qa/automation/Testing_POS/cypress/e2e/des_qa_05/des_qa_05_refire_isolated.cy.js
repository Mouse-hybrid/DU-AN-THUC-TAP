// Every test creates its own order and cleans only its own table/order.
// Actor audit evidence is collected separately from these lifecycle assertions.
describe('DES-QA-05 | isolated Refire behavior', () => {
  let base;
  let password;
  let tokens;
  let fixture;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des05Note', message, { log: false });
  const request = (method, path, token, body, idempotencyKey) => cy.request({
    method, url: base + path, failOnStatusCode: false, log: false, timeout: 20000,
    headers: { Authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'Idempotency-Key': idempotencyKey || key() }) },
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
  const itemPath = () => `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}`;
  const ownItem = (response, expected, label) => {
    expect(response.status, `${label} HTTP`).eq(200);
    expect(response.body?.id, `${label} order`).eq(fixture.orderId);
    const item = response.body?.items?.find((entry) => entry.id === fixture.itemId);
    expect(item, `${label} exact item`).to.exist;
    expect(item.status, `${label} item status`).eq(expected);
    return response.body;
  };
  const order = (expected) => request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.admin)
    .then((response) => ownItem(response, expected, 'GET own order'));
  const queue = (status) => request('GET',
    `/api/v1/kitchen/queue?status=${status}`, tokens.kitchen)
    .then((response) => {
      expect(response.status, `queue ${status} HTTP`).eq(200);
      expect(response.body, `queue ${status}`).to.be.an('array');
      return response.body.filter((entry) =>
        entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId);
    });
  const step = (action, token, expected) => request('POST', `${itemPath()}/${action}`, token)
    .then((response) => {
      ownItem(response, expected, `POST ${action}`);
      return order(expected);
    });

  const reserve = (available) => {
    if (!available.length) return cy.wrap(null, { log: false });
    const table = available.shift();
    return request('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter, { guest_count: 2 })
      .then((response) => {
        if (response.status === 409) return reserve(available);
        expect(response.status, `open ${table.code}`).eq(201);
        fixture = { tableId: table.id, tableCode: table.code, sessionId: response.body?.id };
        expect(fixture.sessionId, 'new session').to.be.a('string').and.not.be.empty;
        return table;
      });
  };
  const setup = (context) => request('GET', '/api/v1/tables', tokens.waiter).then((tables) => {
    expect(tables.status, 'GET tables').eq(200);
    expect(tables.body, 'table list').to.be.an('array');
    const available = tables.body.filter((table) =>
      /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
    if (!available.length) return note('DES05 Refire PENDING: no AVAILABLE B1-B4 table')
      .then(() => context.skip());
    return request('GET', '/api/v1/menu?available_only=true', tokens.waiter).then((menu) => {
      expect(menu.status, 'GET menu').eq(200);
      const candidate = menu.body.find((item) => item.is_available && item.station_id);
      expect(candidate, 'mapped menu item').to.exist;
      return reserve(available).then((table) => {
        if (!table) return note('DES05 Refire PENDING: table reservation lost to another client')
          .then(() => context.skip());
        return request('POST', '/api/v1/orders', tokens.waiter,
          { table_session_id: fixture.sessionId }).then((created) => {
          expect(created.status, 'create order').eq(201);
          fixture.orderId = created.body?.id;
          expect(fixture.orderId, 'order ID').to.be.a('string').and.not.be.empty;
          return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter, {
            items: [{ menu_item_id: candidate.id, quantity: 1, note: 'DES05 Refire isolated' }],
          });
        }).then((added) => {
          expect(added.status, 'add item').eq(201);
          fixture.itemId = added.body?.items?.[0]?.id;
          fixture.stationId = candidate.station_id;
          expect(fixture.itemId, 'item ID').to.be.a('string').and.not.be.empty;
          return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter);
        }).then((sent) => {
          expect(sent.status, 'Send').eq(200);
          expect(sent.body?.kitchen_queue_entries_created, 'one initial ticket').eq(1);
          return note(`DES05 Refire fixture: table ${fixture.tableCode}; order ${fixture.orderId}; item ${fixture.itemId}; SENT`);
        });
      });
    });
  });
  const serve = () => step('start-cooking', tokens.kitchen, 'PREPARING')
    .then(() => step('mark-ready', tokens.kitchen, 'READY'))
    .then(() => step('pickup', tokens.waiter, 'PICKED_UP'))
    .then(() => step('served', tokens.waiter, 'SERVED'))
    .then(() => queue('DONE')).then((done) => {
      expect(done, 'original DONE ticket').to.have.length(1);
      return done[0];
    });
  const refire = (idempotencyKey) => request('POST', `${itemPath()}/refire`, tokens.admin,
    undefined, idempotencyKey);
  const summarySubtotal = () => request('GET',
    `/api/v1/orders?table_id=${fixture.tableId}&limit=50`, tokens.admin)
    .then((response) => {
      expect(response.status, 'GET order summaries').eq(200);
      const own = response.body.find((record) => record.id === fixture.orderId);
      expect(own, 'own order summary').to.exist;
      return Number(own.subtotal);
    });

  beforeEach(function () {
    fixture = null;
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD']).then((env) => {
      base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      password = env.DES05_SEED_PASSWORD;
      if (!password) return note('DES05 Refire PENDING: local staging password absent')
        .then(() => this.skip());
      tokens = {};
      return login('waiter').then((value) => { tokens.waiter = value; })
        .then(() => login('kitchen')).then((value) => { tokens.kitchen = value; })
        .then(() => login('cashier')).then((value) => { tokens.cashier = value; })
        .then(() => login('admin')).then((value) => { tokens.admin = value; })
        .then(() => setup(this));
    });
  });
  afterEach(() => {
    if (!fixture) return;
    const { orderId, tableId, tableCode } = fixture;
    if (!orderId) throw new Error(`CLEANUP REQUIRED: ${tableCode} (${tableId}) has session but no order`);
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
        return note(`DES05 Refire cleanup: ${tableCode} AVAILABLE; order ${orderId} CLOSED`);
      });
  });

  it('DES05-TC-019 | one Refire adds a new QUEUED ticket and version', () =>
    serve().then((original) => order('SERVED').then((before) =>
      summarySubtotal().then((subtotalBefore) => {
        expect(Number.isFinite(subtotalBefore), 'starting subtotal').eq(true);
        return refire(key()).then((response) => {
          const after = ownItem(response, 'REFIRED', 'Refire once');
          expect(after.current_version, 'version +1').eq(before.current_version + 1);
          expect(after.items, 'no new order item').to.have.length(before.items.length);
          return queue('QUEUED').then((tickets) => {
            expect(tickets, 'one new ticket').to.have.length(1);
            expect(tickets[0].id, 'distinct ticket ID').not.eq(original.id);
            expect(tickets[0].station_id, 'same station').eq(original.station_id);
            return summarySubtotal().then((subtotalAfter) => {
              expect(subtotalAfter, 'subtotal unchanged').eq(subtotalBefore);
              return note(`DES05-TC-019 / TC_EXT_012 assertions OK (actor audit separate): order ${fixture.orderId}; item ${fixture.itemId}; ticket ${original.id} -> ${tickets[0].id}; version ${before.current_version} -> ${after.current_version}; subtotal ${subtotalBefore} -> ${subtotalAfter}`);
            });
          });
        });
      }))));

  it('DES05-TC-020 | same Refire key replays one result and one ticket', () =>
    serve().then(() => order('SERVED').then((before) =>
      summarySubtotal().then((subtotalBefore) => {
        expect(Number.isFinite(subtotalBefore), 'starting subtotal').eq(true);
        const replayKey = key();
        return refire(replayKey).then((first) => {
          ownItem(first, 'REFIRED', 'first Refire');
          return queue('QUEUED').then((created) => {
            expect(created, 'one new ticket').to.have.length(1);
            return refire(replayKey).then((second) => {
              expect(second.status, 'retry HTTP').eq(first.status);
              expect(second.body, 'cached response').to.deep.eq(first.body);
              return order('REFIRED').then((after) => {
                expect(after.current_version, 'version increments once').eq(before.current_version + 1);
                return queue('QUEUED').then((tickets) => {
                  expect(tickets, 'still one new ticket').to.have.length(1);
                  expect(tickets[0].id, 'same ticket').eq(created[0].id);
                  return summarySubtotal().then((subtotalAfter) => {
                    expect(subtotalAfter, 'subtotal unchanged after replay').eq(subtotalBefore);
                    return note(`DES05-TC-020 / TC_EXT_013 assertions OK: order ${fixture.orderId}; one Refire ticket ${tickets[0].id}; same-key response replayed; version ${before.current_version} -> ${after.current_version}; subtotal ${subtotalBefore} -> ${subtotalAfter}`);
                  });
                });
              });
            });
          });
        });
      }))));

  it('DES05-TC-021 | Refire leaves order subtotal unchanged', () =>
    serve().then(() => summarySubtotal().then((before) => {
      expect(Number.isFinite(before), 'valid starting subtotal').eq(true);
      return refire(key()).then((response) => {
        ownItem(response, 'REFIRED', 'Refire for subtotal');
        return summarySubtotal().then((after) => {
          expect(after, 'subtotal unchanged').eq(before);
          return note(`DES05-TC-021 assertions OK: order ${fixture.orderId}; subtotal ${before} -> ${after}`);
        });
      });
    })));

  it('DES05-TC-022 | Kitchen cannot Refire a SERVED item', () =>
    serve().then(() => order('SERVED').then((before) =>
      request('POST', `${itemPath()}/refire`, tokens.kitchen).then((denied) => {
        expect(denied.status, 'Kitchen Refire forbidden').eq(403);
        return order('SERVED').then((after) => {
          expect(after.current_version, 'version unchanged').eq(before.current_version);
          return queue('QUEUED').then((tickets) => {
            expect(tickets, 'no new ticket').to.have.length(0);
            return note(`DES05-TC-022 assertions OK: order ${fixture.orderId}; Kitchen HTTP 403, no new ticket`);
          });
        });
      }))));

  it('DES05-TC-023 | SENT item Refire rejects 409 without mutation', () =>
    order('SENT').then((before) => queue('QUEUED').then((original) => {
      expect(original, 'one initial ticket').to.have.length(1);
      return refire(key()).then((rejected) => {
        expect(rejected.status, 'invalid Refire status').eq(409);
        expect(String(rejected.body?.detail), 'conflict mentions SENT').to.include('SENT');
        return order('SENT').then((after) => {
          expect(after.current_version, 'version unchanged').eq(before.current_version);
          return queue('QUEUED').then((tickets) => {
            expect(tickets, 'only original ticket').to.have.length(1);
            expect(tickets[0].id, 'same ticket').eq(original[0].id);
            return note(`DES05-TC-023 assertions OK: order ${fixture.orderId}; SENT Refire HTTP 409; ticket unchanged`);
          });
        });
      });
    })));

  it('DES05-TC-024 | second deliberate Refire uses another ticket', () =>
    serve().then(() => refire(key()).then((first) => {
      ownItem(first, 'REFIRED', 'first Refire');
      return queue('QUEUED').then((firstTickets) => {
        expect(firstTickets, 'first refire ticket').to.have.length(1);
        return step('start-cooking', tokens.kitchen, 'PREPARING')
          .then(() => step('mark-ready', tokens.kitchen, 'READY'))
          .then(() => step('pickup', tokens.waiter, 'PICKED_UP'))
          .then(() => step('served', tokens.waiter, 'SERVED'))
          .then(() => refire(key())).then((second) => {
            const after = ownItem(second, 'REFIRED', 'second Refire');
            expect(after.current_version, 'two separate Refire version increments')
              .eq(first.body.current_version + 1);
            return queue('QUEUED').then((tickets) => {
              expect(tickets, 'one active ticket for second Refire').to.have.length(1);
              expect(tickets[0].id, 'distinct deliberate Refire ticket').not.eq(firstTickets[0].id);
              return queue('DONE').then((completed) => {
                expect(completed, 'original and first Refire completed').to.have.length(2);
                return note(`DES05-TC-024 assertions OK: order ${fixture.orderId}; first Refire ${firstTickets[0].id}; second Refire ${tickets[0].id}`);
              });
            });
          });
      });
    })));
});
