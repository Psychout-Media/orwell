import { defineConfig } from '@playwright/test';

// The smoke test runs against a live stack (engine + front end + deterministic fake model); see
// scripts/run-smoke.sh. PLAY_BASE_URL / PLAY_USER / PLAY_PASSWORD point it at that stack.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAY_BASE_URL ?? 'http://127.0.0.1:7000',
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
    screenshot: 'only-on-failure',
  },
});
