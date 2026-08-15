import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  use: {
    baseURL: process.env.WMS_PLAYWRIGHT_BASE_URL
      ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
