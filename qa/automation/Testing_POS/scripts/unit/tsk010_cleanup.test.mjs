import assert from 'node:assert/strict';
import test from 'node:test';
import {completeOwnedKdsFixture} from '../../test_playwright_version/helpers/tsk010_cleanup.mjs';

const fixture = {
  tableId: 'table-qa', tableCode: 'B1', sessionId: 'session-qa', orderId: 'order-qa',
};

function statefulApi({tableStatus = 'OCCUPIED', sessionId = fixture.sessionId,
  orderStatus = 'SENT', itemStatus = 'PREPARING'} = {}) {
  const state = {tableStatus, sessionId, orderStatus, itemStatus, calls: []};
  async function checked(method, path, role, expected) {
    state.calls.push(`${method} ${path}`);
    if (method === 'GET' && path.endsWith('/tables/table-qa')) {
      return {status: state.tableStatus,
        current_session: state.sessionId ? {id: state.sessionId} : null};
    }
    if (method === 'GET' && path.endsWith('/orders/order-qa')) {
      return {id: fixture.orderId, table_session_id: fixture.sessionId,
        status: state.orderStatus, items: [{id: 'item-qa', status: state.itemStatus}]};
    }
    assert.equal(expected, 200);
    assert.equal(method, 'POST');
    const action = path.split('/').at(-1);
    if (action === 'mark-ready') {
      assert.equal(role, 'kitchen'); assert.equal(state.itemStatus, 'PREPARING');
      state.itemStatus = 'READY';
    } else if (action === 'pickup') {
      assert.equal(role, 'waiter'); assert.equal(state.itemStatus, 'READY');
      state.itemStatus = 'PICKED_UP';
    } else if (action === 'served') {
      assert.equal(role, 'waiter'); assert.equal(state.itemStatus, 'PICKED_UP');
      state.itemStatus = 'SERVED';
    } else if (action === 'request-billing') {
      assert.equal(state.itemStatus, 'SERVED');
      assert.equal(state.orderStatus, 'SENT');
      state.orderStatus = 'BILLING';
    } else if (action === 'pay') {
      assert.equal(state.orderStatus, 'BILLING');
      state.orderStatus = 'PAID'; state.tableStatus = 'CLEANING'; state.sessionId = null;
    } else if (action === 'close') {
      assert.equal(state.orderStatus, 'PAID'); state.orderStatus = 'CLOSED';
    } else if (action === 'mark-clean') {
      assert.equal(state.orderStatus, 'CLOSED');
      assert.equal(state.tableStatus, 'CLEANING'); state.tableStatus = 'AVAILABLE';
    } else {
      assert.fail(`Unexpected mutation ${path}`);
    }
    return {status: state.tableStatus};
  }
  return {state, checked};
}

test('PREPARING item is served before billing, then owned order and table close', async () => {
  const {state, checked} = statefulApi();
  await completeOwnedKdsFixture(fixture, checked);
  assert.equal(state.itemStatus, 'SERVED');
  assert.equal(state.orderStatus, 'CLOSED');
  assert.equal(state.tableStatus, 'AVAILABLE');
  assert.deepEqual(state.calls.filter(call => call.startsWith('POST')),
    ['POST /api/v1/orders/order-qa/items/item-qa/mark-ready',
      'POST /api/v1/orders/order-qa/items/item-qa/pickup',
      'POST /api/v1/orders/order-qa/items/item-qa/served',
      'POST /api/v1/orders/order-qa/request-billing',
      'POST /api/v1/orders/order-qa/pay',
      'POST /api/v1/orders/order-qa/close',
      'POST /api/v1/tables/table-qa/mark-clean']);
});

test('PAID order with closed session is closed and cleaned without billing again', async () => {
  const {state, checked} = statefulApi({tableStatus: 'CLEANING', sessionId: null,
    orderStatus: 'PAID', itemStatus: 'SERVED'});
  await completeOwnedKdsFixture(fixture, checked);
  assert.equal(state.tableStatus, 'AVAILABLE');
  assert.deepEqual(state.calls.filter(call => call.startsWith('POST')),
    ['POST /api/v1/orders/order-qa/close',
      'POST /api/v1/tables/table-qa/mark-clean']);
});

test('foreign table session stops before any mutation', async () => {
  const {state, checked} = statefulApi({sessionId: 'another-session'});
  await assert.rejects(completeOwnedKdsFixture(fixture, checked), /CLEANUP REQUIRED/);
  assert.deepEqual(state.calls.filter(call => call.startsWith('POST')), []);
});
