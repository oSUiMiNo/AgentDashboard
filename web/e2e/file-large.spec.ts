import { expect, test } from '@playwright/test'
import { openDashboard } from './helpers'

/**
 * 大きいファイル（ファイル閲覧の上限を設定から変え、大きいものは流し読みする）の E2E。
 *
 * フェーズ6 は設定のカードの部分。フェーズ7 でファイルビュアの部分（窓で読む面・断り文の
 * 導線・5 MB の HTML）を足す。
 *
 * # 変えた上限は必ず既定へ戻す
 *
 * **上限はサーバ全体の1つの値で、E2E は1つのサーバを spec の順に共有する。** 途中で落ちて
 * 1 MB が残ると、後の spec（`file-viewer.spec.ts` など）が「大きすぎます」で巻き込まれる。
 */

const MIB = 1024 * 1024
const GIB = 1024 * MIB

test.describe('設定：ファイル閲覧の上限', () => {
  test.afterEach(async ({ page }) => {
    const 戻した = await page.request.put('/api/settings', {
      data: { file_view_max_bytes: 'default' },
    })
    expect(戻した.ok()).toBe(true)
  })

  test('16個が選べて、読み直しても残る・ローカルでは警告が出ない', async ({ page }) => {
    await openDashboard(page)
    await page.getByTestId('settings-link').click()

    const select = page.getByTestId('file-view-limit-select')
    await expect(select).toHaveValue(String(5 * GIB))
    const 既定 = select.locator('option', { hasText: '・既定' })
    await expect(既定).toHaveCount(1)
    await expect(既定).toHaveText('5 GB（5,368,709,120 バイト）・既定')

    const values = await select
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    expect(values).toHaveLength(16)

    for (const value of values) {
      const 保存 = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/settings') &&
          response.request().method() === 'PUT',
      )
      await select.selectOption(value)
      expect((await 保存).status()).toBe(200)
      await expect(select).toHaveValue(value)
      // **ローカルなので警告が一度も出ない**（サーバを介さず、クラウドでもない）
      await expect(page.getByTestId('file-view-limit-confirm')).toHaveCount(0)
    }

    // 読み直しは最初・途中・最後の3回。値の保存は DB の試験（`server-core/tests/db.rs`）と
    // 設定の口の試験（`core/tests/settings_io.rs`）が16個全部を通している（テスト計画 3-3）
    for (const value of [String(MIB), String(50 * MIB), String(20 * GIB)]) {
      const 保存 = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/settings') &&
          response.request().method() === 'PUT',
      )
      await select.selectOption(value)
      expect((await 保存).status()).toBe(200)
      await page.reload()
      await expect(page.getByTestId('file-view-limit-select')).toHaveValue(value)
    }
  })

  test('ハッシュで開くと、上限のカードが見える位置へ送られる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    await openDashboard(page)

    // **対照**：低い窓ではカードが下に隠れていることを先に確かめる。これが崩れたら
    // 下の確かめは空振りになるので、ここで理由つきで落ちる
    await page.goto('/settings')
    await expect(page.getByTestId('file-view-limit')).toBeAttached()
    await expect(
      page.getByTestId('file-view-limit'),
      '低い窓ではカードが最初から見えていないこと（見えていると送る確かめが空振りになる）',
    ).not.toBeInViewport()

    await page.goto('/settings#file-view-limit')
    await expect(page.getByTestId('file-view-limit')).toBeInViewport()
  })
})
