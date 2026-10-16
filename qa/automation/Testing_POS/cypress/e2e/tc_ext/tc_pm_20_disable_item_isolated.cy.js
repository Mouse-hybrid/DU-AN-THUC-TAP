// Phase 1 TC_PM_20: disabling an available QA menu item removes it from sale.
// The menu record remains archived because staging does not expose item DELETE.
describe('Phase 1 | TC_PM_20 disable menu item', () => {
  const base = 'http://160.191.47.17';
  let tokens = {};
  let fixture = {};

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
    method: 'POST', url: base + '/api/v1/auth/login',
    body: { username, password }, failOnStatusCode: false, timeout: 20000, log: false,
  }).then((result) => {
    expect(result.status, `${username} login`).eq(200);
    expect(result.body?.access_token, `${username} JWT`).to.be.a('string').and.not.be.empty;
    return result.body.access_token;
  });
  const order = () => request('GET', `/api/v1/orders/${fixture.orderId}`, tokens.admin)
    .then((result) => {
      expect(result.status, 'GET own order').eq(200);
      return result.body;
    });
  const subtotal = () => request('GET',
    `/api/v1/orders?table_id=${fixture.tableId}&limit=50`, tokens.admin)
    .then((result) => {
      expect(result.status, 'GET order summaries').eq(200);
      const own = result.body?.find((entry) => entry.id === fixture.orderId);
      expect(own, 'own order summary').to.exist;
      return Number(own.subtotal);
    });
  const reserve = (tables) => {
    if (!tables.length) return cy.wrap(null, { log: false });
    const table = tables.shift();
    return request('POST', `/api/v1/tables/${table.id}/open-session`, tokens.waiter,
      { guest_count: 2 }).then((result) => {
      if (result.status === 409) return reserve(tables);
      expect(result.status, `open ${table.code}`).eq(201);
      fixture.tableId = table.id;
      fixture.tableCode = table.code;
      fixture.sessionId = result.body?.id;
      expect(fixture.sessionId, 'own table session').to.be.a('string').and.not.be.empty;
      return table;
    });
  };

  beforeEach(function () {
    fixture = {};
    tokens = {};
    return cy.env(['POS_BASE_URL', 'DES05_SEED_PASSWORD'], { log: false }).then((env) => {
      if (String(env.POS_BASE_URL || base).replace(/\/+$/, '') !== base) {
        throw new Error('SAFETY: approved staging only');
      }
      if (!env.DES05_SEED_PASSWORD) {
        return note('TC_PM_20 PENDING: local staging PIN missing').then(() => this.skip());
      }
      const password = String(env.DES05_SEED_PASSWORD);
      return login('admin', password).then((token) => { tokens.admin = token; })
        .then(() => login('waiter', password)).then((token) => { tokens.waiter = token; })
        .then(() => login('cashier', password)).then((token) => { tokens.cashier = token; })
        .then(() => request('GET', '/api/v1/menu/categories?active_only=true', tokens.admin))
        .then((categories) => {
          expect(categories.status, 'category GET').eq(200);
          const category = categories.body.find((entry) => entry.is_active && entry.id);
          return request('GET', '/api/v1/menu?available_only=true', tokens.cashier)
            .then((menu) => ({ category, menu }));
        }).then(({ category, menu }) => {
          expect(menu.status, 'available Menu GET').eq(200);
          const mapped = menu.body.find((entry) => entry.is_available && entry.station_id);
          if (!category || !mapped) {
            return note('TC_PM_20 PENDING: active category or mapped item missing')
              .then(() => this.skip());
          }
          fixture.name = `PHASE1-QA-DISABLE-${key()}`;
          fixture.mappedId = mapped.id;
          return request('POST', '/api/v1/menu', tokens.admin, {
            name: fixture.name, price: '31700.00', category_id: category.id,
            station_id: mapped.station_id, is_available: true,
          }).then((created) => {
            expect(created.status, 'create available QA item').eq(201);
            fixture.menuId = created.body?.id;
            expect(created.body?.is_available, 'QA item initially available').eq(true);
            return request('GET', '/api/v1/tables', tokens.waiter);
          });
        }).then((tables) => {
          if (!tables) return;
          expect(tables.status, 'table GET').eq(200);
          const available = tables.body.filter((table) =>
            /^B[1-4]$/.test(table.code) && table.status === 'AVAILABLE');
          if (!available.length) return note('TC_PM_20 PENDING: no AVAILABLE B1-B4 table')
            .then(() => this.skip());
          return reserve(available).then((table) => {
            if (!table) return note('TC_PM_20 PENDING: table reservation lost')
              .then(() => this.skip());
            return request('POST', '/api/v1/orders', tokens.waiter,
              { table_session_id: fixture.sessionId }).then((created) => {
              expect(created.status, 'create own order').eq(201);
              fixture.orderId = created.body?.id;
              expect(fixture.orderId, 'order ID').to.be.a('string').and.not.be.empty;
              return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.waiter,
                { items: [{ menu_item_id: fixture.mappedId, quantity: 1,
                  note: 'Phase1 TC_PM_20 positive control' }] });
            }).then((added) => {
              expect(added.status, 'add control item').eq(201);
              expect(added.body?.items, 'one control item').to.have.length(1);
              return note(`TC_PM_20 fixture: ${fixture.tableCode}; order ${fixture.orderId}; available QA item ${fixture.menuId}`);
            });
          });
        });
    });
  });

  it('TC_PM_20 | Supervisor disables item; Cashier cannot add it', () => {
    let before;
    let beforeSubtotal;
    return request('GET', '/api/v1/menu?available_only=true', tokens.cashier)
      .then((initialMenu) => {
        expect(initialMenu.status, 'available Menu before PATCH').eq(200);
        expect(initialMenu.body.some((item) => item.id === fixture.menuId),
          'QA item initially listed').eq(true);
        return request('PATCH', `/api/v1/menu/${fixture.menuId}`, tokens.admin,
          { is_available: false });
      }).then((disabled) => {
        expect(disabled.status, 'Supervisor PATCH disable').eq(200);
        expect(disabled.body?.id, 'updated own item').eq(fixture.menuId);
        expect(disabled.body?.is_available, 'item disabled').eq(false);
        return request('GET', '/api/v1/menu?available_only=true', tokens.cashier);
      }).then((availableMenu) => {
        expect(availableMenu.status, 'available Menu after PATCH').eq(200);
        expect(availableMenu.body.some((item) => item.id === fixture.menuId),
          'disabled QA item omitted').eq(false);
        return order();
      }).then((ownOrder) => {
        before = ownOrder;
        return subtotal();
      }).then((amount) => {
        beforeSubtotal = amount;
        return request('POST', `/api/v1/orders/${fixture.orderId}/items`, tokens.cashier,
          { items: [{ menu_item_id: fixture.menuId, quantity: 1 }] });
      }).then((rejected) => {
        expect(rejected.status, 'unavailable item HTTP').eq(409);
        return order();
      }).then((after) => {
        expect(after.items.map((item) => item.id), 'items unchanged')
          .to.deep.eq(before.items.map((item) => item.id));
        expect(after.items.some((item) => item.menu_item_id === fixture.menuId),
          'unavailable item absent').eq(false);
        expect(after.current_version, 'version unchanged').eq(before.current_version);
        return subtotal();
      }).then((afterSubtotal) => {
        expect(afterSubtotal, 'subtotal unchanged').eq(beforeSubtotal);
        return note(`TC_PM_20 assertions OK: order ${fixture.orderId}; Supervisor PATCH item ${fixture.menuId} true -> false HTTP 200; available-only GET excludes item; Cashier add HTTP 409; items/version/subtotal unchanged; cleanup follows`);
      });
  });

  afterEach(() => {
    if (!fixture.menuId) return;
    const cleanupOrder = fixture.orderId
      ? request('POST', `/api/v1/orders/${fixture.orderId}/send-to-kitchen`, tokens.waiter)
        .then((sent) => {
          if (sent.status !== 200) throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} send HTTP ${sent.status}; QA menu ${fixture.menuId} archived separately`);
          return request('POST', `/api/v1/orders/${fixture.orderId}/request-billing`, tokens.waiter);
        }).then((billing) => {
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
          return note(`TC_PM_20 cleanup: ${fixture.tableCode} AVAILABLE; order ${fixture.orderId} CLOSED`);
        })
      : fixture.sessionId
        ? cy.wrap(null, { log: false }).then(() => {
          throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} open session ${fixture.sessionId} without order`);
        })
        : cy.wrap(null, { log: false });
    return cleanupOrder.then(() =>
      request('GET', `/api/v1/menu?q=${encodeURIComponent(fixture.name)}`, tokens.admin)
        .then((listed) => {
          expect(listed.status, 'QA menu cleanup GET').eq(200);
          const own = listed.body.find((entry) => entry.id === fixture.menuId);
          if (!own) throw new Error(`CLEANUP REQUIRED: QA menu ${fixture.menuId} missing`);
          if (!own.is_available) return own;
          return request('PATCH', `/api/v1/menu/${fixture.menuId}`, tokens.admin,
            { is_available: false }).then((archived) => {
            if (archived.status !== 200 || archived.body?.is_available !== false) {
              throw new Error(`CLEANUP REQUIRED: QA menu ${fixture.menuId} archive HTTP ${archived.status}`);
            }
            return archived.body;
          });
        }).then(() => note(`TC_PM_20 QA menu ${fixture.menuId} is_available=false; inactive record remains`)));
  });
});
