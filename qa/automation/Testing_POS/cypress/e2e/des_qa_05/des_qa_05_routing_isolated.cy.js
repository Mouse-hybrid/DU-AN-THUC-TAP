// Creates a fresh order on an AVAILABLE B1-B4 table for each case.
// Billing/pay/close/mark-clean restore the table after a successful Send.
// An interrupted run can leave QA data behind: inspect the printed IDs before resetting staging.
describe('DES-QA-05 | isolated KDS routing on two seeded stations', () => {
  let base;
  let password;
  let fixture;
  let tokens;

  const key = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const note = (message) => cy.task('des05Note', message, { log: false });
  const req = (method, path, token, body, idempotencyKey) => cy.request({
    method, url: base + path, failOnStatusCode: false, log: false, timeout: 20000,
    headers: { Authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'Idempotency-Key': idempotencyKey || key() } : {}) },
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

  const reserveTable = (available) => {
    if (!available.length) return cy.wrap(null, { log: false });
    const table = available.shift();
    return req('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter, { guest_count: 2 })
      .then((opened) => {
        if (opened.status === 409) return reserveTable(available); // Another tester got there first.
        expect(opened.status, `open ${table.code}`).eq(201);
        fixture = { tableId: table.id, tableCode: table.code, sessionId: opened.body?.id };
        expect(fixture.sessionId, 'new table session').to.be.a('string').and.not.be.empty;
        return table;
      });
  };

  const createOrder = () => req('GET', '/api/v1/tables', tokens.waiter).then((response) => {
    expect(response.status, 'GET tables').eq(200);
    const candidates = response.body.filter((table) =>
      /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
    if (!candidates.length) {
      return note('DES05 fixture PENDING: no AVAILABLE table in B1-B4; no data changed')
        .then(() => null);
    }
    return reserveTable(candidates).then((reserved) => {
      if (!reserved) return null;
      return req('POST', '/api/v1/orders', tokens.waiter, { table_session_id: fixture.sessionId })
        .then((created) => {
          expect(created.status, 'create isolated order').eq(201);
          fixture.orderId = created.body?.id;
          expect(fixture.orderId, 'new order ID').to.be.a('string').and.not.be.empty;
          return note(`DES05 fixture: table ${fixture.tableCode}; order ${fixture.orderId}; isolated run`)
            .then(() => fixture);
        });
    });
  });

  const routing = (caseId, menuItems, context) => createOrder().then((created) => {
    if (!created) return cy.then(() => context.skip());
    return req('GET', '/api/v1/kitchen/queue', tokens.kitchen).then((before) => {
      expect(before.status, 'queue before Send').eq(200);
      expect(before.body.filter((entry) => entry.order_id === fixture.orderId),
        'no ticket for new order before Send').to.have.length(0);
      return req('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter, {
        items: menuItems.map((item, index) => ({
          menu_item_id: item.id, quantity: index + 1, note: `DES05 ${caseId}`,
        })),
      });
    }).then((added) => {
      expect(added.status, 'add items').eq(201);
      expect(added.body?.items, 'order items').to.have.length(menuItems.length);
      const ids = added.body.items.map((item) => item.id);
      return req('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter)
        .then((sent) => {
          expect(sent.status, 'Send to Kitchen').eq(200);
          expect(sent.body?.kitchen_queue_entries_created, 'created tickets').eq(menuItems.length);
          return req('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter).then((order) => {
            expect(order.status, 'GET order after Send').eq(200);
            ids.forEach((id) => {
              expect(order.body.items.find((item) => item.id === id)?.status, `item ${id}`).eq('SENT');
            });
            return req('GET', '/api/v1/kitchen/queue', tokens.kitchen).then((queue) => {
              expect(queue.status, 'GET queue after Send').eq(200);
              const entries = queue.body.filter((entry) => entry.order_id === fixture.orderId);
              expect(entries, 'tickets for own order only').to.have.length(menuItems.length);
              added.body.items.forEach((item) => {
                const match = entries.filter((entry) => entry.order_item_id === item.id);
                const sourceIndex = menuItems.findIndex((menuItem) => menuItem.id === item.menu_item_id);
                expect(sourceIndex, 'item maps to requested menu').to.be.at.least(0);
                expect(match, `one ticket for ${item.id}`).to.have.length(1);
                expect(match[0].station_id, 'menu station assignment').eq(menuItems[sourceIndex].station_id);
                expect(match[0].quantity, 'ticket quantity').eq(sourceIndex + 1);
                expect(match[0].status, 'ticket status').eq('QUEUED');
              });
              return note(`${caseId} assertions OK (cleanup follows): order ${fixture.orderId}; item IDs ${ids.join(',')}; ` +
                `stations ${menuItems.map((item) => item.station_id).join(',')}; ` +
                `${entries.length} QUEUED ticket(s), no duplicate/unintended station`);
            });
          });
        });
    });
  });

  beforeEach(function () {
    fixture = null;
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD']).then((env) => {
      base = String(env.POS_BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
      password = env.DES05_SEED_PASSWORD;
      if (!password) {
        return note('DES05 PENDING: local seed password absent; no mutation')
          .then(() => this.skip());
      }
      tokens = {};
      return login('waiter').then((token) => { tokens.waiter = token; })
        .then(() => login('kitchen')).then((token) => { tokens.kitchen = token; });
    });
  });

  afterEach(() => {
    if (!fixture) return;
    const { orderId, tableId, tableCode } = fixture;
    if (!orderId) throw new Error(`CLEANUP REQUIRED: table ${tableCode} (${tableId}) has a session but no order`);
    // Only touch IDs created by this test. Never run a global reset from automation.
    const prepareCleanup = () => req('GET', `/api/v1/orders/${orderId}`, tokens.waiter)
      .then((current) => {
        if (current.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} GET HTTP ${current.status}`);
        const unmappedStatus = current.body?.items?.find((item) => item.id === fixture.unmappedItemId)?.status;
        if (unmappedStatus !== 'CREATED') return null;
        return req('DELETE', `/api/v1/orders/${orderId}/items/${fixture.unmappedItemId}`, tokens.waiter)
          .then((removed) => {
            if (removed.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} remove unmapped HTTP ${removed.status}`);
          });
      }).then(() => req('GET', `/api/v1/orders/${orderId}`, tokens.waiter))
      .then((current) => {
        if (current.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} GET HTTP ${current.status}`);
        if (!current.body.items.some((item) => item.status === 'CREATED')) return null;
        return req('POST', `/api/v1/orders/${orderId}/send-to-kitchen`, tokens.waiter)
          .then((sent) => {
            if (sent.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} Send HTTP ${sent.status}`);
          });
      });
    return prepareCleanup().then(() => req('POST', `/api/v1/orders/${orderId}/request-billing`, tokens.waiter))
      .then((billing) => {
        if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} request-billing HTTP ${billing.status}`);
        return login('cashier');
      }).then((cashier) => req('POST', `/api/v1/orders/${orderId}/pay`, cashier))
      .then((paid) => {
        if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} pay HTTP ${paid.status}`);
        return login('cashier');
      }).then((cashier) => req('POST', `/api/v1/orders/${orderId}/close`, cashier))
      .then((closed) => {
        if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} close HTTP ${closed.status}`);
        return req('POST', `/api/v1/tables/${tableId}/mark-clean`, tokens.waiter);
      }).then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${tableCode} order ${orderId} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`DES05 cleanup: ${tableCode} AVAILABLE; order ${orderId} CLOSED`);
      });
  });

  const menu = () => req('GET', '/api/v1/menu?available_only=true', tokens.waiter)
    .then((response) => {
      expect(response.status, 'available Menu').eq(200);
      expect(response.body, 'Menu collection').to.be.an('array');
      return response.body.filter((item) => item.is_available && item.station_id);
    });

  const unsentOrder = (context) => menu().then((items) => {
    expect(items.length, 'mapped item for isolated Send').to.be.greaterThan(0);
    return createOrder().then((created) => {
      if (!created) return cy.then(() => context.skip());
      return req('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter, {
        items: [{ menu_item_id: items[0].id, quantity: 1 }],
      }).then((added) => {
        expect(added.status, 'add one item').eq(201);
        fixture.itemId = added.body?.items?.[0]?.id;
        expect(fixture.itemId, 'new item ID').to.be.a('string').and.not.be.empty;
        return req('GET', '/api/v1/kitchen/queue', tokens.kitchen).then((queue) => {
          expect(queue.status, 'queue before Send').eq(200);
          expect(queue.body.filter((entry) => entry.order_id === fixture.orderId),
            'no ticket before Send').to.have.length(0);
          return fixture;
        });
      });
    });
  });

  const ownTickets = () => req('GET', '/api/v1/kitchen/queue', tokens.kitchen).then((queue) => {
    expect(queue.status, 'GET queue').eq(200);
    const tickets = queue.body.filter((entry) => entry.order_id === fixture.orderId);
    expect(tickets, 'one ticket for exact item').to.have.length(1);
    expect(tickets[0].order_item_id, 'ticket item ID').eq(fixture.itemId);
    expect(tickets[0].status, 'ticket state').eq('QUEUED');
    return tickets[0];
  });

  it('DES05-TC-001 | one item routes to its assigned station', function () {
    return menu().then((items) => {
      expect(items.length, 'mapped menu candidates').greaterThan(0);
      return routing('DES05-TC-001', [items[0]], this);
    });
  });

  it('DES05-TC-002 | six mapped stations each receive exactly one ticket', function () {
    return menu().then((items) => {
      const byStation = new Map();
      items.forEach((item) => {
        if (!byStation.has(item.station_id)) byStation.set(item.station_id, item);
      });
      if (byStation.size < 6) return note(`DES05-TC-002 PENDING: ${byStation.size}/6 mapped stations; no mutation`)
        .then(() => this.skip());
      return routing('DES05-TC-002', [...byStation.values()].slice(0, 6), this);
    });
  });

  it('DES05-TC-003 | two stations receive exactly their own item', function () {
    return menu().then((items) => {
      const first = items[0];
      const second = items.find((item) => item.station_id !== first?.station_id);
      if (!second) return note('DES05-TC-003 PENDING: fewer than two mapped stations')
        .then(() => this.skip());
      return routing('DES05-TC-003', [first, second], this);
    });
  });

  it('DES05-TC-004 | two items on one station keep quantities and unique tickets', function () {
    return menu().then((items) => {
      const same = items.filter((item) => item.station_id === items[0]?.station_id).slice(0, 2);
      if (same.length < 2) return note('DES05-TC-004 PENDING: fewer than two mapped items at one station')
        .then(() => this.skip());
      return routing('DES05-TC-004', same, this);
    });
  });

  it('DES05-TC-005 | missing station mapping rejects Send without losing items', function () {
    return req('GET', '/api/v1/menu?available_only=true', tokens.waiter).then((response) => {
      expect(response.status, 'GET menu for missing mapping').eq(200);
      const unmapped = response.body.find((item) => item.is_available && !item.station_id);
      const mapped = response.body.find((item) => item.is_available && item.station_id);
      if (!unmapped || !mapped) return note('DES05-TC-005 PENDING: no available unmapped + mapped menu pair; no mutation')
        .then(() => this.skip());
      return createOrder().then((created) => {
        if (!created) return cy.then(() => this.skip());
        return req('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter, {
          items: [{ menu_item_id: unmapped.id, quantity: 1 }, { menu_item_id: mapped.id, quantity: 1 }],
        }).then((added) => {
          expect(added.status, 'add mapped and unmapped items').eq(201);
          const missing = added.body?.items?.find((item) => item.menu_item_id === unmapped.id);
          const valid = added.body?.items?.find((item) => item.menu_item_id === mapped.id);
          expect(missing, 'unmapped item in order').to.exist;
          expect(valid, 'mapped item in order').to.exist;
          fixture.unmappedItemId = missing.id;
          return req('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter)
            .then((rejected) => {
              expect(rejected.status, 'unmapped Send rejected').eq(422);
              return req('GET', '/api/v1/kitchen/queue', tokens.kitchen);
            }).then((queue) => {
              expect(queue.status, 'queue after rejected Send').eq(200);
              expect(queue.body.filter((entry) => entry.order_id === fixture.orderId),
                'no partial tickets').to.have.length(0);
              return req('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter);
            }).then((order) => {
              expect(order.body.items.find((item) => item.id === missing.id)?.status,
                'unmapped item remains CREATED').eq('CREATED');
              expect(order.body.items.find((item) => item.id === valid.id)?.status,
                'mapped item remains CREATED').eq('CREATED');
              return req('DELETE', `/api/v1/orders/${fixture.orderId}/items/${missing.id}`, tokens.waiter);
            }).then((removed) => {
              expect(removed.status, 'remove unmapped item from own order').eq(200);
              return req('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter);
            }).then((sent) => {
              expect(sent.status, 'send remaining mapped item for cleanup').eq(200);
              expect(sent.body?.kitchen_queue_entries_created, 'one valid ticket').eq(1);
              return note(`DES05-TC-005 assertions OK (cleanup follows): order ${fixture.orderId}; missing station rejected HTTP 422, no partial ticket`);
            });
        });
      });
    });
  });

  it('DES05-TC-006 | retry Send with the same key replays without a second ticket', function () {
    return unsentOrder(this).then(() => {
      const sameKey = key();
      const path = `/api/v1/orders/${fixture.orderId}/send-to-kitchen`;
      return req('POST', path, tokens.waiter, undefined, sameKey).then((first) => {
        expect(first.status, 'first Send').eq(200);
        expect(first.body?.kitchen_queue_entries_created, 'first ticket count').eq(1);
        return ownTickets().then((original) =>
          req('POST', path, tokens.waiter, undefined, sameKey).then((retry) => {
            expect(retry.status, 'same-key retry').eq(first.status);
            expect(retry.body, 'cached response').to.deep.eq(first.body);
            return ownTickets().then((after) => {
              expect(after.id, 'same ticket after retry').eq(original.id);
              return note(`DES05-TC-006 assertions OK (cleanup follows): order ${fixture.orderId}; item ${fixture.itemId}; one ticket ${after.id}; same-key replay`);
            });
          }));
      });
    });
  });

  it('DES05-TC-007 | concurrent Send creates one ticket for one item', function () {
    return unsentOrder(this).then(() => {
      const path = `/api/v1/orders/${fixture.orderId}/send-to-kitchen`;
      return cy.task('des05ParallelSend', {
        url: base + path, token: tokens.waiter, keys: [key(), key()],
      }, { log: false }).then((results) => {
        const statuses = results.map((result) => result.status);
        const responseInfo = results.map((result) =>
          `${result.status}(server=${result.server || '-'},via=${result.via || '-'},requestId=${result.requestId || '-'})`).join('/');
        return req('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter).then((order) =>
          req('GET', '/api/v1/kitchen/queue', tokens.kitchen).then((queue) => {
            const itemStatus = order.body?.items?.find((item) => item.id === fixture.itemId)?.status;
            const tickets = Array.isArray(queue.body) ? queue.body.filter((entry) =>
              entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId) : [];
            return note(`DES05-TC-007 diagnostic: order ${fixture.orderId}; concurrent Send HTTP ${statuses.join('/')}; ` +
              `responses ${responseInfo}; GET order ${order.status} item ${itemStatus || '-'}; ` +
              `GET queue ${queue.status} own tickets ${tickets.length} IDs ${tickets.map((ticket) => ticket.id).join(',') || '-'}`)
              .then(() => {
                expect(results, 'two simultaneous HTTP results').to.have.length(2);
                expect(order.status, 'GET own order after concurrent Send').eq(200);
                expect(queue.status, 'GET queue after concurrent Send').eq(200);
                expect(itemStatus, 'item is SENT exactly once').eq('SENT');
                expect(tickets, 'exactly one ticket for own item').to.have.length(1);
                expect(tickets[0].status, 'ticket state').eq('QUEUED');
                expect(statuses, 'one successful Send').to.include(200);
                expect(statuses.every((status) => [200, 409].includes(status)),
                  `both Send statuses ${statuses.join('/')} match 200/409 contract`).eq(true);
                return note(`DES05-TC-007 assertions OK (cleanup follows): order ${fixture.orderId}; item ${fixture.itemId}; HTTP ${statuses.join('/')}; one ticket ${tickets[0].id}`);
              });
          }));
      });
    });
  });
});
