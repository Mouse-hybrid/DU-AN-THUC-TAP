// Phase 1 TC_EXT_014: observe one owned Kitchen ticket through all four SLA bands.
// This live staging test takes about 15 minutes; it never changes the server clock.
describe('Phase 1 | TC_EXT_014 own Kitchen SLA bands', () => {
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
    expect(response.body?.access_token, `${username} JWT`).to.be.a('string').and.not.be.empty;
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
      expect(fixture.sessionId, 'own session').to.be.a('string').and.not.be.empty;
      return table;
    });
  };
  const ownTicket = () => request('GET', '/api/v1/kitchen/queue?status=IN_PROGRESS', tokens.kitchen)
    .then((response) => {
      expect(response.status, 'Kitchen Queue HTTP').eq(200);
      const matches = response.body.filter((entry) =>
        entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId);
      expect(matches, 'one own IN_PROGRESS ticket').to.have.length(1);
      const ticket = matches[0];
      expect(ticket.id, 'same ticket throughout').eq(fixture.ticketId);
      expect(ticket.started_at, 'unchanged started_at').eq(fixture.startedAt);
      expect(ticket.elapsed_minutes, 'server elapsed').to.be.a('number');
      return ticket;
    });

  beforeEach(function () {
    fixture = {};
    tokens = {};
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) {
        return note('TC_EXT_014 PENDING: local staging PIN missing').then(() => this.skip());
      }
      const password = String(env.DES05_SEED_PASSWORD);
      return login('waiter', password).then((token) => { tokens.waiter = token; })
        .then(() => login('kitchen', password)).then((token) => { tokens.kitchen = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((tables) => {
          expect(tables.status, 'tables GET').eq(200);
          const available = tables.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          if (!available.length) return note('TC_EXT_014 PENDING: no AVAILABLE B1-B4 table')
            .then(() => this.skip());
          return request('GET', '/api/v1/menu?available_only=true', tokens.waiter)
            .then((menu) => {
              expect(menu.status, 'menu GET').eq(200);
              const mapped = menu.body.find((item) => item.is_available && item.station_id);
              if (!mapped) return note('TC_EXT_014 PENDING: no mapped menu item')
                .then(() => this.skip());
              fixture.menuId = mapped.id;
              return reserve(available).then((table) => {
                if (!table) return note('TC_EXT_014 PENDING: table reservation lost')
                  .then(() => this.skip());
                return request('POST', '/api/v1/orders', tokens.waiter,
                  { table_session_id: fixture.sessionId });
              });
            }).then((created) => {
              if (!created) return;
              expect(created.status, 'own order created').eq(201);
              fixture.orderId = created.body?.id;
              return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter,
                { items: [{ menu_item_id: fixture.menuId, quantity: 1,
                  note: 'Phase 1 TC_EXT_014 live SLA' }] });
            }).then((added) => {
              if (!added) return;
              expect(added.status, 'own item added').eq(201);
              fixture.itemId = added.body?.items?.[0]?.id;
              expect(fixture.itemId, 'own item ID').to.be.a('string').and.not.be.empty;
              return request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`,
                tokens.waiter);
            }).then((sent) => {
              if (!sent) return;
              expect(sent.status, 'sent to kitchen').eq(200);
              return request('POST',
                `/api/v1/orders/${fixture.orderId}/items/${fixture.itemId}/start-cooking`,
                tokens.kitchen);
            }).then((started) => {
              if (!started) return;
              expect(started.status, 'Start Cooking').eq(200);
              return request('GET', '/api/v1/kitchen/queue?status=IN_PROGRESS', tokens.kitchen);
            }).then((queue) => {
              if (!queue) return;
              expect(queue.status, 'initial Queue GET').eq(200);
              const own = queue.body.filter((entry) =>
                entry.order_id === fixture.orderId && entry.order_item_id === fixture.itemId);
              expect(own, 'one own cooking ticket').to.have.length(1);
              fixture.ticketId = own[0].id;
              fixture.startedAt = own[0].started_at;
              expect(Number.isFinite(Date.parse(fixture.startedAt)), 'valid started_at').eq(true);
              return note(`TC_EXT_014 fixture: ${fixture.tableCode}; order ${fixture.orderId}; item ${fixture.itemId}; ticket ${fixture.ticketId}; started_at ${fixture.startedAt}; observing about 15 minutes`);
            });
        });
    });
  });

  // The server's elapsed_minutes drives waits; a one-minute heartbeat keeps the terminal informative.
  const observeBand = (label, from, until) => ownTicket().then((ticket) => {
    // elapsed_minutes is rounded by the API; at the boundary it can display
    // 8.0/12.0/15.0 slightly before the underlying SLA switches.
    if (ticket.elapsed_minutes >= from && ticket.sla_status !== label &&
        ticket.elapsed_minutes < from + 0.15) {
      return cy.wait(10000, { log: false }).then(() => observeBand(label, from, until));
    }
    if (ticket.elapsed_minutes < from) {
      const remaining = Math.ceil((from - ticket.elapsed_minutes) * 60000) + 3000;
      const waitMs = Math.min(60000, Math.max(5000, remaining));
      return cy.wait(waitMs, { log: false })
        .then(() => note(`TC_EXT_014 observing ${label}: ${ticket.elapsed_minutes.toFixed(1)} minutes; waiting ${Math.round(waitMs / 1000)} seconds`))
        .then(() => observeBand(label, from, until));
    }
    expect(ticket.elapsed_minutes, `${label} upper boundary`).to.be.lessThan(until);
    expect(ticket.sla_status, `${label} status`).eq(label);
    return note(`TC_EXT_014 ${label} PASS: ticket ${ticket.id}; elapsed_minutes=${ticket.elapsed_minutes}; started_at=${ticket.started_at}`);
  });

  it('TC_EXT_014 | own ticket moves NORMAL to WARNING to DELAYED to CRITICAL',
    { timeout: 1080000 }, () =>
      observeBand('NORMAL', 0, 8)
        .then(() => observeBand('WARNING', 8, 12))
        .then(() => observeBand('DELAYED', 12, 15))
        .then(() => observeBand('CRITICAL', 15, Infinity))
        .then(() => note(`TC_EXT_014 assertions OK: one own ticket ${fixture.ticketId} traversed all four bands; cleanup follows`)));

  afterEach(() => {
    if (!fixture.sessionId) return;
    if (!fixture.orderId) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session ${fixture.sessionId} without order`);
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
        return note(`TC_EXT_014 cleanup: ${fixture.tableCode} AVAILABLE; order ${fixture.orderId} CLOSED`);
      });
  });
});
