import type { Page, TestInfo } from '@playwright/test';

interface ScreenshotSuccessOptions {
  testId: string;
  testName: string;
  statusCode: number;
  testInfo: TestInfo;
}

export async function screenshotSuccess(
  page: Page,
  options: ScreenshotSuccessOptions
): Promise<void> {
  const {
    testId,
    testName,
    statusCode,
    testInfo,
  } = options;

  const safeName = testName
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />

        <style>
          body {
            margin: 0;
            padding: 40px;
            font-family: Arial, sans-serif;
            background: #f5f7fa;
          }

          .container {
            width: 800px;
            margin: auto;
            padding: 30px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }

          .title {
            font-size: 28px;
            font-weight: bold;
            margin-bottom: 25px;
          }

          .pass {
            display: inline-block;
            padding: 8px 18px;
            margin-bottom: 25px;
            border-radius: 6px;
            background: #22c55e;
            color: white;
            font-weight: bold;
          }

          .row {
            display: flex;
            padding: 14px 0;
            border-bottom: 1px solid #e5e7eb;
          }

          .label {
            width: 180px;
            font-weight: bold;
          }

          .value {
            flex: 1;
          }

          .success {
            color: #16a34a;
            font-weight: bold;
          }

          .footer {
            margin-top: 25px;
            color: #6b7280;
            font-size: 14px;
          }
        </style>
      </head>

      <body>
        <div class="container">

          <div class="title">
            POS System - API Test Result
          </div>

          <div class="pass">
            ✓ PASS
          </div>

          <div class="row">
            <div class="label">Test Case</div>
            <div class="value">${testId}</div>
          </div>

          <div class="row">
            <div class="label">Description</div>
            <div class="value">${testName}</div>
          </div>

          <div class="row">
            <div class="label">HTTP Status</div>
            <div class="value">${statusCode}</div>
          </div>

          <div class="row">
            <div class="label">Result</div>
            <div class="value success">
              API test passed successfully
            </div>
          </div>

          <div class="row">
            <div class="label">Duration</div>
            <div class="value">${testInfo.duration} ms</div>
          </div>

          <div class="footer">
            Generated automatically by Playwright
          </div>

        </div>
      </body>
    </html>
  `);

  await page.screenshot({
    path: `test-results/${testId}-${safeName}-PASS.png`,
    fullPage: true,
  });
}