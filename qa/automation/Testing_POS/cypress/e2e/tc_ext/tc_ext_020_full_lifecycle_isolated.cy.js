// Phase 1 TC_EXT_020: one own QA table/order, four roles, full Kitchen lifecycle.
// Simulated staging payment only. Failure cleanup is restricted to the own fixture.
describe('Phase 1 | TC_EXT_020 full POS lifecycle', () => {
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
    method: 'POST', url: `${base}/api/v1/auth/login`,
    body: { username, password }, failOnStatusCode: false, timeout: 20000, log: false,
  }).then((result) => {
    expect(result.status, `${username} login`).eq(200);
    expect(result.body?.access_token, `${username} JWT`).to.be.a('string').and.not.be.empty;
    expect(result.body?.staff?.role, `${username} role`).eq({
      admin: 'SUPERVISOR', cashier: 'CASHIER', waiter: 'WAITER', kitchen: 'KITCHEN',
    }[username]);
    return result.body.access_token;
  });
  const ownOrder = (token = tokens.admin) => request('GET',
    `/api/v1/orders/${fixture.orderId}`, token).then((result) => {
    expect(result.status, 'GET own order').eq(200);
    expect(result.body?.id, 'own order ID').eq(fixture.orderId);
    return result.body;
  });
  const expectItem = (response, status) => {
    expect(response.status, `${status} HTTP`).eq(200);
    expect(response.body?.items?.find((item) => item.id === fixture.itemId)?.status,
      `${status} item`).eq(status);
    return ownOrder().then((persisted) => {
      expect(persisted.items.find((item) => item.id === fixture.itemId)?.status,
        `${status} persisted`).eq(status);
    });
  };
  const step = (action, token, expected) => request('POST',
    `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}/${action}`, token)
    .then((response) => expectItem(response, expected));
  const ownTicket = (status) => request('GET',
    `/api/v1/kitchen/queue?status=${status}&station_id=${fixture.stationId}`, tokens.kitchen)
    .then((result) => {
      expect(result.status, `${status} queue GET`).eq(200);
      const own = result.body.filter((entry) => entry.order_id === fixture.orderId &&
        entry.order_item_id === fixture.itemId);
      expect(own, `own ${status} ticket`).to.have.length(1);
      expect(own[0].station_id, 'mapped station').eq(fixture.stationId);
      return own[0];
    });
  const reserve = (tables) => {
    if (!tables.length) return cy.wrap(null, { log: false });
    const table = tables.shift();
    return request('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter,
      { guest_count: 2 }).then((opened) => {
      if (opened.status === 409) return reserve(tables);
      expect(opened.status, `open ${table.code}`).eq(201);
      fixture.tableId = table.id;
      fixture.tableCode = table.code;
      fixture.sessionId = opened.body?.id;
      expect(fixture.sessionId, 'own session ID').to.be.a('string').and.not.be.empty;
      return table;
    });
  };
  const status = (expected) => ownOrder().then((order) => {
    expect(order.status, `order ${expected}`).eq(expected);
    return order;
  });
  const finalTable = (expected) => request('GET',
    `/api/v1/tables/${fixture.tableId}`, tokens.admin).then((table) => {
    expect(table.status, 'own table GET').eq(200);
    expect(table.body?.status, `table ${expected}`).eq(expected);
    return table.body;
  });

  beforeEach(function () {
    tokens = {};
    fixture = {};
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) {
        return note('TC_EXT_020 PENDING: local staging PIN missing').then(() => this.skip());
      }
      const password = String(env.DES05_SEED_PASSWORD);
      return login('admin', password).then((token) => { tokens.admin = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => login('waiter', password)).then((token) => { tokens.waiter = token; })
        .then(() => login('kitchen', password)).then((token) => { tokens.kitchen = token; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((tables) => {
          expect(tables.status, 'GET tables').eq(200);
          const available = tables.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          return request('GET', '/api/v1/menu?available_only=true', tokens.cashier)
            .then((menu) => ({ available, menu }));
        }).then(({ available, menu }) => {
          expect(menu.status, 'GET menu').eq(200);
          const item = menu.body.find((entry) => entry.is_available && entry.station_id);
          if (!available.length || !item) {
            return note('TC_EXT_020 PENDING: no own B1-B4 table or mapped item; no mutation')
              .then(() => this.skip());
          }
          fixture.menuId = item.id;
          fixture.stationId = item.station_id;
          return reserve(available).then((table) => {
            if (!table) return note('TC_EXT_020 PENDING: reservation lost').then(() => this.skip());
            return note(`TC_EXT_020 fixture: ${fixture.tableCode}; session ${fixture.sessionId}; menu ${fixture.menuId}`);
          });
        });
    });
  });

  it('TC_EXT_020 | four-role order, kitchen, simulated pay and clean', () =>
    request('POST', '/api/v1/orders', tokens.cashier,
      { table_session_id: fixture.sessionId }).then((created) => {
      expect(created.status, 'Cashier create order').eq(201);
      fixture.orderId = created.body?.id;
      expect(fixture.orderId, 'own order ID').to.be.a('string').and.not.be.empty;
      return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.cashier,
        { items: [{ menu_item_id: fixture.menuId, quantity: 1, note: 'Phase1 TC_EXT_020' }] });
    }).then((added) => {
      expect(added.status, 'Cashier add item').eq(201);
      fixture.itemId = added.body?.items?.find((item) => item.menu_item_id === fixture.menuId)?.id;
      expect(fixture.itemId, 'own item ID').to.be.a('string').and.not.be.empty;
      return status('NEW');
    }).then(() => request('POST',
      `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter))
      .then((sent) => {
        expect(sent.status, 'Waiter send to Kitchen').eq(200);
        expect(sent.body?.kitchen_queue_entries_created, 'one ticket created').eq(1);
        return status('SENT');
      }).then(() => ownTicket('QUEUED')).then((queued) => {
        fixture.ticketId = queued.id;
        return step('start-cooking', tokens.kitchen, 'PREPARING');
      }).then(() => ownTicket('IN_PROGRESS')).then((cooking) => {
        expect(cooking.id, 'same cooking ticket').eq(fixture.ticketId);
        return step('mark-ready', tokens.kitchen, 'READY');
      }).then(() => ownTicket('DONE')).then((done) => {
        expect(done.id, 'same completed ticket').eq(fixture.ticketId);
        return step('pickup', tokens.waiter, 'PICKED_UP');
      }).then(() => step('served', tokens.waiter, 'SERVED'))
      .then(() => request('POST',
        `/api/v1/orders/${fixture.orderId}/request-billing`, tokens.waiter))
      .then((billing) => {
        expect(billing.status, 'Waiter request billing').eq(200);
        return status('BILLING');
      }).then(() => request('POST',
        `/api/v1/orders/${fixture.orderId}/pay`, tokens.cashier))
      .then((paid) => {
        expect(paid.status, 'Cashier simulated payment').eq(200);
        return status('PAID');
      }).then(() => finalTable('CLEANING'))
      .then(() => request('POST',
        `/api/v1/orders/${fixture.orderId}/close`, tokens.cashier))
      .then((closed) => {
        expect(closed.status, 'Cashier close order').eq(200);
        return status('CLOSED');
      }).then(() => request('POST',
        `/api/v1/tables/${fixture.tableId}/mark-clean`, tokens.waiter))
      .then((cleaned) => {
        expect(cleaned.status, 'Waiter mark clean').eq(200);
        return finalTable('AVAILABLE');
      }).then((table) => {
        expect(table.current_session, 'no active session').to.be.oneOf([null, undefined]);
        fixture.completed = true;
        return note(`TC_EXT_020 assertions OK: ${fixture.tableCode}; order ${fixture.orderId} CLOSED; ` +
          `item ${fixture.itemId} SERVED; ticket ${fixture.ticketId} DONE; table AVAILABLE; ` +
          'four roles verified; simulated payment only');
      }));

  afterEach(() => {
    if (!fixture.tableId || fixture.completed) return;
    if (!fixture.orderId) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session ${fixture.sessionId} without order`);
    }
    // Inspect only our order. Compensation never touches unrelated tables or orders.
    return ownOrder().then((current) => {
      if (current.status === 'NEW') {
        return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter)
          .then((sent) => {
            if (sent.status !== 200) throw new Error(`CLEANUP REQUIRED: own Send HTTP ${sent.status}`);
            return 'SENT';
          });
      }
      return current.status;
    }).then((currentStatus) => {
      if (['BILLING', 'PAID', 'CLOSED'].includes(currentStatus)) return currentStatus;
      return request('POST', `/api/v1/orders/${fixture.orderId}/request-billing`, tokens.waiter)
        .then((billing) => {
          if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: own Billing HTTP ${billing.status}`);
          return 'BILLING';
        });
    }).then((currentStatus) => {
      if (['PAID', 'CLOSED'].includes(currentStatus)) return currentStatus;
      return request('POST', `/api/v1/orders/${fixture.orderId}/pay`, tokens.cashier)
        .then((paid) => {
          if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: own Pay HTTP ${paid.status}`);
          return 'PAID';
        });
    }).then((currentStatus) => {
      if (currentStatus === 'CLOSED') return;
      return request('POST', `/api/v1/orders/${fixture.orderId}/close`, tokens.cashier)
        .then((closed) => {
          if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: own Close HTTP ${closed.status}`);
        });
    }).then(() => request('POST',
      `/api/v1/tables/${fixture.tableId}/mark-clean`, tokens.waiter))
      .then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`TC_EXT_020 recovery: ${fixture.tableCode} AVAILABLE; order ${fixture.orderId} CLOSED`);
      });
  });
});
