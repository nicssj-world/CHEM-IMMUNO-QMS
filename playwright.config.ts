import { defineConfig } from '@playwright/test';

const existingBaseUrl = process.env.CI_E2E_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: existingBaseUrl ?? 'http://localhost:3100', browserName: 'chromium', channel: 'chrome', headless: true },
  webServer: existingBaseUrl ? undefined : { command: 'npm run dev -- --port 3100', url: 'http://localhost:3100/login', reuseExistingServer: false, timeout: 120_000 },
  reporter: 'list',
  workers: 1,
});
