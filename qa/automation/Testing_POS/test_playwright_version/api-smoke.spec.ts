import { test, expect } from '@playwright/test';
import { screenshotSuccess } from '../utils/screenshot_success';

test.describe('POS System - API Smoke Test', () => {

  test('API-001 - Health API', async ({ request, page }, testInfo) => {
    const response = await request.get('/health');

    expect(response.status()).toBe(200);

    const body = await response.json();

    expect(body).toHaveProperty('status');
    expect(body.status).toBe('ok');

    await screenshotSuccess(page, {
      testId: 'API-001',
      testName: 'Health API',
      statusCode: response.status(),
      testInfo,
    });
  });


  test('API-002 - Readiness API', async ({ request, page }, testInfo) => {
    const response = await request.get('/ready');

    expect([200, 503]).toContain(response.status());

    const body = await response.json();

    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('environment');
    expect(body).toHaveProperty('database');

    await screenshotSuccess(page, {
      testId: 'API-002',
      testName: 'Readiness API',
      statusCode: response.status(),
      testInfo,
    });
  });


  test('API-003 - Mock Summary API', async ({ request, page }, testInfo) => {
    const response = await request.get('/api/v1/mock/summary');

    expect(response.status()).toBe(200);

    const body = await response.json();

    expect(body).toHaveProperty('environment');
    expect(body).toHaveProperty('data_mode');
    expect(body).toHaveProperty('screens');
    expect(body).toHaveProperty('message');

    expect(body.data_mode).toBe('mock');

    expect(body.screens).toEqual(
      expect.arrayContaining([
        'landing',
        'pos',
        'kitchen',
        'customer',
        'admin',
      ])
    );

    await screenshotSuccess(page, {
      testId: 'API-003',
      testName: 'Mock Summary API',
      statusCode: response.status(),
      testInfo,
    });
  });


  test('API-004 - OpenAPI documentation', async ({ request, page }, testInfo) => {
    const response = await request.get('/openapi.json');

    expect(response.status()).toBe(200);

    const body = await response.json();

    expect(body).toHaveProperty('openapi');
    expect(body).toHaveProperty('info');
    expect(body).toHaveProperty('paths');

    expect(body.info.title).toBe('POS Staging API');

    await screenshotSuccess(page, {
      testId: 'API-004',
      testName: 'OpenAPI Documentation',
      statusCode: response.status(),
      testInfo,
    });
  });


  test('API-005 - Login API không nhận request rỗng', async ({ request, page }, testInfo) => {
    const response = await request.post('/api/v1/auth/login', {
      data: {},
    });

    expect(response.status()).toBe(422);

    await screenshotSuccess(page, {
      testId: 'API-005',
      testName: 'Login API Validation',
      statusCode: response.status(),
      testInfo,
    });
  });


  test('API-006 - Protected API yêu cầu authentication', async ({ request, page }, testInfo) => {
    const response = await request.get('/api/v1/menu');

    expect([401, 403, 404]).toContain(response.status());

    await screenshotSuccess(page, {
      testId: 'API-006',
      testName: 'Authentication Required',
      statusCode: response.status(),
      testInfo,
    });
  });

});