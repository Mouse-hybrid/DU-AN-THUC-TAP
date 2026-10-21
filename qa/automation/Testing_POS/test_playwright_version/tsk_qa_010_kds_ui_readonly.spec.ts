import {test, expect, type Response} from '@playwright/test';

// UI component readiness only. Does not change an order or prove SLA boundaries,
// Expeditor gating, WebSocket reconnect or the full TSK-QA-010 business scenario.
test('PF-UI-010 | KDS reads queue, tabs and station filter', async ({page}, testInfo) => {
  test.setTimeout(30_000);
  const pin = process.env.KDS_STAGING_PIN;
  test.skip(!pin, 'Local Kitchen staging PIN required');
  const base = (process.env.BASE_URL || 'http://160.191.47.17').replace(/\/+$/, '');
  expect(base, 'approved staging').toBe('http://160.191.47.17');

  const wsPaths: string[] = [];
  const mutations: string[] = [];
  page.on('websocket', socket => wsPaths.push(new URL(socket.url()).pathname));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/v1/') && request.method() !== 'GET' &&
        path !== '/api/v1/auth/login') mutations.push(`${request.method()} ${path}`);
  });
  const apiGet = (response: Response, path: string) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === path;

  await page.goto('/login', {waitUntil: 'domcontentloaded'});
  await page.getByLabel('Mã nhân viên', {exact:true}).fill('kitchen');
  await page.getByLabel('Mã PIN', {exact:true}).fill(pin!);
  const queueWait = page.waitForResponse(response => apiGet(response, '/api/v1/kitchen/queue'));
  const stationsWait = page.waitForResponse(response => apiGet(response, '/api/v1/kitchen/stations'));
  await page.getByRole('button', {name:'Đăng nhập', exact:true}).click();
  await expect(page).toHaveURL(/\/kitchen$/, {timeout:15_000});
  const [queueResponse, stationsResponse] = await Promise.all([queueWait, stationsWait]);
  expect(queueResponse.status(), 'initial Queue GET').toBe(200);
  expect(stationsResponse.status(), 'Stations GET').toBe(200);
  const queue = await queueResponse.json();
  const stations = await stationsResponse.json();
  expect(Array.isArray(queue), 'queue array').toBe(true);
  expect(Array.isArray(stations), 'station array').toBe(true);
  await expect(page.getByRole('tab', {name:'Món mới'})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Trạm bếp')).toBeVisible();
  await expect(page.getByRole('heading', {name:'Màn bếp sắp có'})).toHaveCount(0);

  const activeStation = stations.find((station: {id: string; is_active?: boolean}) => station.is_active !== false);
  expect(activeStation, 'at least one active station').toBeTruthy();
  const filteredWait = page.waitForResponse(response =>
    apiGet(response, '/api/v1/kitchen/queue') &&
    new URL(response.url()).searchParams.get('station_id') === activeStation.id
  );
  await page.getByLabel('Trạm bếp').selectOption(activeStation.id);
  const filtered = await filteredWait;
  expect(filtered.status(), 'station-filtered Queue GET').toBe(200);
  const entries = await filtered.json();
  expect(Array.isArray(entries), 'filtered queue array').toBe(true);
  expect(entries.every((entry: {station_id: string}) => entry.station_id === activeStation.id),
    'server station partition').toBe(true);
  await expect(page.getByLabel('Trạm bếp')).toHaveValue(activeStation.id);

  const preparingWait = page.waitForResponse(response =>
    apiGet(response, '/api/v1/kitchen/queue') &&
    new URL(response.url()).searchParams.get('status') === 'IN_PROGRESS'
  );
  await page.getByRole('tab', {name:'Đang chế biến'}).click();
  const preparing = await preparingWait;
  expect(preparing.status(), 'preparing Queue GET').toBe(200);
  expect(Array.isArray(await preparing.json()), 'preparing queue array').toBe(true);
  await expect(page.getByRole('tab', {name:'Đang chế biến'})).toHaveAttribute('aria-selected', 'true');
  expect(mutations, 'no business mutation from read-only inspection').toEqual([]);

  const diagnostic = {
    path: new URL(page.url()).pathname,
    initialQueueItems: queue.length,
    activeStations: stations.filter((s: {is_active?: boolean}) => s.is_active !== false).length,
    stationFilterChecked: true,
    preparingStatus: preparing.status(),
    websocketPaths: wsPaths,
    scope: 'KDS UI/REST readiness; SLA color, Expeditor and WS reconnect not tested',
  };
  await testInfo.attach('PF_UI_010_KDS_readiness', {
    body: JSON.stringify(diagnostic, null, 2), contentType:'application/json',
  });
  await testInfo.attach('PF_UI_010_KDS_screen', {
    body: await page.screenshot({fullPage:true}), contentType:'image/png',
  });
  console.log(`[TSK-QA-010] PF-UI-010 PASS: Queue 200 (${queue.length}), stations 200 (${diagnostic.activeStations} active), ` +
    `filter ${diagnostic.stationFilterChecked}, preparing 200; WS paths ${wsPaths.join(',') || 'none'}; business case untested`);
});
