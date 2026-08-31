import fs from 'node:fs'
import path from 'node:path'
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

test('セッション画面と PJT 画面を行き来できる', async ({ page }) => {
  await openDashboard(page)
  // 同じ作業ディレクトリで2本＝1つの枠に2区画。**隣へ飛ばないこと**を見るのに要る
  await spawnSession(page)
  await spawnSession(page)

  const tiles = page.getByTestId('session-tile')
  await expect(tiles).toHaveCount(2)

  // 一覧 → セッション専用画面
  await tiles.first().click()
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)

  // セッション専用画面 → PJT 専用画面。**パスそのものが行き先**（器を足していない）
  await page.getByTestId('to-project').click()
  await expect(page).toHaveURL(`/p/local/${encodeURIComponent(WORK_DIR)}`)

  // PJT 専用画面 → セッション専用画面。**押した区画のセッションへ行くこと**。
  // 先頭に固定する実装でも通ってしまわないよう、**最後の区画**の id を先に読む
  const views = page.getByTestId('session-view')
  await expect(views).toHaveCount(2)
  const wanted = await views.last().getAttribute('data-card-id')
  expect(wanted).not.toBeNull()
  await views.last().getByTestId('to-session').click()
  await expect(page).toHaveURL(`/s/${wanted}`)

  // 一周して戻った先は単独画面。**行き先が自分自身になる導線は出さない**
  await expect(page.getByTestId('to-session')).toHaveCount(0)
  await expect(page.getByTestId('to-project')).toHaveCount(1)
})

test('狭い窓でも、リンクにしたパスが自分で行を増やさない', async ({ page }) => {
  // **材料に長いパスを使う。** `WORK_DIR`（`os.tmpdir()`）は短すぎて、
  // `min-w-0 truncate` を外しても切り詰めが要らない——それでは壊し方で落ちない。
  //
  // **測る相手はパスの要素そのもの**で、帯の高さではない。帯は狭い窓では
  // もともと折り返しており、長いパスだと flex がそれを独立した行へ送るので
  // 高さが変わる——**これは本イシューの変更前からそうだった**（実測 132px→188px）。
  // 帯の高さで測ると、直していないものを直したことにしてしまう。
  const deep = path.join(
    WORK_DIR,
    'agentdashboard-e2e-行き来',
    'とても長い名前のディレクトリ',
    '入れ子の奥のほう',
    '作業場所',
  )
  fs.mkdirSync(deep, { recursive: true })

  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)

  // 短いパスのときの高さを先に測る（比べる相手）
  const shortTile = await spawnSession(page)
  await shortTile.click()
  const shortLink = await page.getByTestId('to-project').boundingBox()
  expect(shortLink).not.toBeNull()

  await page.goto('/')
  const deepTile = await spawnSession(page, deep)
  await deepTile.click()
  const deepLink = page.getByTestId('to-project')
  const deepBox = await deepLink.boundingBox()
  expect(deepBox).not.toBeNull()

  // **パスは1行のまま。** `truncate`（`white-space: nowrap`）を外すと折り返して背が伸びる
  expect(deepBox!.height).toBeCloseTo(shortLink!.height, 0)

  // **押し広げるのではなく、切り詰められている。** `min-w-0` を外すと縮めなくなり、
  // 中身の幅がそのまま出る＝切り詰めが起きない。
  //
  // **測る相手はリンクではなく、その中の前半**（帯の設計§3）。パスを「前半」と
  // 「末尾2階層」の2つに割ったので、リンク自身は入れ物になり、溢れるのは前半だけに
  // なった——末尾を切ると**違いが出るところがちょうど消える**ため、末尾は必ず残す。
  // 前半から `min-w-0` を外すと、縮めなくなって溢れがリンク側へ出る＝ここが false になる
  const head = deepLink.getByTestId('to-project-head')
  const clipped = await head.evaluate((el) => el.scrollWidth > el.clientWidth)
  expect(clipped).toBe(true)

  // **末尾は切り詰められていない。** ここが切れると、`…/accept/proj` と
  // `…/accept/proj2` が同じ見た目になる（このイシューが直した症状そのもの）
  await expect(deepLink).toContainText('作業場所')
})

test('帯の高さは、最終活動の表記が変わっても変わらない', async ({ page }) => {
  /*
    **このイシューの3件目そのもの。** 最終活動は「放っておくだけで文字数が変わる」
    唯一の要素で、1秒ごとに数え直される。以前は帯を折り返しに任せていたので、
    `たった今`（4字）と `5秒前`（3字）の差で **1行 ⇄ 2行** を行き来し、そのたびに
    **下の作業用ビューごと上下に動いていた**（利用者の言葉で「使いにくい」）。

    **jsdom では測れない。** レイアウトを持たないので高さが常に固定値で返る。
    単体（`SessionView.test.tsx`）で見ているのは「行の数と所属が変わらないこと」＝
    構造までで、**高さが動かないことは実物のブラウザでしか確かめられない**。

    **材料に長いパスを使う。** 短いパスでは元から1行に収まっていて、
    **直す前のコードでも通ってしまう**（`狭い窓でも、リンクにしたパスが自分で行を
    増やさない` と同じ理由）。
  */
  const deep = path.join(
    WORK_DIR,
    'agentdashboard-e2e-帯の高さ',
    'とても長い名前のディレクトリ',
    '入れ子の奥のほう',
    '作業場所',
  )
  fs.mkdirSync(deep, { recursive: true })

  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  const tile = await spawnSession(page, deep)
  await tile.click()

  const view = page.getByTestId('session-view')
  const 帯 = view.locator('header')
  const 最終活動 = view.getByTestId('elapsed')

  // 起こした直後は「たった今」。ここで測る
  await expect(最終活動).toContainText('たった今')
  const 前 = await 帯.boundingBox()
  expect(前).not.toBeNull()

  // **固定の待ち時間ではなく、表記が変わることを条件に待つ**（5秒で `〜秒前` へ変わる）
  await expect(最終活動).toContainText('秒前', { timeout: 20_000 })
  const 後 = await 帯.boundingBox()
  expect(後).not.toBeNull()

  // **高さが1ピクセルも動かないこと。** 動くと下の本文がそのぶん上下する
  expect(後!.height).toBeCloseTo(前!.height, 0)

  // ページが横へはみ出していないこと（折り返しをやめた代償はここに出る）
  const はみ出す = await page.evaluate(() => {
    const de = document.documentElement
    return de.scrollWidth > de.clientWidth
  })
  expect(はみ出す).toBe(false)

  /*
    **高さの一定性だけでは、折り返しへ戻す壊し方を捕まえられない**（実測）。
    折り返す作りでも、その幅でたまたま両方の表記が同じ行数に収まれば高さは動かない。
    元の不具合は「**ある幅でだけ** 1行⇄2行 を行き来する」形なので、幅を1つ選んで
    測るやり方では当たり外れが出る。

    そこで**行が箱として積まれていること**を見る。折り返しへ戻すと行の器は
    透明になり（あるいは中身が複数行へ散り）、この主張が落ちる。
  */
  const 行たち = await view.locator('header [data-row]').all()
  expect(行たち).toHaveLength(3)
  let 前の下端 = -1
  for (const 行 of 行たち) {
    const box = await 行.boundingBox()
    expect(box, '行が箱を持っていること（折り返しへ戻すと消える）').not.toBeNull()
    expect(box!.height).toBeGreaterThan(0)
    // **上から順に積まれている**（同じ帯の中で横に並んでいない）
    expect(box!.y).toBeGreaterThanOrEqual(前の下端)
    前の下端 = box!.y + box!.height
  }
})
