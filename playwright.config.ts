/**
 * Playwright 端對端測試 (E2E) 設定檔
 * 職責：配置瀏覽器自動化測試環境、測試路徑及自動啟動開發伺服器。
 */
import { defineConfig, devices } from '@playwright/test';

const webServerEnv = {
    ...process.env,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
} as unknown as NodeJS.ProcessEnv;

export default defineConfig({
    testDir: './tests',
    testMatch: /(.+\.)?(spec)\.[jt]s/,
    globalTeardown: './tests/global-teardown.ts',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    use: {
        baseURL: 'http://localhost:5173',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'npm run dev',
        env: webServerEnv,
        port: 5173,
        reuseExistingServer: true,
    },
});
