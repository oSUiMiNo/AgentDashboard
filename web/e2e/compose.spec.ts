import { expect, test } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  signInIfAsked,
  spawnSession,
  typeLine,
} from './helpers'

/** もう一方のインスタンス（PC が繋がっている側）。 */
const OTHER_INSTANCE = 'http://127.0.0.1:4176/'

/**
 * インスタンスを2台並べた通し確認（セルフホスト化設計§9・§15-2 #4）。
 *
 * # 1台構成との違いはただ1つ
 *
 * **ブラウザが繋がった側に PC が居ない。**
 *
 * ```text
 * ブラウザ ──▶ dashboard-a          dashboard-b ◀── エージェント（擬似 claude）
 *                  └──── Valkey ────────┘
 *                  └──── PostgreSQL ────┘
 * ```
 *
 * 一覧も履歴も PostgreSQL から読むので、どちらへ繋いでも同じものが見える。動くもの
 * （起動・指示・画面）は、A が Valkey 越しに B へ頼んで初めて成立する。フェーズ6 で
 * 足した配線が全部**この配置でしか通らない**——1台構成では A と B が同じプロセスなので、
 * 頼まなくても届いてしまう。
 *
 * 立ち上げは `scripts/e2e-compose`（`make e2e-compose`）が面倒を見る。ここでは
 * 既に立っている前提で、ブラウザから見えるものだけを確かめる。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('別のインスタンスに繋がった PC でセッションを起こして操作できる', async ({
  page,
}) => {
  await openDashboard(page)

  // 起動の指示は A → Valkey → B → PC と渡る。**A の接続表には PC が1台も居ない**
  const tile = await spawnSession(page)

  // 画面はエージェント内の端末エミュレータが作り、B → Valkey → A と渡って届く
  await openSession(page, tile)

  // キー入力は逆向きに渡る（跨ぐときだけ base64 で包まれる。設計§9-2）
  await typeLine(page, 'インスタンスをまたいで')
  await expectTerminalToContain(
    page,
    '[fake-claude] received: インスタンスをまたいで',
  )
})

test('もう一方のインスタンスへ繋いでも同じものが見える', async ({ page }) => {
  // 検収「どこへ接続しても同じ結果」。真実は DB にあるので、**どちらのインスタンスに
  // 繋いでも一覧は一致する**（連絡係は揮発の知らせを配るだけで、一覧の出どころではない）
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')
  expect(cardId).toBeTruthy()

  // PC が繋がっている側（B）へ回り込んで、同じカードが出ることを見る。
  // **`openDashboard` は使えない**——あれは baseURL（A）を開くので、回り込みが
  // 打ち消される
  await page.goto(OTHER_INSTANCE)
  await signInIfAsked(page)
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  )
  await expect(page.locator(`[data-card-id="${cardId}"]`)).toBeVisible()

  // 片付けは A 側で行う（afterEach が baseURL を見る）
  await page.goto('/')
})
