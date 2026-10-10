/* TC_EXT_001..009 — API-backed Cypress regression against approved QA staging only.
   Configuration: cy.env('POS_BASE_URL'), POS_USERNAME, POS_PASSWORD,
   optional EXT_RUN_MUTATIONS=true and fixtures (see TC_EXT_README.md).
   Never run these mutation cases against production. */
const QA_ENV_KEYS = ['POS_BASE_URL','POS_USERNAME','POS_PASSWORD','EXT_RUN_MUTATIONS',
  'EXT_AVAILABLE_TABLE_ID','EXT_INACTIVE_CATEGORY_ID','EXT_CATEGORY_ID',
  'EXT_CATEGORY_MENU_ITEM_ID','EXT_PRICE_MENU_ITEM_ID','EXT_OLD_ORDER_ID',
  'EXT_NEW_ORDER_ID','EXT_NEW_PRICE','EXT_ORDER_ID','EXT_UNAVAILABLE_ITEM_ID',
  'EXT_SELLABLE_ITEM_ID'];
let qaEnv = {};
const get = (key) => qaEnv[key];
const api = (path) => (get('POS_BASE_URL') || 'http://160.191.47.17').replace(/\/$/, '') + '/api/v1' + path;
const mutable = () => String(get('EXT_RUN_MUTATIONS')) === 'true';
const requireFixtures = (...keys) => {
  const missing = keys.filter(k => !get(k));
  if (missing.length) return false;
  return true;
};
const jsonItems = (body) => {
  if (Array.isArray(body)) return body;
  for (const key of ['items', 'data', 'results', 'categories']) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
};
const auth = () => {
  const username = get('POS_USERNAME');
  const password = get('POS_PASSWORD');
  if (!username || !password) throw new Error('Missing CYPRESS_POS_USERNAME or CYPRESS_POS_PASSWORD. Load real staging credentials in this terminal (not example placeholders).');
  return cy.request({ method:'POST', url:api('/auth/login'), body:{username,password}, failOnStatusCode:false })
    .then(r => {
      if (r.status !== 200) {
        const fields = Array.isArray(r.body?.detail)
          ? r.body.detail.map(x => String((x.loc || []).join('.')) + ': ' + String(x.type || 'invalid')).join('; ')
          : (typeof r.body?.detail === 'string' ? r.body.detail : 'check credentials or login schema');
        throw new Error('AUTH_SETUP_FAILED: login returned HTTP ' + r.status +
          ' (not an EXT testcase failure). ' + fields +
          '. Verify POS_TEST_USERNAME/POS_TEST_PASSWORD in your local .env or set CYPRESS_POS_USERNAME/PASSWORD with valid staging values.');
      }
      const token = r.body.access_token || r.body?.data?.access_token;
      expect(token, 'access_token').to.be.a('string').and.not.be.empty;
      return { Authorization: 'Bearer ' + token };
    });
};
const req = (method,path,headers,body,more={}) => cy.request({
  method,url:api(path),headers,body,failOnStatusCode:false,...more
});
const unique = () => 'ext-' + Date.now() + '-' + Math.random().toString(16).slice(2);
const skipCase = (ctx, reason) => { cy.log('BLOCKED / NOT RUN: ' + reason); ctx.skip(); };
describe('TC_EXT_001–009 | QA staging API regression', () => {
  beforeEach(() => {
    cy.env(QA_ENV_KEYS).then(values => { qaEnv = values; });
  });
  it('TC_EXT_009 | protected tables requires Authorization', () => {
    req('GET','/tables',{}).then(r => {
      expect(r.status).eq(401);
      expect(jsonItems(r.body), 'must not disclose tables').to.have.length(0);
    });
  });
  it('TC_EXT_003 | active_only categories excludes inactive', function () {
    auth().then(h => {
      req('GET','/menu/categories',h).then(all => {
        expect(all.status).eq(200);
        const categories = jsonItems(all.body);
        expect(categories).to.be.an('array');
        const hidden = categories.filter(c => c.is_active === false);
        if (!hidden.length) return skipCase(this, 'No inactive category fixture in staging; cannot verify exclusion');
        req('GET','/menu/categories?active_only=true',h).then(active => {
          expect(active.status).eq(200);
          const visible = jsonItems(active.body);
          expect(visible).to.be.an('array');
          visible.forEach(c => expect(c.is_active, 'active-only category').eq(true));
          const visibleIds=visible.map(c=>String(c.id));
          hidden.forEach(c=>expect(visibleIds, 'inactive category must not appear').not.to.include(String(c.id)));
        });
      });
    });
  });
  it('TC_EXT_002 | guest_count=101 rejected without mutating table', function () {
    auth().then(h => req('GET','/tables',h).then(tables => {
      expect(tables.status).eq(200);
      const requested = get('EXT_AVAILABLE_TABLE_ID');
      const available = jsonItems(tables.body).filter(t => t.status==='AVAILABLE');
      const target = requested ? available.find(t=>String(t.id)===String(requested)) : available[0];
      if (!target) return skipCase(this, 'No AVAILABLE QA table: run validated Table Recovery before boundary case');
      req('POST','/tables/'+target.id+'/open-session',
        {...h,'Idempotency-Key':unique()}, {guest_count:101}).then(result => {
          expect(result.status).eq(422);
          req('GET','/tables/'+target.id,h).then(after => {
            expect(after.status).eq(200);
            expect(after.body.status).eq('AVAILABLE');
            expect(after.body.current_session, 'rejected boundary must not open session').to.be.oneOf([null, undefined]);
          });
        });
    }));
  });
  it('TC_EXT_001 | guest_count=100 boundary — controlled mutation', function () {
    if (!mutable() || !requireFixtures('EXT_AVAILABLE_TABLE_ID')) return skipCase(this,'EXT_RUN_MUTATIONS=true and EXT_AVAILABLE_TABLE_ID required; creates open session');
    auth().then(h => req('GET','/tables/'+get('EXT_AVAILABLE_TABLE_ID'),h).then(before => {
      expect(before.status).eq(200);
      expect(before.body.status).eq('AVAILABLE');
      req('POST','/tables/'+get('EXT_AVAILABLE_TABLE_ID')+'/open-session',h,{guest_count:100},
        {headers:{...h,'Idempotency-Key':unique()}}).then(r => {
          expect(r.status).eq(201);
          req('GET','/tables/'+get('EXT_AVAILABLE_TABLE_ID'),h).then(after => {
            expect(after.status).eq(200);
            expect(after.body.status).eq('OCCUPIED');
            expect(after.body.current_session?.guest_count).eq(100);
          });
        });
    }));
  });
  it('TC_EXT_004 | inactive category remains physically linked to menu item', function () {
    if (!mutable() || !requireFixtures('EXT_CATEGORY_ID','EXT_CATEGORY_MENU_ITEM_ID')) return skipCase(this,'isolated category/menu item fixture + mutation opt-in required');
    auth().then(h => req('GET','/menu',h).then(before => {
      expect(before.status).eq(200);
      expect(jsonItems(before.body).some(x => String(x.id)===String(get('EXT_CATEGORY_MENU_ITEM_ID')))).eq(true);
      req('PATCH','/menu/categories/'+get('EXT_CATEGORY_ID'),h,{is_active:false}).then(update => {
        expect(update.status).eq(200);
        req('GET','/menu/categories?active_only=true',h).then(hidden => {
          expect(hidden.status).eq(200);
          expect(jsonItems(hidden.body).map(c=>String(c.id))).not.to.include(String(get('EXT_CATEGORY_ID')));
        });
        req('GET','/menu',h).then(after => {
          expect(after.status).eq(200);
          expect(jsonItems(after.body).some(x => String(x.id)===String(get('EXT_CATEGORY_MENU_ITEM_ID')))).eq(true);
        });
      });
    }));
  });
  it('TC_EXT_005 | historic order price snapshot', function () {
    if (!mutable() || !requireFixtures('EXT_PRICE_MENU_ITEM_ID','EXT_OLD_ORDER_ID','EXT_NEW_ORDER_ID','EXT_NEW_PRICE')) return skipCase(this,'old/new order fixtures and price mutation opt-in required');
    const menuId=get('EXT_PRICE_MENU_ITEM_ID'), newPrice=Number(get('EXT_NEW_PRICE'));
    const unit=(order)=>jsonItems(order?.items ? order.items : order?.order || order).find(x=>String(x.menu_item_id)===String(menuId))?.unit_price;
    auth().then(h => req('GET','/orders/'+get('EXT_OLD_ORDER_ID'),h).then(old => {
      expect(old.status).eq(200);
      const oldPrice = unit(old.body);
      expect(oldPrice, 'old order item unit price').to.exist;
      req('PATCH','/menu/'+menuId,h,{price:newPrice}).then(patch => {
        expect(patch.status).eq(200);
        req('GET','/orders/'+get('EXT_OLD_ORDER_ID'),h).then(oldAgain => {
          expect(oldAgain.status).eq(200);
          expect(String(unit(oldAgain.body))).eq(String(oldPrice));
        });
        // NEW order must already have its item added AFTER the patch: do not invent this step.
        req('GET','/orders/'+get('EXT_NEW_ORDER_ID'),h).then(fresh => {
          expect(fresh.status).eq(200);
          expect(Number(unit(fresh.body))).eq(newPrice);
        });
      });
    }));
  });
  it('TC_EXT_006 | unavailable item rejected and subtotal unchanged', function () {
    if (!mutable() || !requireFixtures('EXT_ORDER_ID','EXT_UNAVAILABLE_ITEM_ID')) return skipCase(this,'isolated order and unavailable menu item required');
    auth().then(h => req('GET','/orders/'+get('EXT_ORDER_ID'),h).then(before => {
      expect(before.status).eq(200);
      const value=before.body.subtotal ?? before.body.order?.subtotal;
      req('POST','/orders/'+get('EXT_ORDER_ID')+'/items',{...h,'Idempotency-Key':unique()}, {menu_item_id:get('EXT_UNAVAILABLE_ITEM_ID'),quantity:1}).then(r => {
        expect(r.status).eq(409);
        req('GET','/orders/'+get('EXT_ORDER_ID'),h).then(after => {
          expect(after.status).eq(200);
          expect(String(after.body.subtotal ?? after.body.order?.subtotal)).eq(String(value));
        });
      });
    }));
  });
  it('TC_EXT_007 | same Idempotency-Key and payload do not duplicate', function () {
    if (!mutable() || !requireFixtures('EXT_ORDER_ID','EXT_SELLABLE_ITEM_ID')) return skipCase(this,'isolated NEW order and sellable item required');
    auth().then(h => {
      const key=unique(), headers={...h,'Idempotency-Key':key};
      const body={menu_item_id:get('EXT_SELLABLE_ITEM_ID'),quantity:1};
      req('POST','/orders/'+get('EXT_ORDER_ID')+'/items',headers,body).then(first => {
        expect(first.status).eq(201);
        req('GET','/orders/'+get('EXT_ORDER_ID'),h).then(mid => {
          req('POST','/orders/'+get('EXT_ORDER_ID')+'/items',headers,body).then(second => {
            expect(second.status).to.be.oneOf([200,201]);
            req('GET','/orders/'+get('EXT_ORDER_ID'),h).then(after => {
              const normalize=o=>o.body.order || o.body;
              expect(String(normalize(after).subtotal)).eq(String(normalize(mid).subtotal));
              expect(jsonItems(normalize(after).items).length).eq(jsonItems(normalize(mid).items).length);
            });
          });
        });
      });
    });
  });
  it('TC_EXT_008 | same Idempotency-Key different body rejected', function () {
    if (!mutable() || !requireFixtures('EXT_ORDER_ID','EXT_SELLABLE_ITEM_ID')) return skipCase(this,'isolated NEW order and sellable item required; run after EXT_007 only if fixture allows');
    auth().then(h => {
      const key=unique(), headers={...h,'Idempotency-Key':key};
      const body={menu_item_id:get('EXT_SELLABLE_ITEM_ID'),quantity:1};
      req('POST','/orders/'+get('EXT_ORDER_ID')+'/items',headers,body).then(first => {
        expect(first.status).eq(201);
        req('GET','/orders/'+get('EXT_ORDER_ID'),h).then(before => {
          req('POST','/orders/'+get('EXT_ORDER_ID')+'/items',headers,{...body,quantity:2}).then(second => {
            expect(second.status).eq(409);
            req('GET','/orders/'+get('EXT_ORDER_ID'),h).then(after => {
              const a=after.body.order || after.body, b=before.body.order || before.body;
              expect(String(a.subtotal)).eq(String(b.subtotal));
              expect(a.items.length).eq(b.items.length);
            });
          });
        });
      });
    });
  });
});
