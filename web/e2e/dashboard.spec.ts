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
  // 画面からは語を落とし、説明にだけ残した（細かい修正 要件22）
  await expect(back.getByTestId('elapsed')).not.toContainText('最終活動')
  await expect(back.getByTestId('elapsed')).toHaveAttribute('title', /最終活動/)
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

test('カードの操作は、マウスを乗せたときに3つ出る', async ({ page }) => {
  /*
    **「復旧」の板は電源ボタンへ置き換わり、ゴミ箱と編集が並んだ**（細かい修正 要件11・12）。

    **並びは取り返しの付く順**（編集 → ゴミ箱 → 電源）。逆にすると、押し間違えたときに
    いちばん痛いものが指の近くに来る。

    走っているカードでは**点灯した電源＝スリープ**が同じ位置に出る——止めることと
    起こすことを1つのボタンで言えるようにした（設計§4-1）。
  */
  await openDashboard(page)
  const tile = await spawnSession(page)

  const 群 = tile.getByTestId('tile-ops')
  await tile.hover()
  await expect(群).toBeVisible()

  // 3つまで（`DESIGN.md` §15.3）。4つ目を足さない
  await expect(群.locator('[data-testid]')).toHaveCount(3)

  // 走っているので、電源は点いていて「スリープ」を名乗る
  const 電源 = tile.getByTestId('power-tile')
  await expect(電源).toHaveAttribute('data-power', 'on')
  await expect(電源).toHaveAttribute('aria-label', 'スリープ')

  // 板を作っていない（塗るのは電源だけ・`DESIGN.md` §12.3・§15.1）
  for (const id of ['nickname-edit', 'archive-card']) {
    await expect(tile.getByTestId(id)).not.toHaveClass(/shadow-\[/)
  }
})

test('「全て復旧」は無くなり、まとめて起こすのは帯の電源だけになった', async ({
  page,
}) => {
  // **取り返しの付かない範囲を、押す人が決められる**（細かい修正 要件13・設計§4-2）
  await openDashboard(page)
  const tile = await spawnSession(page)

  await expect(page.getByTestId('revive-all')).toHaveCount(0)
  await expect(page.getByTestId('revive-all-row')).toHaveCount(0)

  // 選ぶまで帯そのものが出ない
  await expect(page.getByTestId('bulk-revive')).toHaveCount(0)
  await tile.click()
  await expect(page.getByTestId('bulk-revive')).toBeVisible()
})

test('小窓とグループ余白でダブルクリックの意味が変わる', async ({ page }) => {
  // **落ちたから直したのではなく、仕様が変わったので書き換えた**（並べ替え設計§10-1）。
  // 掴む操作と開く操作が同じ押し方だと、並べ替えようとして開いてしまう（§4-1）
  await openDashboard(page)
  // 同じ作業ディレクトリで2本走らせる＝1つのグループにまとまる
  const first = await spawnSession(page)
  await spawnSession(page)

  const group = page.getByTestId('project-group')
  await expect(group).toHaveCount(1)
  await expect(page.getByTestId('session-tile')).toHaveCount(2)

  // **シングルクリックでは開かない。** 開くことと同じだけ、開かないことを確かめる
  await first.click()
  await expect(page).not.toHaveURL(/\/s\/[0-9a-f-]{36}$/)
  await expect(first).toHaveAttribute('data-selected', 'true')

  // 小窓をダブルクリック → そのセッション1つだけ
  await first.dblclick()
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('session-view')).toHaveCount(1)

  // グループの余白をクリック → 全セッションが横並びで開く
  await page.goto('/')
  await page.getByTestId('project-group').dblclick({ position: { x: 5, y: 5 } })
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

  /*
    **タブの名前も一緒に見る**（タブ設計「書き手はページ層に置く」）。ここは
    一覧 →`/s/`→`/p/` を回る唯一のテストなので、**移った先で名前が付いてくるか**を
    確かめられるのはここしかない。一覧は PJT に属さないので既定のまま。
  */
  const タブ名 = `${path.basename(WORK_DIR)} — AgentDashboard`
  await expect(page).toHaveTitle('AgentDashboard')

  // 一覧 → セッション専用画面。**開くのはダブルクリック**（並べ替え設計§4-1）
  await tiles.first().dblclick()
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)
  await expect(page).toHaveTitle(タブ名)

  /*
    **行き来は1つの切替ボタンになった**（設計§17-3）。以前は「単独画面はパスの
    リンク、横並びは文字の『開く』」と**入り口が2つに割れていた**が、
    **同じボタンが向きだけ変えて両方の画面に出る**。
  */
  const 縮小 = page.getByTestId('zoom-toggle')
  await expect(縮小).toHaveAttribute('data-zoom', 'out')
  await 縮小.click()
  await expect(page).toHaveURL(`/p/local/${encodeURIComponent(WORK_DIR)}`)
  // **同じ PJT なので名前は変わらない。** 画面が変わっても呼ぶ場所が変わるだけ
  await expect(page).toHaveTitle(タブ名)

  // PJT 専用画面 → セッション専用画面。**押した区画のセッションへ行くこと**。
  // 先頭に固定する実装でも通ってしまわないよう、**最後の区画**の id を先に読む
  const views = page.getByTestId('session-view')
  await expect(views).toHaveCount(2)
  const wanted = await views.last().getAttribute('data-card-id')
  expect(wanted).not.toBeNull()
  const 拡大 = views.last().getByTestId('zoom-toggle')
  await expect(拡大).toHaveAttribute('data-zoom', 'in')
  await 拡大.click()
  await expect(page).toHaveURL(`/s/${wanted}`)

  // 一周して戻った先は単独画面。**同じボタンが、向きだけ戻っている**
  await expect(page.getByTestId('zoom-toggle')).toHaveCount(1)
  await expect(page.getByTestId('zoom-toggle')).toHaveAttribute('data-zoom', 'out')
})

