import { test, expect } from '@playwright/test';
import { screenshotSuccess } from '../utils/screenshot_success';

test.describe('POS System - API Core Flow', () => {

  test('API-CORE-001 - Login → Menu → Open Session → Create Order → Add Item → Kitchen Lifecycle', async ({ request, page }, testInfo) => {
    const username = process.env.POS_TEST_USERNAME;
    const password = process.env.POS_TEST_PASSWORD;
    const tableId = process.env.POS_TEST_TABLE_ID;

    test.skip(
      !username || !password || !tableId,
      'Missing POS_TEST_USERNAME, POS_TEST_PASSWORD or POS_TEST_TABLE_ID'
    );

    // 1. Login
    const loginResponse = await test.step('API-CORE-001 - Login', async () => {
      return request.post('/api/v1/auth/login', {
        data: {
          username,
          password,
        },
      });
    });

    expect(loginResponse.ok()).toBeTruthy();

    const loginBody = await loginResponse.json();

    expect(loginBody).toHaveProperty('access_token');
    expect(loginBody.access_token).toBeTruthy();

    const token = loginBody.access_token as string;
    const authHeaders = {
      Authorization: `Bearer ${token}`,
    };

    // 2. Menu
    const menuResponse = await test.step('API-CORE-002 - Get Menu', async () => {
      return request.get('/api/v1/menu', {
        headers: authHeaders,
      });
    });

    expect(menuResponse.ok()).toBeTruthy();

    const menuBody = await menuResponse.json();

    expect(Array.isArray(menuBody)).toBeTruthy();

    const availableMenuItem = menuBody.find(
      (item: {
        id?: string;
        name?: string;
        price?: string;
        is_available?: boolean;
        station_id?: string | null;
      }) =>
        item &&
        typeof item.id === 'string' &&
        item.is_available === true
    );

    expect(availableMenuItem).toBeTruthy();
    expect(availableMenuItem.id).toBeTruthy();

    const menuItemId = availableMenuItem.id as string;

    // 3. Open table session
    const openSessionResponse = await test.step('API-CORE-003 - Open Session', async () => {
      return request.post(`/api/v1/tables/${tableId}/open_session`, {
        headers: authHeaders,
        data: {
          guest_count: 1,
        },
      });
    });

    expect(openSessionResponse.ok()).toBeTruthy();

    const sessionBody = await openSessionResponse.json();

    expect(sessionBody).toHaveProperty('id');
    expect(sessionBody.id).toBeTruthy();

    const tableSessionId = sessionBody.id as string;

    // 4. Create order
    const createOrderRequestId = `api-core-create-order-${Date.now()}`;

    const createOrderResponse = await test.step('API-CORE-004 - Create Order', async () => {
      return request.post('/api/v1/orders', {
        headers: {
          ...authHeaders,
          'X-Request-Id': createOrderRequestId,
        },
        data: {
          table_session_id: tableSessionId,
        },
      });
    });

    expect(createOrderResponse.ok()).toBeTruthy();

    const orderBody = await createOrderResponse.json();

    expect(orderBody).toHaveProperty('id');
    expect(orderBody.id).toBeTruthy();

    const orderId = orderBody.id as string;

    // 5. Add menu item
    const addItemRequestId = `api-core-add-item-${Date.now()}`;

    const addItemResponse = await test.step('API-CORE-005 - Add Menu Item', async () => {
      return request.post(`/api/v1/orders/${orderId}/items`, {
        headers: {
          ...authHeaders,
          'X-Request-Id': addItemRequestId,
        },
        data: {
          items: [
            {
              menu_item_id: menuItemId,
              quantity: 1,
              note: null,
            },
          ],
        },
      });
    });

    expect(addItemResponse.ok()).toBeTruthy();

    const addItemBody = await addItemResponse.json();

    expect(addItemBody).toBeTruthy();

    const returnedItems = Array.isArray(addItemBody)
      ? addItemBody
      : Array.isArray(addItemBody.items)
        ? addItemBody.items
        : Array.isArray(addItemBody.order?.items)
          ? addItemBody.order.items
          : [];

    const createdItem = returnedItems.find(
      (item: { id?: string; menu_item_id?: string }) =>
        item &&
        typeof item.id === 'string' &&
        item.menu_item_id === menuItemId
    );

    expect(createdItem).toBeTruthy();

    const itemId = createdItem.id as string;

    // 6. Send order to kitchen
    const sendKitchenRequestId = `api-core-send-kitchen-${Date.now()}`;

    const sendKitchenResponse = await test.step('API-CORE-006 - Send to Kitchen', async () => {
      return request.post(`/api/v1/orders/${orderId}/send_to_kitchen`, {
        headers: {
          ...authHeaders,
          'X-Request-Id': sendKitchenRequestId,
        },
      });
    });

    expect(sendKitchenResponse.ok()).toBeTruthy();

    const sendKitchenBody = await sendKitchenResponse.json();

    expect(sendKitchenBody).toBeTruthy();

    // 7. Start cooking
    const startCookingResponse = await test.step('API-CORE-007 - Start Cooking', async () => {
      return request.post(
        `/api/v1/orders/${orderId}/items/${itemId}/start_cooking`,
        {
          headers: authHeaders,
        }
      );
    });

    expect(startCookingResponse.ok()).toBeTruthy();

    const startCookingBody = await startCookingResponse.json();

    expect(startCookingBody).toHaveProperty('status');
    expect(startCookingBody.status).toBe('PREPARING');

    // 8. Mark ready
    const markReadyResponse = await test.step('API-CORE-008 - Mark Ready', async () => {
      return request.post(
        `/api/v1/orders/${orderId}/items/${itemId}/mark_ready`,
        {
          headers: authHeaders,
        }
      );
    });

    expect(markReadyResponse.ok()).toBeTruthy();

    const markReadyBody = await markReadyResponse.json();

    expect(markReadyBody).toHaveProperty('status');
    expect(markReadyBody.status).toBe('READY');

    // 9. Pickup
    const pickupResponse = await test.step('API-CORE-009 - Pickup', async () => {
      return request.post(
        `/api/v1/orders/${orderId}/items/${itemId}/pickup`,
        {
          headers: authHeaders,
        }
      );
    });

    expect(pickupResponse.ok()).toBeTruthy();

    const pickupBody = await pickupResponse.json();

    expect(pickupBody).toHaveProperty('status');
    expect(pickupBody.status).toBe('PICKED_UP');

    // 10. Served
    const servedResponse = await test.step('API-CORE-010 - Served', async () => {
      return request.post(
        `/api/v1/orders/${orderId}/items/${itemId}/served`,
        {
          headers: authHeaders,
        }
      );
    });

    expect(servedResponse.ok()).toBeTruthy();

    const servedBody = await servedResponse.json();

    expect(servedBody).toHaveProperty('status');
    expect(servedBody.status).toBe('SERVED');

    await screenshotSuccess(page, {
      testId: 'API-CORE-001',
      testName: 'Login to Kitchen Lifecycle',
      statusCode: servedResponse.status(),
      testInfo,
    });
  });

});
