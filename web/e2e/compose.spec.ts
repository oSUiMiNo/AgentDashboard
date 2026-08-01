import { expect, test } from '@playwright/test'
import {
  killAgent,
  startAgent,
  startService,
  stopService,
} from './compose-control'
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

test('スラッシュコマンドも跨いで届く', async ({ page }) => {
  // `/rewind` のようなスラッシュコマンドは、指示送信と同じ経路（PTY への書き込み）を
  // 通る。**CLI が受け取れる形で届いているか**は、跨いでも変わらないことを見る
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await typeLine(page, '/rewind')
  await expectTerminalToContain(page, '[fake-claude] received: /rewind')
})

test('ブラウザ側のインスタンスを落としてもセッションは無傷', async ({ page }) => {
  // 検収「片方を落としても継続」。PTY を持っているのは PC 側なので、**サーバが
  // 何台落ちてもセッションは死なない**（設計§9-6）。落ちた側が戻ったら、真実である
  // DB から読み直して追いつく
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')
  expect(cardId).toBeTruthy()

  stopService('dashboard-a')
  // PC が繋がっている側（B）では何も起きていない
  await page.goto(OTHER_INSTANCE)
  await signInIfAsked(page)
  await expect(page.locator(`[data-card-id="${cardId}"]`)).toBeVisible()

  startService('dashboard-a')
  await page.goto('/')
  await openDashboard(page)
  await expect(page.locator(`[data-card-id="${cardId}"]`)).toBeVisible()
})

test('PC が落ちると印が付き、起こし直すとまた使える', async ({ page }) => {
  // 設計§12 マトリクスの1行目を**実配線で**確かめる。切断は「最後に知っていた状態」を
  // 上書きするのではなく、その鮮度として出る（`status` は動かない）。
  //
  // **落ちる前のカードは戻らない。** PTY はエージェントの子プロセスなので道連れで
  // 死んでおり、起こし直しても引き取る先が無い（設計§1-3 の既知の制約）。印が
  // 付いたままなのが正しい見え方で、消えたらむしろ嘘になる。
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')
  const card = page.locator(`[data-card-id="${cardId}"]`)

  killAgent()
  await expect(card.getByTestId('disconnected-badge')).toBeVisible({
    timeout: 60_000,
  })

  // 起こし直すと、その PC でまたセッションを起こせる（＝繋がり直している）。
  // 見ているのは A で、繋がっているのは B のままなので、**跨ぎの経路ごと**戻る
  startAgent()
  // **繋がるのを待ってから起こす。** 待たずに押すと「繋がっている PC がありません」で
  // 断られる。ここで見ているのは在席の印（設計§9-4）で、A は自分の接続表ではなく
  // 連絡係に置かれた印から B の PC を数えている
  await expect(async () => {
    const response = await page.request.get('/api/settings')
    const view = (await response.json()) as { agents: { connected: boolean }[] }
    expect(view.agents.some((agent) => agent.connected)).toBe(true)
  }).toPass({ timeout: 60_000 })
  const revived = await spawnSession(page)
  // 古いカードの印はそのまま（PTY が道連れで死んでいる事実は変わらない）。
  // **一覧を出している間に見る**——専用画面へ移ると小窓そのものが描かれない
  await expect(card.getByTestId('disconnected-badge')).toBeVisible()

  await openSession(page, revived)
})

test('DB が落ちている間の報告は、戻ってから追いつく', async ({ page }) => {
  // 設計§12 の DB 断の行。**ack を返さない**ことでエージェントが未 ack を保持し、
  // 復旧後に送り直す（§6-1 がそのまま復旧手順になる）。フェーズ3 では注入で
  // 確かめたので、ここは実配線版にあたる
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  stopService('postgres')
  // 端末は無傷（PTY は PC 側にあり、DB を1バイトも通らない）
  await typeLine(page, 'DBが落ちている間')
  await expectTerminalToContain(page, '[fake-claude] received: DBが落ちている間')

  startService('postgres')
  // 戻ったら記録は無事で、カードもそのまま。
  //
  // **ログインはやり直しになる。** 入館証の置き場所も DB なので、読めない間に
  // 触られた入館証は失われる（設計§8-2 が web_sessions を DB に置いている以上、
  // 避けようが無い）。設計§12 の「既読み込みの表示は維持」は開いたままの画面の話で、
  // 読み込み直すと入口から通ることになる——`openDashboard` が入り直しまで面倒を見る
  await expect(async () => {
    await page.goto('/')
    await openDashboard(page)
  }).toPass({ timeout: 60_000 })
  await expect(page.getByTestId('session-tile')).toHaveCount(1)
})
