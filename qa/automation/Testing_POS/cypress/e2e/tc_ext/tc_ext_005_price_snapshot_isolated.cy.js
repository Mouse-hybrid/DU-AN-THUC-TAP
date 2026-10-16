// Phase 1 TC_EXT_005: compare two orders around an isolated QA menu price update.
// Each order is closed and its table cleaned; the QA menu record is archived.
describe('Phase 1 | TC_EXT_005 price snapshot', () => {
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
  const readOrder = (id) => request('GET', `/api/v1/orders/${id}`, tokens.cashier)
    .then((result) => {
      expect(result.status, 'GET own order').eq(200);
      expect(result.body?.id, 'own order ID').eq(id);
      return result.body;
    });
  const snapshotPrice = (id) => readOrder(id).then((order) => {
    const own = order.items.filter((item) => item.menu_item_id === fixture.menuId);
    expect(own, 'one own QA menu item').to.have.length(1);
    expect(own[0].quantity, 'quantity').eq(1);
    return { id: own[0].id, price: Number(own[0].unit_price), status: order.status };
  });
  const startOrder = () => request('POST',
    `/api/v1/tables/${fixture.tableId}/open-session`, tokens.waiter,
    { guest_count: 2 }).then((opened) => {
    expect(opened.status, `open ${fixture.tableCode}`).eq(201);
    fixture.active = { sessionId: opened.body?.id, tableId: fixture.tableId };
    expect(fixture.active.sessionId, 'new own session').to.be.a('string').and.not.be.empty;
    return request('POST', '/api/v1/orders', tokens.cashier,
      { table_session_id: fixture.active.sessionId });
  }).then((created) => {
    expect(created.status, 'Cashier creates order').eq(201);
    fixture.active.orderId = created.body?.id;
    expect(fixture.active.orderId, 'new order ID').to.be.a('string').and.not.be.empty;
    return request('POST', `/api/v1/orders/${fixture.active.orderId}/items`, tokens.cashier,
      { items: [{ menu_item_id: fixture.menuId, quantity: 1,
        note: 'Phase1 TC_EXT_005 price snapshot' }] });
  }).then((added) => {
    expect(added.status, 'add own QA item').eq(201);
    expect(added.body?.items, 'one order item').to.have.length(1);
    return fixture.active.orderId;
  });
  const closeOwn = () => {
    const active = fixture.active;
    if (!active) return cy.wrap(null, { log: false });
    if (!active.orderId) {
      throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session ${active.sessionId} without order`);
    }
    return readOrder(active.orderId).then((order) => {
      if (order.status !== 'NEW') return order.status;
      return request('POST', `/api/v1/orders/${active.orderId}/send-to-kitchen`, tokens.waiter)
        .then((sent) => {
          if (sent.status !== 200) throw new Error(`CLEANUP REQUIRED: own Send HTTP ${sent.status}`);
          return 'SENT';
        });
    }).then((state) => {
      if (['BILLING', 'PAID', 'CLOSED'].includes(state)) return state;
      return request('POST', `/api/v1/orders/${active.orderId}/request-billing`, tokens.waiter)
        .then((billing) => {
          if (billing.status !== 200) throw new Error(`CLEANUP REQUIRED: own Billing HTTP ${billing.status}`);
          return 'BILLING';
        });
    }).then((state) => {
      if (['PAID', 'CLOSED'].includes(state)) return state;
      return request('POST', `/api/v1/orders/${active.orderId}/pay`, tokens.cashier)
        .then((paid) => {
          if (paid.status !== 200) throw new Error(`CLEANUP REQUIRED: own Pay HTTP ${paid.status}`);
          return 'PAID';
        });
    }).then((state) => {
      if (state === 'CLOSED') return;
      return request('POST', `/api/v1/orders/${active.orderId}/close`, tokens.cashier)
        .then((closed) => {
          if (closed.status !== 200) throw new Error(`CLEANUP REQUIRED: own Close HTTP ${closed.status}`);
        });
    }).then(() => request('GET', `/api/v1/tables/${fixture.tableId}`, tokens.waiter))
      .then((table) => {
        if (table.status !== 200) throw new Error(`CLEANUP REQUIRED: table GET HTTP ${table.status}`);
        if (table.body?.status === 'AVAILABLE') return table;
        if (table.body?.status !== 'CLEANING') {
          throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} status ${table.body?.status}`);
        }
        return request('POST', `/api/v1/tables/${fixture.tableId}/mark-clean`, tokens.waiter);
      }).then((cleaned) => {
        if (cleaned.status !== 200 || cleaned.body?.status !== 'AVAILABLE') {
          throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} mark-clean HTTP ${cleaned.status}`);
        }
        return note(`TC_EXT_005 cleanup: ${fixture.tableCode} AVAILABLE; order ${active.orderId} CLOSED`)
          .then(() => { fixture.active = null; });
      });
  };

  beforeEach(function () {
    tokens = {};
    fixture = { active: null };
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) {
        return note('TC_EXT_005 PENDING: local staging PIN missing').then(() => this.skip());
      }
      const password = String(env.DES05_SEED_PASSWORD);
      return login('admin', password).then((token) => { tokens.admin = token; })
        .then(() => login('waiter', password)).then((token) => { tokens.waiter = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => request('GET', '/api/v1/tables', tokens.waiter))
        .then((tables) => {
          expect(tables.status, 'GET tables').eq(200);
          const available = tables.body.find((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          return request('GET', '/api/v1/menu/categories?active_only=true', tokens.admin)
            .then((categories) => ({ available, categories }));
        }).then(({ available, categories }) => {
          expect(categories.status, 'GET active categories').eq(200);
          const category = categories.body.find((entry) => entry.is_active && entry.id);
          return request('GET', '/api/v1/menu?available_only=true', tokens.admin)
            .then((menu) => ({ available, category, menu }));
        }).then(({ available, category, menu }) => {
          expect(menu.status, 'GET mapped menu').eq(200);
          const mapped = menu.body.find((item) => item.is_available && item.station_id);
          if (!available || !category || !mapped) {
            return note('TC_EXT_005 PENDING: B1-B4, category or mapped station missing; no mutation')
              .then(() => this.skip());
          }
          fixture.tableId = available.id;
          fixture.tableCode = available.code;
          fixture.menuName = `PHASE1-QA-PRICE-${key()}`;
          return request('POST', '/api/v1/menu', tokens.admin, {
            name: fixture.menuName, price: '31700.00', category_id: category.id,
            station_id: mapped.station_id, is_available: true,
          }).then((created) => {
            expect(created.status, 'create own QA menu item').eq(201);
            fixture.menuId = created.body?.id;
            expect(fixture.menuId, 'own menu ID').to.be.a('string').and.not.be.empty;
            return note(`TC_EXT_005 fixture: ${fixture.tableCode}; QA menu ${fixture.menuId}; initial price 31700`);
          });
        });
    });
  });

  it('TC_EXT_005 | old order retains unit price after own menu price update', () => {
    let oldOrderId;
    let newOrderId;
    return startOrder().then((id) => { oldOrderId = id; return snapshotPrice(id); })
      .then((old) => {
        expect(old.price, 'old order captured initial price').eq(31700);
        return closeOwn();
      }).then(() => request('PATCH', `/api/v1/menu/${fixture.menuId}`, tokens.admin,
        { price: '32700.00' })).then((updated) => {
        expect(updated.status, 'Supervisor updates QA menu price').eq(200);
        expect(Number(updated.body?.price), 'new menu price').eq(32700);
        return snapshotPrice(oldOrderId);
      }).then((old) => {
        expect(old.status, 'old order closed').eq('CLOSED');
        expect(old.price, 'old order price unchanged').eq(31700);
        return startOrder();
      }).then((id) => { newOrderId = id; return snapshotPrice(id); })
      .then((newItem) => {
        expect(newItem.price, 'new order uses new price').eq(32700);
        return snapshotPrice(oldOrderId);
      }).then((old) => {
        expect(old.price, 'old order still has original price').eq(31700);
        return closeOwn();
      }).then(() => note(`TC_EXT_005 assertions OK: QA menu ${fixture.menuId} price 31700 -> 32700; ` +
        `old order ${oldOrderId} unit_price=31700; new order ${newOrderId} unit_price=32700; ` +
        `${fixture.tableCode} AVAILABLE; archive follows`));
  });

  afterEach(() => {
    if (!fixture.menuId) return;
    return closeOwn().then(() => request('GET',
      `/api/v1/menu?q=${encodeURIComponent(fixture.menuName)}`, tokens.admin))
      .then((listed) => {
        if (listed.status !== 200) {
          throw new Error(`CLEANUP REQUIRED: QA menu ${fixture.menuId} GET HTTP ${listed.status}`);
        }
        const item = listed.body.find((entry) => entry.id === fixture.menuId);
        if (!item) throw new Error(`CLEANUP REQUIRED: QA menu ${fixture.menuId} not found`);
        if (!item.is_available) return item;
        return request('PATCH', `/api/v1/menu/${fixture.menuId}`, tokens.admin,
          { is_available: false }).then((archived) => {
          if (archived.status !== 200 || archived.body?.is_available !== false) {
            throw new Error(`CLEANUP REQUIRED: QA menu ${fixture.menuId} archive HTTP ${archived.status}`);
          }
          return archived.body;
        });
      }).then(() => note(`TC_EXT_005 QA menu ${fixture.menuId} is_available=false; inactive record remains`));
  });
});
