import { expect, test } from '@playwright/test'
import {
  archiveAll,
  fireHook,
  openDashboard,
  openSession,
  spawnSession,
  WORK_DIR,
} from './helpers'

/**
 * 一覧画面（司令塔ビュー）の通し確認
 * （テスト計画フェーズ5「小窓」「クリック挙動」の実ブラウザ側）。
 *
 * 状態は擬似 claude に**注入された settings のフックを本当に起動させて**動かす。
 * つまり「settings の生成 → CLI がフックを起動 → `hook-post` が転送 → 受信口 →
 * 状態機械 → WebSocket の差分 → 画面」までが1本の線として検証される。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('フックの受信にあわせて小窓の状態が変わる', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)

  // フックがまだ1件も来ていないので「起動中」
  await expect(tile).toHaveAttribute('data-status', 'starting')

  await openSession(page, tile)
  const view = page.getByTestId('session-view')

  await fireHook(page, 'SessionStart')
  await expect(view).toHaveAttribute('data-status', 'waiting_input')

  await fireHook(page, 'UserPromptSubmit')
  await expect(view).toHaveAttribute('data-status', 'working')

  // 権限確認は型フィールドで判定する（メッセージ文字列の解析は不要）
  await fireHook(
    page,
    'Notification',
    '{"notification_type":"permission_prompt"}',
  )
  await expect(view).toHaveAttribute('data-status', 'waiting_permission')

  // ターミナルで直接許可した場合、次のツール実行で自然に復帰する
  await fireHook(page, 'PreToolUse')
  await expect(view).toHaveAttribute('data-status', 'working')

  await fireHook(page, 'Stop', '{"last_assistant_message":"テストが通りました"}')
  await expect(view).toHaveAttribute('data-status', 'waiting_input')

  // 一覧へ戻ると、状態と名前が小窓にも出ている。
  //
  // **直前の応答は、ここでは出ない。** 常時表示をやめ、`last_assistant_message` が
  // **変わった瞬間に載っているカードへ12秒だけ**出す形にした（カード設計§11-2）。
  // `page.goto('/')` はカードを作り直すので初回マウント扱いになり、**原理的に出ない**。
  // 出るところは `tile.spec.ts` が2ページを使って見ている。
  await page.goto('/')
  const back = page.getByTestId('session-tile').first()
  await expect(back).toHaveAttribute('data-status', 'waiting_input')
  await expect(back.getByTestId('session-title')).toHaveAttribute(
    'data-named',
    'false',
  )
  await expect(back.getByTestId('session-echo')).toHaveCount(0)
  await expect(back.getByTestId('elapsed')).toContainText('最終活動')
})

test('サブエージェントの稼働中はバッジが出る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await fireHook(page, 'SubagentStart')
  await page.goto('/')
  await expect(
    page.getByTestId('session-tile').first().getByTestId('subagent-badge'),
  ).toHaveText('サブエージェント 1')

  // 開き直したときは端末が作り直されるので、描画が終わるまで待ってから打ち込む
  await openSession(page, page.getByTestId('session-tile').first())
  await fireHook(page, 'SubagentStop')
  await page.goto('/')
  await expect(
    page.getByTestId('session-tile').first().getByTestId('subagent-badge'),
  ).toHaveCount(0)
})

test('小窓とグループ余白でクリックの意味が変わる', async ({ page }) => {
  await openDashboard(page)
  // 同じ作業ディレクトリで2本走らせる＝1つのグループにまとまる
  const first = await spawnSession(page)
  await spawnSession(page)

  const group = page.getByTestId('project-group')
  await expect(group).toHaveCount(1)
  await expect(page.getByTestId('session-tile')).toHaveCount(2)

  // 小窓をクリック → そのセッション1つだけ
  await first.click()
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('session-view')).toHaveCount(1)

  // グループの余白をクリック → 全セッションが横並びで開く
  await page.goto('/')
  await page.getByTestId('project-group').click({ position: { x: 5, y: 5 } })
  // 鍵に PC が入る（設計§16）。ローカルは `local`
  await expect(page).toHaveURL(`/p/local/${encodeURIComponent(WORK_DIR)}`)
  await expect(page.getByTestId('group-view')).toBeVisible()

  // 「一覧」ではなく専用画面そのものが2枚並ぶ（見比べられる状態になっている）
  const views = page.getByTestId('session-view')
  await expect(views).toHaveCount(2)
  await expect(views.first()).toBeVisible()
  await expect(views.last()).toBeVisible()

  // 縦積みではなく横並びであること。左端の位置が違い、上端が揃っている
  const left = await views.first().boundingBox()
  const right = await views.last().boundingBox()
  expect(left).not.toBeNull()
  expect(right).not.toBeNull()
  expect(right!.x).toBeGreaterThan(left!.x)
  expect(Math.abs(right!.y - left!.y)).toBeLessThan(4)

  // 溢れたぶんは横スクロールで届く（表示数の上限は設けていない）
  await expect(page.getByTestId('group-rail')).toHaveCSS('overflow-x', 'auto')
})

test('リロードしても一覧はサーバの状態から作り直される', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  await fireHook(page, 'UserPromptSubmit')

  // 真実は常にサーバ側にある。ブラウザを作り直しても同じ状態が出る
  await page.goto('/')
  await page.reload()
  await expect(page.getByTestId('session-tile').first()).toHaveAttribute(
    'data-status',
    'working',
  )
})
