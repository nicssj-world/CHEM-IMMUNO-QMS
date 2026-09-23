import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:3100', browserName: 'chromium', channel: 'chrome', headless: true },
  webServer: { command: 'npm run dev -- --port 3100', url: 'http://localhost:3100/login', reuseExistingServer: false, timeout: 120_000 },
  reporter: 'list',
  workers: 1,
});
