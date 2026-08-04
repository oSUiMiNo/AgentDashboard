import { expect, test } from '@playwright/test'
import { openDashboard } from './helpers'

/**
 * 設定画面（セルフホスト化設計§11-2・§13-3、テスト計画フェーズ5）。
 *
 * # 「保存され、開き直しても残る」を画面から確かめる
 *
 * 検収条件の「〜設定でき、アプリ再起動後も保持される」は、置き場所が DB になった
 * ことで満たされる（設計§13-1）。**サーバを落として起こし直しても残る**ことは
 * `crates/core/tests/restart.rs` が同じ DB を指す2つの起動で見ている。ここでは
 * その手前——画面から変えた値がサーバへ渡り、開き直しても戻らないこと——を見る。
 *
 * # LAN パスワードは触らない
 *
 * 登録すると**この E2E サーバが以後パスワードを要求するようになる**（127.0.0.1 は
 * 免除なので実害は無いが、状態を残す操作は他のテストへ漏れる）。欄が出ていることまでを
 * 確かめ、登録そのものは Rust 側（`crates/core/tests/auth.rs`）が受け持つ。
 */

test('履歴の同期間隔を変えると、開き直しても残る', async ({ page }) => {
  await openDashboard(page)
  await page.getByTestId('settings-link').click()

  const select = page.getByTestId('sync-interval-select')
  await expect(select).toHaveValue('20')

  await select.selectOption('5')
  // 保存はサーバ往復。**応答が返るまで待たずに開き直すと、何を確かめたのか
  // 分からなくなる**ので、値が確定するのを待つ
  await expect(select).toHaveValue('5')

  await page.reload()
  await expect(page.getByTestId('sync-interval-select')).toHaveValue('5')

  // 後片付け。**設定は次のテストへ残る**（E2E は1つのサーバを共有している）
  await page.getByTestId('sync-interval-select').selectOption('20')
  await expect(page.getByTestId('sync-interval-select')).toHaveValue('20')
})

test('ローカルでは LAN パスワードの欄が出て、画面の間隔は出ない', async ({
  page,
}) => {
  // **意味を持たない項目は出さない**（設計§7-2：ローカルには画面配信そのものが無い）。
  // 変えられないものを並べると「設定したのに効かない」になる
  await openDashboard(page)
  await page.getByTestId('settings-link').click()

  await expect(page.getByTestId('lan-password')).toBeVisible()
  await expect(page.getByTestId('lan-password-input')).toBeVisible()
  await expect(page.getByTestId('screen-interval-select')).toHaveCount(0)
  await expect(page.getByTestId('scrollback-lines-input')).toHaveCount(0)
})

test('版を切り替えられない構成では、押せる顔をせず案内だけ出す', async ({
  page,
}) => {
  // **できないことをボタンにしない**（CICD設計§14）。この土台は版の機能を
  // 塞いであるので、ここでは「出ないこと」だけを確かめる——出る側は
  // `chromium-versions` の土台で見る
  await openDashboard(page)
  await page.getByTestId('settings-link').click()

  await expect(page.getByTestId('versions')).toHaveAttribute(
    'data-supported',
    'false',
  )
  await expect(page.getByTestId('versions-picker')).toHaveCount(0)
  await expect(page.getByTestId('versions-restart')).toHaveCount(0)
})
