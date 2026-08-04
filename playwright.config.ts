import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright 配置
 *
 * 策略：
 * - 仅启用 chromium（复用 ~/Library/Caches/ms-playwright/chromium-1208 缓存）
 * - webServer 自动拉起 vite dev，测试结束自动关闭
 * - 复用已运行的开发服务器，方便本地边改边测
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    console: false, // 不劫持 console，由测试用例自行收集
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
