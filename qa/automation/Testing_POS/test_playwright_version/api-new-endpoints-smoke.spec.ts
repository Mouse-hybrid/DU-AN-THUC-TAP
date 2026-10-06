import 'dotenv/config';
import { env } from 'node:process';
import { test, expect } from '@playwright/test';

const baseHeaders = () => {
  const token = env.POS_TEST_ACCESS_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const requireEnv = (...names: string[]) => {
  const missing = names.filter((name) => !env[name]);
  test.skip(
    missing.length > 0,
    `Missing test environment variables: ${missing.join(', ')}`
  );
};

test.describe('POS System - New API Endpoint Smoke', () => {

  test('API-NEW-001 - Table Dashboard', async ({ request }) => {
    requireEnv('POS_TEST_ACCESS_TOKEN');

    const response = await request.get('/api/v1/tables', {
      headers: baseHeaders(),
    });

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();

    for (const table of body) {
      expect(table).toHaveProperty('id');
      expect(table).toHaveProperty('code');
      expect(table).toHaveProperty('seats');
      expect(table).toHaveProperty('status');
      expect(table).toHaveProperty('current_session_id');
      expect(table).toHaveProperty('guest_count');
      expect(table).toHaveProperty('opened_at');
    }
  });

  test('API-NEW-002 - Mark Table Clean', async ({ request }) => {
    requireEnv('POS_TEST_ACCESS_TOKEN', 'POS_TEST_TABLE_ID');

    const response = await request.post(
      `/api/v1/tables/${env.POS_TEST_TABLE_ID}/mark_clean`,
      {
        headers: baseHeaders(),
      }
    );

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body).toBeTruthy();
  });

  test('API-NEW-003 - Update Order Item', async ({ request }) => {
    requireEnv(
      'POS_TEST_ACCESS_TOKEN',
      'POS_TEST_ORDER_ID',
      'POS_TEST_ORDER_ITEM_ID'
    );

    const response = await request.patch(
      `/api/v1/orders/${env.POS_TEST_ORDER_ID}/items/${env.POS_TEST_ORDER_ITEM_ID}`,
      {
        headers: baseHeaders(),
        data: {
          quantity: 2,
        },
      }
    );

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body).toBeTruthy();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('menu_item_id');
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('quantity');
    expect(body).toHaveProperty('unit_price');
    expect(body).toHaveProperty('note');
  });

  test('API-NEW-004 - Remove Order Item', async ({ request }) => {
    requireEnv(
      'POS_TEST_ACCESS_TOKEN',
      'POS_TEST_ORDER_ID',
      'POS_TEST_ORDER_ITEM_ID'
    );

    const response = await request.delete(
      `/api/v1/orders/${env.POS_TEST_ORDER_ID}/items/${env.POS_TEST_ORDER_ITEM_ID}`,
      {
        headers: baseHeaders(),
      }
    );

    expect(response.ok()).toBeTruthy();
  });

  test('API-NEW-005 - Kitchen Queue', async ({ request }) => {
    requireEnv('POS_TEST_ACCESS_TOKEN');

    const response = await request.get('/api/v1/kitchen/queue', {
      headers: baseHeaders(),
    });

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();

    for (const entry of body) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('order_id');
      expect(entry).toHaveProperty('menu_item_name');
      expect(entry).toHaveProperty('quantity');
      expect(entry).toHaveProperty('note');
      expect(entry).toHaveProperty('station_id');
      expect(entry).toHaveProperty('status');
      expect(entry).toHaveProperty('queued_at');
      expect(entry).toHaveProperty('started_at');
    }
  });

  test('API-NEW-006 - Kitchen Stations', async ({ request }) => {
    requireEnv('POS_TEST_ACCESS_TOKEN');

    const response = await request.get('/api/v1/kitchen/stations', {
      headers: baseHeaders(),
    });

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();

    for (const station of body) {
      expect(station).toHaveProperty('id');
      expect(station).toHaveProperty('name');
      expect(station).toHaveProperty('is_active');
    }
  });

});
