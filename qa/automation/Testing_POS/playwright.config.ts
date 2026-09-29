import { defineConfig, devices, webkit } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './test_playwright_version',

  fullyParallel: false,

  forbidOnly: !!process.env.CI,

  retries: process.env.CI ? 2 : 0,

  workers: 1,

  // Mỗi test tối đa 10 giây
  timeout: 10_000,

  reporter: [
    ['list'],
    ['html', {
      outputFolder: 'playwright-report',
      open: 'never',
    }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'http://160.191.47.17',

    trace: 'on-first-retry',

    screenshot: 'only-on-failure',

    video: 'on',

    viewport: {
      width: 1440,
      height: 900,
    },
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },

    { 
      name: 'webkit',
      use: {
        ...devices['Galaxy S9+'],
      },
    }
  ],
});