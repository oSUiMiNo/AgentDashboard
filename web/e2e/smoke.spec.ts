import { expect, test } from '@playwright/test'

// E2E 基盤のスモークテスト。playwright.config.ts の webServer が `npm run build` と
// `npm run preview` を実行するため、これが通ることは「ビルド成果物が実際にブラウザで
// 動く」ことの確認も兼ねている。
test('ビルドした画面がブラウザで表示される', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('AgentDashboard')
  await expect(page.getByRole('heading', { name: 'AgentDashboard' })).toBeVisible()
  await expect(page.getByRole('button', { name: '準備OK' })).toBeVisible()
})
