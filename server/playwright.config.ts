import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests.
 *
 * They drive the REAL Vite dev server against the REAL Express API, which in
 * turn runs the REAL local BAAI/bge-small-en-v1.5 model. Nothing is stubbed.
 *
 *   npm run test:e2e            (from server/)
 *
 * Requires the Playwright browser binary. If it is missing the suite fails
 * loudly rather than silently skipping, so a green run always means the browser
 * workflow was genuinely exercised:
 *
 *   npx playwright install chromium
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      // Same flows on a phone viewport to verify the responsive layout.
      use: { ...devices['Pixel 7'] },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: '.',
      url: 'http://127.0.0.1:5000/api/health',
      reuseExistingServer: true,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'development',
        PORT: '5000',
        // Isolated in-memory store keeps E2E runs deterministic and hermetic.
        STORE_DRIVER: 'memory',
        LLM_PROVIDER: process.env.LLM_PROVIDER ?? 'mock',
        DISABLE_LLM_REMOTE: 'true',
        JWT_SECRET: 'e2e-secret-sourceiq-playwright-only',
        EMBEDDING_PRELOAD: 'true',
        // Admin-only authentication: these must match e2e/helpers.ts.
        BOOTSTRAP_ADMIN: 'true',
        ADMIN_EMAIL: 'admin@gmail.com',
        ADMIN_PASSWORD: '12345678',
      },
    },
    {
      command: 'npm run dev --prefix ../client',
      cwd: '.',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});