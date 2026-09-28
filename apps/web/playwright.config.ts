import { defineConfig } from '@playwright/test';

// The e2e server (scripts/e2e-server.mjs) copies .wrangler/state/v3 to a fresh temp
// directory and starts the app against that copy on its own port, so a run never
// shares the dev server on :7741 or writes to apps/web/.wrangler/state.
const port = Number(process.env.POKEDEX_E2E_PORT ?? 7751);
// "localhost", not "127.0.0.1": WebAuthn refuses an IP address as the relying-party
// id, so the invite registration ceremony only works when the app is reached by name.
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  // One shared disposable database copy for the whole run (not one per test), so
  // tests that mutate collection/binder state run serially to avoid racing each
  // other; each test picks its own fixtures dynamically to stay independent.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { POKEDEX_E2E_PORT: String(port) },
  },
  // Both projects are Chromium — "phone" is a viewport + touch profile, not a real
  // device emulation, so the invite flow's CDP virtual WebAuthn authenticator (only
  // supported by Chromium) works in either project.
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});
