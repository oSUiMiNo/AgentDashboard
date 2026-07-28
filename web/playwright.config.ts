import { defineConfig, devices } from '@playwright/test'

// E2E は chromium のみ。個人用ローカルツールなのでクロスブラウザ検証は要件に無く、
// ブラウザバイナリのダウンロード量を抑える判断（テスト計画フェーズ1）。
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // 実際にビルドした成果物を配信して確認する（dev サーバではなく preview を使う）
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
