import assert from 'node:assert/strict';

// Complete only the table session and order created by this QA run.
// `checked` performs the authenticated request and verifies its HTTP status.
export async function completeOwnedKdsFixture(fixture, checked) {
  if (!fixture.sessionId) return;
  if (!fixture.orderId || !fixture.tableId) {
    throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} session ${fixture.sessionId}`);
  }
  const orderId = fixture.orderId;
  const orderPath = `/api/v1/orders/${orderId}`;
  const tablePath = `/api/v1/tables/${fixture.tableId}`;
  let table = await checked('GET', tablePath, 'waiter', 200);
  let current = await checked('GET', orderPath, 'waiter', 200);
  assert.equal(current.table_session_id, fixture.sessionId, 'owned order session');

  if (table.status === 'AVAILABLE' && !table.current_session && current.status === 'CLOSED') return;
  const ownOpenSession = table.status === 'OCCUPIED' &&
    table.current_session?.id === fixture.sessionId;
  const ownPaidSession = table.status === 'CLEANING' && !table.current_session &&
    ['PAID', 'CLOSED'].includes(current.status);
  if (!ownOpenSession && !ownPaidSession) {
    throw new Error(`CLEANUP REQUIRED: ${fixture.tableCode} state ${table.status}; ` +
      `session ${table.current_session?.id ?? 'none'}; owned ${fixture.sessionId}; ` +
      `order ${current.status}`);
  }

  if (current.status !== 'CLOSED') {
    // The SLA run leaves its own item PREPARING. Billing requires SERVED.
    for (const item of current.items ?? []) {
      const itemPath = `${orderPath}/items/${item.id}`;
      if (item.status === 'SENT') await checked('POST', `${itemPath}/start-cooking`, 'kitchen', 200);
      if (['SENT', 'PREPARING'].includes(item.status)) {
        await checked('POST', `${itemPath}/mark-ready`, 'kitchen', 200);
      }
      if (['SENT', 'PREPARING', 'READY'].includes(item.status)) {
        await checked('POST', `${itemPath}/pickup`, 'waiter', 200);
      }
      if (['SENT', 'PREPARING', 'READY', 'PICKED_UP'].includes(item.status)) {
        await checked('POST', `${itemPath}/served`, 'waiter', 200);
      }
    }
    current = await checked('GET', orderPath, 'waiter', 200);
    if (['SENT', 'SERVED'].includes(current.status)) {
      assert.ok(current.items?.length > 0 && current.items.every(item => item.status === 'SERVED'),
        'owned items served before billing');
      await checked('POST', `${orderPath}/request-billing`, 'waiter', 200);
      current = await checked('GET', orderPath, 'waiter', 200);
    }
    if (current.status === 'BILLING') {
      await checked('POST', `${orderPath}/pay`, 'cashier', 200);
      current = await checked('GET', orderPath, 'waiter', 200);
    }
    if (current.status === 'PAID') await checked('POST', `${orderPath}/close`, 'cashier', 200);
  }

  current = await checked('GET', orderPath, 'waiter', 200);
  assert.equal(current.status, 'CLOSED', 'own order closed before cleaning');
  table = await checked('GET', tablePath, 'waiter', 200);
  if (table.status === 'CLEANING') {
    await checked('POST', `${tablePath}/mark-clean`, 'waiter', 200);
  }
  table = await checked('GET', tablePath, 'waiter', 200);
  assert.equal(table.status, 'AVAILABLE', 'cleaned table');
  assert.equal(table.current_session, null, 'no open session after cleanup');
}
