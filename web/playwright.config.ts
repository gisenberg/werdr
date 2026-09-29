import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test', testMatch: '*.spec.ts', workers: 1, fullyParallel: false,
  timeout: 45000, expect: { timeout: 15000 },
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
});