test('狭い窓でも、PJT の名前が自分で行を増やさない', async ({ page }) => {
  /*
    **出すのは名前だけになった**（設計§14-5）。1行目には始末のボタンも並ぶので、
    名前が長いときに**押し広げるのではなく切り詰められる**ことがここの主張になる。

    **材料に長い名前を使う。** 短い名前では `truncate` を外しても切り詰めが要らず、
    **壊し方で落ちない**。
  */
  const 長い名前 = 'とても長い名前のディレクトリ-これは折り返させたい'
  const deep = path.join(WORK_DIR, 'agentdashboard-e2e-名前', 長い名前)
  fs.mkdirSync(deep, { recursive: true })

  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)

  // 短い名前のときの高さを先に測る（比べる相手）
  const shortTile = await spawnSession(page)
  await shortTile.dblclick()
  const shortLink = await page.getByTestId('project-name').boundingBox()
  expect(shortLink).not.toBeNull()

  await page.goto('/')
  const deepTile = await spawnSession(page, deep)
  await deepTile.dblclick()
  const deepLink = page.getByTestId('project-name')
  const deepBox = await deepLink.boundingBox()
  expect(deepBox).not.toBeNull()

  // **1行のまま。** `truncate`（`white-space: nowrap`）を外すと折り返して背が伸びる
  expect(deepBox!.height).toBeCloseTo(shortLink!.height, 0)

  // **押し広げるのではなく、切り詰められている。** `min-w-0` を外すと縮めなくなり、
  // 中身の幅がそのまま出る＝切り詰めが起きない
  const clipped = await deepLink.evaluate((el) => el.scrollWidth > el.clientWidth)
  expect(clipped).toBe(true)

  // **フルパスは `title` に残る。** 名前だけでは、どの機械のどこかが分からなくなる
  await expect(deepLink).toHaveAttribute('title', deep)
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
  await tile.dblclick()

  const view = page.getByTestId('session-view')
  // **測る相手が変わった**（設計§17-1）。最終活動はセッションに効く行なので、
  // 帯ではなく**操作列**に居る
  const 帯 = view.getByTestId('session-ops')
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
  const 行たち = await view.locator('[data-testid="session-ops"] [data-row]').all()
  expect(行たち).toHaveLength(2)
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

test('ボタンの見た目を変えても、行の高さは変わらない', async ({ page }) => {
  /*
    訂正その2（帯設計§15-4）。**見た目の訂正が、このイシューの目的（行を増やさない）を
    上回ることはない。**

    **絶対値では書かない。** 「1行目は 32px」と書くと、部品の寸法を変えるたびに
    数字だけを直すことになり、**何を守っていたのかが消える**。守りたいのは
    「**いちばん高い部品が行の高さを決めていて、新しく足したものはそれを超えない**」
    ことなので、そのまま主張にする。

    - 1行目：✕（`size-8` ＝ 32px）が最も高い。電源（28px）とゴミ箱（28px）は超えない
    - 3行目：ドロップダウンが最も高い。1.3倍にしたトグルは超えない

    **壊し方：** トグルの上下の余白（`py-0.5`）を戻すと、3行目がドロップダウンより
    高くなってここが落ちる。
  */
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  const tile = await spawnSession(page)
  await tile.dblclick()

  const view = page.getByTestId('session-view')
  await expect(view.getByTestId('power-card')).toBeVisible()

  const 高さ = async (locator: ReturnType<typeof view.locator>) => {
    const box = await locator.boundingBox()
    expect(box).not.toBeNull()
    return box!.height
  }

  /*
    **測る相手が操作列へ移った**（設計§17-1）。守りたいことは変わらない——
    **いちばん高い部品が行の高さを決めていて、足したものはそれを超えない。**
  */
  const ops = view.getByTestId('session-ops')

  // 操作の行——トグルを大きくしても、ボタン（`icon-sm`）を超えない
  const 操作の行 = await 高さ(ops.locator('[data-row="1"]'))
  const ゴミ箱 = await 高さ(view.getByTestId('close-card'))
  expect(await 高さ(view.getByTestId('power-card'))).toBeLessThanOrEqual(ゴミ箱)
  expect(await 高さ(view.getByTestId('zoom-toggle'))).toBeLessThanOrEqual(ゴミ箱)
  expect(
    await 高さ(view.getByTestId('terminal-toggle')),
    'トグルがボタンより高くなっていない（大きくしすぎるとここが落ちる）',
  ).toBeLessThanOrEqual(ゴミ箱)
  expect(操作の行, '操作の行の高さはボタンが決めている').toBeCloseTo(ゴミ箱, 0)

  // モデルとモードの行
  const 選ぶ行 = await 高さ(ops.locator('[data-row="2"]'))
  const ピッカー = await 高さ(view.getByTestId('model-picker'))
  expect(選ぶ行, 'この行の高さはドロップダウンが決めている').toBeCloseTo(ピッカー, 0)

  // 操作列は2行、帯は1行（設計§17-1・§39.4）
  await expect(ops.locator('[data-row]')).toHaveCount(2)
  await expect(view.getByTestId('screen-bar')).toHaveCount(1)
})

test('✕ を押すと、開く前の画面へ戻る', async ({ page }) => {
  // **「戻る」と「一覧へ落ちる」を区別できる道筋で確かめる。** 一覧から開いて
  // ✕ を押すと、どちらの実装でも `/` へ行くので**見分けが付かない**（設計§7）
  await openDashboard(page)
  const tile = await spawnSession(page)
  await tile.dblclick()
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)

  // セッション専用画面 → PJT 専用画面 → セッション専用画面、と2つ潜る
  await page.getByTestId('zoom-toggle').click()
  await expect(page).toHaveURL(/\/p\//)
  await page.getByTestId('zoom-toggle').first().click()
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)

  // ✕ で1つ戻る＝ PJT 専用画面。**一覧へ落ちたらこの主張が落ちる**
  await page.getByTestId('close-session').click()
  await expect(page).toHaveURL(/\/p\//)
})

test('いきなり開いた画面で ✕ を押しても、アプリの外へ出ずに一覧へ行く', async ({
  page,
}) => {
  /*
    **ここが本番の壊れ方**（設計§7）。履歴の件数で判定すると、このアプリへ来る前の
    履歴が数に入って「戻れる」と誤って答え、素直に1つ戻ると**アプリの外へ出る**——
    閉じるつもりでアプリから出る、という一番困る形になる。

    リロードするとルータは作り直されるので、鍵は `default` に戻る。**単体では
    作りにくい**（jsdom の履歴はこのアプリの中だけで完結する）ので、ここで見る。
  */
  await openDashboard(page)
  const tile = await spawnSession(page)
  await tile.dblclick()
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/)

  const cardId = new URL(page.url()).pathname.split('/').pop()!

  /*
    **リロードでは見分けが付かない。** リロードしても履歴の並びは残っているので、
    素直に1つ戻っても結局 `/`（一覧）に着く——正しい実装でも壊れた実装でも同じ
    結果になり、**テストが何も守らない**。

    **危ないのは「このアプリへ来る前の履歴がある」場合**（設計§7）。新しいタブで
    いきなり `/s/:id` を開くと、1つ戻る先は**アプリの外**（空のページ）になる。
  */
  const 新しいタブ = await page.context().newPage()
  await 新しいタブ.goto(`/s/${cardId}`)
  await expect(新しいタブ.getByTestId('session-view')).toBeVisible()
  await expect(新しいタブ).toHaveTitle(`${path.basename(WORK_DIR)} — AgentDashboard`)

  await 新しいタブ.getByTestId('close-session').click()

  // **一覧に着いていること。** `toHaveURL('/')` は土台の原点に対して解決されるので、
  // アプリの外（空のページ）へ出ていたらここで落ちる
  await expect(新しいタブ).toHaveURL('/')
  // 着いた先が本当に一覧であること（URL だけでは、描けていない場合を見逃す）
  await expect(新しいタブ.getByTestId('project-add-open')).toBeVisible()
  /*
    **タブの名前も既定へ戻っていること**（タブ設計「離れたら既定へ戻す」）。
    読み込み直しではなく**画面を移っただけ**で戻ることを見たいので、ここで見る
    ——`goto` で確かめると、`index.html` の `<title>` が出ているだけの姿でも通る。
  */
  await expect(新しいタブ).toHaveTitle('AgentDashboard')
  await 新しいタブ.close()
})
