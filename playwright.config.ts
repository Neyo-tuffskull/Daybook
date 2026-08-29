import { defineConfig, devices } from '@playwright/test';

/**
 * Both apps run behind one origin in development, so the E2E suite can drive a
 * cross-app journey (finish a workout in Fitness, watch the Daybook timeline
 * update) in a single browser context with one session cookie. That journey is
 * the Phase 9 exit criterion.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The workout logger is used one-handed in a gym. It gets tested that way.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:3000/plan',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
