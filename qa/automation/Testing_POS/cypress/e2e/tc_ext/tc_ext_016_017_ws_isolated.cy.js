// Phase 1 WebSocket: two authenticated clients, own table/order, REST source of truth.
// TC_EXT_017 is API/client coverage only; product UI resync needs a separate check.
describe('Phase 1 | isolated tables and kitchen WebSocket', () => {
  const base = 'http://160.191.47.17';
  let tokens;
  let fixture;
  let availableTables;
  let menuItem;

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
    return result.body.access_token;
  });
  const connect = (channel, token) => cy.then({ log: false }, () => new Cypress.Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/ws?token=${encodeURIComponent(token)}&channel=${channel}`);
    const client = { ws, events: [], channel };
    fixture.clients.push(client);
    const timeout = setTimeout(() => { ws.close(); reject(new Error(`${channel} WS open timed out`)); }, 10000);
    ws.onopen = () => { clearTimeout(timeout); resolve(client); };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error(`${channel} WS handshake failed`)); };
    ws.onmessage = (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      client.events.push({ payload, receivedAt: Date.now() });
    };
  }));
  const waitEvent = (client, type, predicate) => cy.then({ log: false }, () =>
    new Cypress.Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const inspect = () => {
        const found = client.events.find((event) => event.payload.type === type &&
          event.payload.channel === client.channel && predicate(event.payload.data || {}));
        if (found) return resolve(found);
        if (Date.now() > deadline) return reject(new Error(`${client.channel} ${type} for own fixture missing after 5 seconds`));
        setTimeout(inspect, 50);
      };
      inspect();
    }));
  const close = (client) => cy.then({ log: false }, () => new Cypress.Promise((resolve, reject) => {
    if (client.ws.readyState === WebSocket.CLOSED) return resolve();
    const timeout = setTimeout(() => reject(new Error(`${client.channel} WS did not close`)), 4000);
    client.ws.addEventListener('close', () => { clearTimeout(timeout); resolve(); }, { once: true });
    client.ws.close();
  }));
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
      expect(fixture.sessionId, 'own session').to.be.a('string').and.not.be.empty;
      return table;
    });
  };
  const createOwnOrder = (beforeSend = () => {}) => request('POST', '/api/v1/orders', tokens.waiter,
    { table_session_id: fixture.sessionId }).then((created) => {
    expect(created.status, 'create order').eq(201);
    fixture.orderId = created.body?.id;
    expect(fixture.orderId, 'own order ID').to.be.a('string').and.not.be.empty;
    return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter,
      { items: [{ menu_item_id: menuItem.id, quantity: 1, note: 'Phase1 WS isolated' }] });
  }).then((added) => {
    expect(added.status, 'add item').eq(201);
    fixture.itemId = added.body?.items?.find((item) => item.menu_item_id === menuItem.id)?.id;
    expect(fixture.itemId, 'own item ID').to.be.a('string').and.not.be.empty;
    beforeSend();
    return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter);
  }).then((sent) => {
    expect(sent.status, 'send item').eq(200);
    expect(sent.body?.kitchen_queue_entries_created, 'one ticket').eq(1);
    return sent;
  });
  const ownTicket = (status) => request('GET',
    `/api/v1/kitchen/queue?status=${status}&station_id=${menuItem.station_id}`, tokens.kitchen)
    .then((response) => {
      expect(response.status, `${status} queue GET`).eq(200);
      const own = response.body.filter((item) => item.order_id === fixture.orderId &&
        item.order_item_id === fixture.itemId);
      expect(own, `one own ${status} ticket`).to.have.length(1);
      return own[0];
    });

  beforeEach(function () {
    fixture = { clients: [] };
    tokens = {};
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) {
        return note('TC_EXT_016/017 PENDING: local staging PIN missing').then(() => this.skip());
      }
      const password = String(env.DES05_SEED_PASSWORD);
      return login('waiter', password).then((token) => { tokens.waiter = token; })
        .then(() => login('kitchen', password)).then((token) => { tokens.kitchen = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((tables) => {
          expect(tables.status, 'GET tables').eq(200);
          availableTables = tables.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          return request('GET', '/api/v1/menu?available_only=true', tokens.waiter);
        }).then((menu) => {
          expect(menu.status, 'GET menu').eq(200);
          menuItem = menu.body.find((item) => item.is_available && item.station_id);
          if (!availableTables.length || !menuItem) {
            return note('TC_EXT_016/017 PENDING: own B1-B4 table or mapped menu unavailable; no mutation')
              .then(() => this.skip());
          }
        });
    });
  });

  afterEach(() => {
    if (!fixture) return;
    fixture.clients.forEach((client) => {
      if (client.ws.readyState !== WebSocket.CLOSED) client.ws.close();
    });
    if (!fixture.tableId) return;
    if (!fixture.orderId) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} has open session ${fixture.sessionId} without order`);
    }
    return request('POST', `/api/v1/orders/${fixture.orderId}/request-billing`, tokens.waiter)
      .then((billing) => {
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
        return note(`WS cleanup: ${fixture.tableCode} AVAILABLE; order ${fixture.orderId} CLOSED`);
      });
  });

  it('TC_EXT_016 | tables and kitchen clients receive the own changes', function () {
    let waiter;
    let kitchen;
    let openStarted;
    let sendStarted;
    return connect('tables', tokens.waiter).then((client) => { waiter = client; })
      .then(() => connect('kitchen', tokens.kitchen)).then((client) => { kitchen = client; })
      .then(() => {
        openStarted = Date.now();
        return reserve([...availableTables]);
      }).then((table) => {
        if (!table) return note('TC_EXT_016 PENDING: table reservation lost').then(() => this.skip());
        return createOwnOrder(() => { sendStarted = Date.now(); });
      }).then(() => ownTicket('QUEUED'))
      .then((ticket) => waitEvent(waiter, 'TABLE_SESSION_OPENED',
        (data) => data.table_id === fixture.tableId &&
          data.table_session_id === fixture.sessionId).then((opened) => ({ opened, ticket })))
      .then(({ opened, ticket }) => waitEvent(kitchen, 'KITCHEN_QUEUE_UPDATED',
        (data) => data.order_id === fixture.orderId && data.items_sent === 1)
        .then((queued) => ({ opened, queued, ticket })))
      .then(({ opened, queued, ticket }) => {
        // Send occurs inside createOwnOrder, so queue event can precede its response.
        expect(opened.receivedAt - openStarted, 'tables event within 2s').to.be.within(0, 2000);
        expect(queued.receivedAt - sendStarted, 'kitchen event within 2s').to.be.within(0, 2000);
        expect(opened.payload.data.status, 'opened table status').eq('OCCUPIED');
        expect(Number.isFinite(Date.parse(opened.payload.at)), 'tables event timestamp').eq(true);
        expect(Number.isFinite(Date.parse(queued.payload.at)), 'kitchen event timestamp').eq(true);
        expect(ticket.station_id, 'own mapped station').eq(menuItem.station_id);
        expect(waiter.events.some((event) => event.payload.type === 'KITCHEN_QUEUE_UPDATED'),
          'kitchen event absent from tables channel').eq(false);
        expect(kitchen.events.some((event) => event.payload.type === 'TABLE_SESSION_OPENED'),
          'tables event absent from kitchen channel').eq(false);
        return request('GET', '/api/v1/tables', tokens.waiter)
          .then((tables) => {
            expect(tables.status, 'REST tables GET').eq(200);
            expect(tables.body.find((entry) => entry.id === fixture.tableId)?.status,
              'own table occupied').eq('OCCUPIED');
            return note(`TC_EXT_016 assertions OK: ${fixture.tableCode}; order ${fixture.orderId}; ` +
              `tables TABLE_SESSION_OPENED ${opened.receivedAt - openStarted}ms; ` +
              `kitchen KITCHEN_QUEUE_UPDATED ${queued.receivedAt - sendStarted}ms; ` +
              `own QUEUED ticket ${ticket.id}; two channels separated; cleanup follows`);
          });
      });
  });

  it('API-COMP-017 | reconnect then REST resync observes an offline kitchen change', () => {
    let waiter;
    let kitchen;
    let ticketId;
    return connect('tables', tokens.waiter).then((client) => { waiter = client; })
      .then(() => connect('kitchen', tokens.kitchen)).then((client) => { kitchen = client; })
      .then(() => reserve([...availableTables])).then((table) => {
        if (!table) throw new Error('Table reservation lost before API-COMP-017 fixture');
        return createOwnOrder();
      }).then(() => ownTicket('QUEUED')).then((ticket) => {
        ticketId = ticket.id;
        return close(waiter);
      }).then(() => close(kitchen))
      .then(() => request('POST',
        `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}/start-cooking`, tokens.kitchen))
      .then((started) => {
        expect(started.status, 'offline Start Cooking').eq(200);
        expect(started.body?.items?.find((item) => item.id === fixture.itemId)?.status,
          'offline order transition').eq('PREPARING');
        return connect('tables', tokens.waiter);
      }).then(() => connect('kitchen', tokens.kitchen))
      .then(() => request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.waiter))
      .then((ownOrder) => {
        expect(ownOrder.status, 'REST order resync').eq(200);
        expect(ownOrder.body?.items?.find((item) => item.id === fixture.itemId)?.status,
          'resynced order item').eq('PREPARING');
        return ownTicket('IN_PROGRESS');
      }).then((cooking) => {
        expect(cooking.id, 'same ticket, no duplicate mutation').eq(ticketId);
        return request('GET', '/api/v1/tables', tokens.waiter);
      }).then((tables) => {
        expect(tables.status, 'REST tables resync').eq(200);
        expect(tables.body.find((entry) => entry.id === fixture.tableId)?.status,
          'resynced own table').eq('OCCUPIED');
        return note(`API-COMP-017 assertions OK: ${fixture.tableCode}; order ${fixture.orderId}; ` +
          `WebSocket clients reconnected; missed Start Cooking recovered via REST; ` +
          `same ticket ${ticketId}; product UI not tested; TC_EXT_017 remains Pending`);
      });
  });
});
