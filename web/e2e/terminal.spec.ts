import { expect, test } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
} from './helpers'

/**
 * ターミナルビューの通し確認（フェーズ1で作った経路の維持）。
 *
 * ビルドした core サーバ本体に繋ぎ、擬似 claude を相手に
 * 「起動 → 画面に出力が出る → キー入力が届く → 大量出力でフロー制御が働く → 終了」
 * までをブラウザから行う。設計§4/§10 が定める経路が実際に通っていることの検証にあたる。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('セッションを起動してブラウザのターミナルから操作できる', async ({
  page,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // キー入力が PTY まで届き、応答が戻ってくる
  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')

  // ダッシュボードから終了させたものは「異常終了」ではなく「終了」と出る
  await page.getByRole('button', { name: '終了' }).click()
  await expect(page.getByTestId('session-view')).toHaveAttribute(
    'data-status',
    'ended',
  )
  await expect(page.getByText('終了', { exact: true }).first()).toBeVisible()
})

test('大量出力でフロー制御が働き、最後まで取りこぼさず届く', async ({
  page,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // E2E 用の設定はしきい値を小さくしてある（web/e2e/config.toml）ので、
  // 数MBでウォーターマークに到達する
  const floodBytes = 8 * 1024 * 1024
  await typeLine(page, `flood ${floodBytes}`)

  // 出力の途中で少なくとも1回は停止を要求していること
  await expect
    .poll(
      async () =>
        Number(
          await page
            .getByTestId('terminal-status')
            .getAttribute('data-pause-count'),
        ),
      { message: 'フロー制御が発火すること', timeout: 60_000 },
    )
    .toBeGreaterThan(0)

  // 止めても捨てていないので、最後まで届く
  await expectTerminalToContain(page, '[fake-claude] flood-end')

  const status = page.getByTestId('terminal-status')
  // 落ち着いたら再開している（止まりっぱなしにならない）
  await expect(status).toHaveAttribute('data-flow', 'running')

  // 受け取った量が要求量を下回っていない＝取りこぼしていない
  const totalBytes = Number(await status.getAttribute('data-total-bytes'))
  expect(totalBytes).toBeGreaterThanOrEqual(floodBytes)
})

test('存在しない作業ディレクトリを指定すると理由が表示される', async ({
  page,
}) => {
  await openDashboard(page)

  await page.getByTestId('cwd-input').fill('/存在しないはずのディレクトリ')
  await page.locator('[data-testid="spawn-button"][data-mode=""]').click()

  await expect(page.getByTestId('error-banner')).toContainText(
    '作業ディレクトリが存在しません',
  )
  await expect(page.getByTestId('session-tile')).toHaveCount(0)
})
