import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173';
const API_PORT = Number(new URL(API_URL).port);

export default defineConfig({
  testDir: './src',
  globalSetup: './src/globalSetup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [['github'], ['line']] : [['line']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Boot (or reuse) the real Fastify API and the Vite web app. The browser
  // talks to the SPA; /api is proxied by Vite to the API, which talks to the
  // real Postgres/Redis from infra/. If the developer already has these up,
  // reuseExistingServer avoids a second instance.
  webServer: [
    {
      command: 'npm run start -w @flash-sale/server',
      cwd: REPO_ROOT,
      url: `${API_URL}/healthz`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        ...process.env,
        ...(API_PORT ? { PORT: String(API_PORT) } : {}),
      },
    },
    {
      command: 'npm run dev -w @flash-sale/web',
      cwd: REPO_ROOT,
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        ...process.env,
        API_PROXY_TARGET: API_URL,
      },
    },
  ],
});