import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: 'electron.e2e.ts',
  fullyParallel: false,
  workers: 1,
  // Real Electron, real network: absorb one environmental hiccup on CI, stay strict locally.
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'line',
});
