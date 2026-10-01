import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // Jeder Test startet eine eigene Electron-Instanz mit frischem Datenordner; die Anwendung (OCR, Worker) ist schwer, deshalb nacheinander.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Ohne Wiederholungen: sie verdecken instabile Tests. Der Start der Binärdatei wird in tests/e2e/fixture.ts gezielt wiederholt.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
});
