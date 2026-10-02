import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // Each test starts its own Electron instance with a fresh data folder; the application (OCR, workers) is heavy, hence sequential.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retries: they hide flaky tests. Launching the binary is retried specifically in tests/e2e/fixture.ts.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
});
