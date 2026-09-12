import { expect, test, type Locator, type Page } from '@playwright/test'
import { addProject, archiveAll, holdTouch, openDashboard, openSession, spawnSession } from './helpers'

/**
 * 自分用のメモ（メモ設計§6〜§9。テスト計画フェーズ5）。
 *
 * # ここで書くのは「実ブラウザでしか確かめられないもの」だけ
 *
 * 積み方・並び・宛先の分かれ方はフェーズ4 の単体が既に守っている。**二度書かない。**
 * ここへ置くのは、jsdom で確かめられないものである。
 *
 * - **BlockNote へ字を打つ**——jsdom では打ち込めない（フェーズ4 がここへ送ってきた）
 * - **マークダウンが打ったそばから見た目になる**——入力の途中で変換が起きる
 * - **クリップボード**——実ブラウザにしか無い
 * - **別の端末**——ブラウザコンテキストを分けないと作れない
 * - **タッチ**——`hover` の無い端末
 *
 * # 宛先2つを同じ筋で通す
 *
 * 要件9（**2つのメモを同じ部品・同じ口・同じ記録で作る**・利用者の指定）を、
 * **テスト自身が示す形**にしてある。同じ本体を宛先違いで流すので、片方だけ直す
 * 変更が入ったらここが落ちる。
 *
 * # 入口を間違えない
 *
 * **`make e2e` から走らせること。** `npm run e2e` を直に叩くと `web/dist` も擬似 claude も
 * 古いまま走る（ガイドライン「絞り込んで走らせたテストは別バイナリを作り直さない」）。
 */

/** サーバに聞いて、そのカードの CLI セッションIDを取る（`nickname.spec.ts` と同じ形）。 */
async function セッションIDを取る(page: Page, cardId: string) {
  await expect
    .poll(
      async () => {
        const rows = await page.evaluate(async () => {
          const response = await fetch('/api/sessions')
          return (await response.json()) as {
            card_id: string
            claude_session_id: string | null
          }[]
        })
        return rows.find((row) => row.card_id === cardId)?.claude_session_id ?? null
      },
      { message: '呼び戻し先が記録に載るのを待つ', timeout: 30_000 },
    )
    .not.toBeNull()
  const rows = await page.evaluate(async () => {
    const response = await fetch('/api/sessions')
    return (await response.json()) as { card_id: string; claude_session_id: string | null }[]
  })
  return rows.find((row) => row.card_id === cardId)!.claude_session_id!
}

/**
 * メモの入力欄。
 *
 * **BlockNote は `contenteditable` なので `keyboard.type()` で打てる。** 面の中に
 * 吹き出しの編集欄も出うるので、**`memo-compose` の中に絞ってから**探す。
 */
function 入力欄(面: Locator) {
  return 面.getByTestId('memo-compose').locator('[contenteditable="true"]').first()
}

/** 字を打つ（確定はしない）。 */
async function 打つ(page: Page, 面: Locator, text: string) {
  await 入力欄(面).click()
  await page.keyboard.type(text)
}

/** 打って Ctrl+Enter で確定する。**素の Enter はブロックを割る側なので使わない。** */
async function 書いて送る(page: Page, 面: Locator, text: string) {
  await 打つ(page, 面, text)
  await page.keyboard.press('Control+Enter')
}

/**
 * 開いている編集欄の中身を、丸ごと打ち直す。
 *
 * **消えたことを確かめてから打つ。** `Control+a` → `Backspace` を投げただけで先へ進むと、
 * **編集欄へ焦点が入る前にキーが飛んで空振りし**、元の字に継ぎ足される
 * （実測：`一番目（直した）` のつもりが `一番目一番目（直した）` になった）。
 *
 * **選んだまま直接打ってもいけない。** 編集欄には BlockNote の末尾ウィジェット
 * （`contenteditable="false"`）が居て `Control+a` はそこまで選ぶので、
 * 選択したまま1文字目を打つと**境界でブロックが分かれる**。
 */
async function 打ち直す(面: Locator, 新しい字: string) {
  const 編集欄 = 面.getByTestId('memo-editing').locator('[contenteditable="true"]').first()
  /*
    **消えるまでやり直す。** 焦点が入っていても `Control+a` が空振りすることがある
    （実測：単独では通り、通しでだけ `ぜんたい一つ目` が残った）。**1回投げて先へ進むと、
    元の字に継ぎ足される。**
  */
  await expect(async () => {
    await 編集欄.click()
    await 編集欄.press('Control+a')
    await 編集欄.press('Backspace')
    await expect(編集欄).toHaveText('')
  }).toPass({ timeout: 20_000 })
  await 編集欄.pressSequentially(新しい字)
  await 編集欄.press('Control+Enter')
}

/** セッションのメモを開く（両画面共通）。**区画で絞れるよう `scope` を取る。** */
async function セッションのメモを開く(scope: Page | Locator) {
  await scope.getByTestId('memo-toggle').click()
  const 面 = scope.getByTestId('memo-pane')
  await expect(面).toBeVisible()
  return 面
}

/** 全体メモを開く（ヘッダの歯車の隣）。 */
async function 全体メモを開く(page: Page) {
  await page.getByTestId('global-memo-toggle').click()
  const 面 = page.getByTestId('memo-pane')
  await expect(面).toBeVisible()
  return 面
}

/** 吹き出しの本文を、出ている順に並べて取る。 */
async function 本文たち(面: Locator) {
  return await 面.getByTestId('memo-body').allInnerTexts()
}

/** セッションを1つ起こし、メモを書ける状態まで持っていく。 */
async function メモを書けるセッション(page: Page) {
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  // **`memo-toggle` は `claude_session_id` が付くまで出ない**（メモは会話のIDに紐づく）。
  // 待たずに押すと、**速い機械では通り遅い機械では落ちる**
  const session = await セッションIDを取る(page, cardId)
  return { tile, cardId, session }
}

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/* ==========================================================================
   中心：字を打って送る（フェーズ4 から送られてきた唯一の未検証項目）
   ========================================================================== */

test('字を打って送ると、中身ごと積まれる。リロードしても残る', async ({ page }) => {
  // **「送れた」で止めない。** 打った字が本文として記録され、読み直しても同じ字が
  // 出るところまで見る。ここを外すと、このフェーズを立てた意味が無い
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)

  const 面 = await セッションのメモを開く(page)
  await expect(面.getByTestId('memo-bubble')).toHaveCount(0)

  await 書いて送る(page, 面, 'あとで設定を直す')

  const 吹き出し = 面.getByTestId('memo-bubble')
  await expect(吹き出し).toHaveCount(1, { timeout: 30_000 })
  await expect(吹き出し.getByTestId('memo-body')).toHaveText('あとで設定を直す')

  // **記録から読み直す経路**。手元の写しだけ返していたらここで落ちる
  await page.reload()
  const 開き直した = await セッションのメモを開く(page)
  await expect(開き直した.getByTestId('memo-body')).toHaveText('あとで設定を直す', {
    timeout: 30_000,
  })
})

test('送ったあと、入力欄は空になっている', async ({ page }) => {
  // **チャットの作法。** 残っていると「送れたのか」が分からず、もう一度押して
  // 同じものが2つ積まれる。**書きかけとしても残ってしまう**
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)

  const 面 = await セッションのメモを開く(page)
  await 書いて送る(page, 面, '一度だけ積みたい')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })

  await expect(入力欄(面)).toHaveText('')

  // **もう一度確定を押しても増えない**（空は積まない・要件側の意図）
  await 入力欄(面).click()
  await page.keyboard.press('Control+Enter')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1)
})

test('マークダウン記法が、打ったそばから見た目になる', async ({ page }) => {
  // **打鍵の途中で変換が起きる**ので、実際に打たないと出ない。`# ` と `- ` の2つを見る
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)

  const 面 = await セッションのメモを開く(page)
  await 打つ(page, 面, '# 見出しになるはず')

  // 打った時点で入力欄の中が見出しへ変わっている（記法の字は残らない）
  const 入力 = 入力欄(面)
  await expect(入力.locator('h1')).toHaveText('見出しになるはず')
  await expect(入力).not.toContainText('#')

  await page.keyboard.press('Control+Enter')
  const 本文 = 面.getByTestId('memo-body')
  await expect(本文.locator('h1')).toHaveText('見出しになるはず', { timeout: 30_000 })
})

test('直して確定すると時刻が更新されて一番下へ移る。変えずに確定したら動かない', async ({
  page,
}) => {
  // **4と5は対で置く。** 片方だけだと「常に動く」実装も「常に動かない」実装も通る
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)

  await 書いて送る(page, 面, '一番目')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
  // **材料に差を付ける。** 1件目が積まれたのを待ってから2件目を送らないと、
  // 同じ時刻になって並べ替えの検査が空振りする（フェーズ4 の実測）
  await 書いて送る(page, 面, '二番目')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(2, { timeout: 30_000 })
  // **待って確かめる。** 通しで流すと1台のサーバを全テストで共有するので、
  // 待たない検査は**単独では通り通しでだけ落ちる**（実測）
  await expect.poll(async () => await 本文たち(面), { timeout: 30_000 }).toEqual(['一番目', '二番目'])

  // 「一番目」を直す → 一番下へ移る
  const 一番目 = 面.getByTestId('memo-bubble').filter({ hasText: '一番目' })
  await 一番目.getByTestId('memo-edit').click()
  await 打ち直す(面, '一番目（直した）')

  await expect
    .poll(async () => await 本文たち(面), { timeout: 30_000 })
    .toEqual(['二番目', '一番目（直した）'])

  // 変えずに確定 → 動かない
  const 直したもの = 面.getByTestId('memo-bubble').filter({ hasText: '一番目（直した）' })
  await 直したもの.getByTestId('memo-edit').click()
  await 面.getByTestId('memo-editing').locator('[contenteditable="true"]').first().click()
  await page.keyboard.press('Control+Enter')

  await expect
    .poll(async () => await 本文たち(面), { timeout: 30_000 })
    .toEqual(['二番目', '一番目（直した）'])
})

test('確定前は Undo / Redo が効く', async ({ page }) => {
  // **エディタの履歴は実ブラウザでしか動かない**
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)

  await 打つ(page, 面, 'けす')
  await expect(入力欄(面)).toHaveText('けす')

  await page.keyboard.press('Control+z')
  await expect(入力欄(面)).not.toHaveText('けす')

  await page.keyboard.press('Control+Shift+z')
  await expect(入力欄(面)).toHaveText('けす')
})

test('片付けると上へ積まれ、戻すと下へ戻る', async ({ page }) => {
  // 並び自体は単体でも見られるが、**`onMouseDown` の押し方が効いているか**は
  // 実際に押さないと分からない（`onClick` だと面が閉じて押せない）
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)

  await 書いて送る(page, 面, 'のこす')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
  await 書いて送る(page, 面, 'かたづける')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(2, { timeout: 30_000 })

  const 片付ける対象 = 面.getByTestId('memo-bubble').filter({ hasText: 'かたづける' })
  await 片付ける対象.getByTestId('memo-check').click()

  // 下段から消えて、上段（既定で畳んである）へ移る
  await expect
    .poll(async () => await 面.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(), {
      timeout: 30_000,
    })
    .toEqual(['のこす'])
  await 面.getByTestId('memo-checked-toggle').click()
  await expect(面.getByTestId('memo-checked').getByTestId('memo-body')).toHaveText('かたづける')

  // 戻すと下段へ帰る
  await 面.getByTestId('memo-checked').getByTestId('memo-check').click()
  await expect
    .poll(async () => await 面.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(), {
      timeout: 30_000,
    })
    .toEqual(['のこす', 'かたづける'])
})

test('コピーが効く', async ({ page, context }) => {
  // **クリップボードは実ブラウザにしか無い**
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)

  await 書いて送る(page, 面, 'これを写す')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })

  await 面.getByTestId('memo-copy').click()
  const 写したもの = await page.evaluate(() => navigator.clipboard.readText())
  expect(写したもの.trim()).toBe('これを写す')
})

test('別のブラウザコンテキストから開いても、同じ順・同じ状態で出る', async ({ page, browser }) => {
  // **「別の端末」はコンテキストを分けないと作れない**
  await openDashboard(page)
  // **カードのIDは、セッション画面へ移る前に取る。** 移ったあとに一覧の要素を読むと
  // DOM に無いので待ち続ける（実測：120秒で時間切れになった）
  const { tile, cardId, session } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)

  await 書いて送る(page, 面, 'さきに書いた')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
  await 書いて送る(page, 面, 'あとで書いた')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(2, { timeout: 30_000 })
  await 面
    .getByTestId('memo-bubble')
    .filter({ hasText: 'さきに書いた' })
    .getByTestId('memo-check')
    .click()
  await expect
    .poll(async () => await 面.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(), {
      timeout: 30_000,
    })
    .toEqual(['あとで書いた'])

  // **カードの面から読む。** 別のコンテキストでセッションを開き直すと、擬似 claude の
  // 起動待ちが二重になって 120 秒に収まらない（実測）。読めることを見るのが目的なので、
  // **いちばん安い入口で足りる**
  const 別の端末 = await browser.newContext()
  try {
    const 別のページ = await 別の端末.newPage()
    await openDashboard(別のページ)
    const 別のshell = 別のページ.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
    await expect(別のshell).toBeVisible({ timeout: 30_000 })
    await 別のshell.hover()
    await 別のshell.getByTestId('memo-tile').click()
    const 別の面 = 別のページ.getByTestId('memo-pane')
    await expect(別の面).toBeVisible()

    // 下段は未チェックのぶんだけ、上段はチェック済みのぶん
    await expect(別の面.getByTestId('memo-list').getByTestId('memo-body')).toHaveText(
      'あとで書いた',
      { timeout: 30_000 },
    )
    await 別の面.getByTestId('memo-checked-toggle').click()
    await expect(別の面.getByTestId('memo-checked').getByTestId('memo-body')).toHaveText(
      'さきに書いた',
    )
    expect(session).not.toBe('')
  } finally {
    await 別の端末.close()
  }
})

test('全体メモも、セッションメモと同じ筋がそのまま通る', async ({ page }) => {
  /*
    **要件9（2つのメモを同じ部品・同じ口・同じ記録で作る／利用者の指定）を、
    テスト自身が示す。**

    上のセッション宛ての筋（書く → 積まれる → リロードで残る → 直す → 片付ける →
    戻す）を、**宛先だけ変えて同じ順に流す**。片方だけ直す変更が入ったらここが落ちる。
  */
  await openDashboard(page)
  const 面 = await 全体メモを開く(page)

  // 書く → 積まれる
  await 書いて送る(page, 面, 'ぜんたい一つ目')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
  await 書いて送る(page, 面, 'ぜんたい二つ目')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(2, { timeout: 30_000 })
  await expect
    .poll(async () => await 本文たち(面), { timeout: 30_000 })
    .toEqual(['ぜんたい一つ目', 'ぜんたい二つ目'])

  // リロードで残る
  await page.reload()
  const 開き直した = await 全体メモを開く(page)
  await expect
    .poll(async () => await 本文たち(開き直した), { timeout: 30_000 })
    .toEqual(['ぜんたい一つ目', 'ぜんたい二つ目'])

  // 直す → 一番下へ移る
  await 開き直した
    .getByTestId('memo-bubble')
    .filter({ hasText: 'ぜんたい一つ目' })
    .getByTestId('memo-edit')
    .click()
  await 打ち直す(開き直した, 'ぜんたい一つ目（直した）')
  await expect
    .poll(async () => await 本文たち(開き直した), { timeout: 30_000 })
    .toEqual(['ぜんたい二つ目', 'ぜんたい一つ目（直した）'])

  // 片付ける → 上段へ。戻す → 下段へ
  await 開き直した
    .getByTestId('memo-bubble')
    .filter({ hasText: 'ぜんたい二つ目' })
    .getByTestId('memo-check')
    .click()
  await expect
    .poll(
      async () =>
        await 開き直した.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(),
      { timeout: 30_000 },
    )
    .toEqual(['ぜんたい一つ目（直した）'])
  await 開き直した.getByTestId('memo-checked-toggle').click()
  await expect(開き直した.getByTestId('memo-checked').getByTestId('memo-body')).toHaveText(
    'ぜんたい二つ目',
  )
  await 開き直した.getByTestId('memo-checked').getByTestId('memo-check').click()
  /*
    **戻る先は「メモの時刻の位置」であって、末尾ではない**（設計§7-5）。

    ここは私の期待値が間違っていた。`ぜんたい一つ目` は途中で**直した**ので時刻が
    更新されており、`ぜんたい二つ目` より新しい。したがって外したほうは**上に戻る**。
    実装が正しく、テストが誤っていた側である。
  */
  await expect
    .poll(
      async () =>
        await 開き直した.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(),
      { timeout: 30_000 },
    )
    .toEqual(['ぜんたい二つ目', 'ぜんたい一つ目（直した）'])

  // **後始末。** 全体メモはカードに紐づかないので `archiveAll` では消えない
  for (const 本文 of ['ぜんたい一つ目（直した）', 'ぜんたい二つ目']) {
    const 対象 = 開き直した.getByTestId('memo-bubble').filter({ hasText: 本文 })
    await 対象.getByTestId('memo-edit').click()
    await 開き直した.getByTestId('memo-remove').click()
    await 開き直した.getByTestId('memo-remove-confirm').click()
  }
  await expect(開き直した.getByTestId('memo-bubble')).toHaveCount(0, { timeout: 30_000 })
})

/* ==========================================================================
   セッションメモだけ
   ========================================================================== */

test('PJT 専用画面の横並びでも書けて、同じ順で並ぶ', async ({ page }) => {
  // **`compact` の側だけ落ちていないこと。** `SessionView` へ置けば両方に出るが、
  // 片方だけに出す判断も実在するので、**両方で通して初めて「入れた」と言える**
  await openDashboard(page)
  const 枠 = await addProject(page)
  const host = (await 枠.getAttribute('data-host'))!
  const project = (await 枠.getAttribute('data-project'))!
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 単独の面 = await セッションのメモを開く(page)
  await 書いて送る(page, 単独の面, '単独画面から')
  await expect(単独の面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })

  // 横並びへ移る
  await page.goto(`/p/${encodeURIComponent(host)}/${encodeURIComponent(project)}`)
  const 区画 = page.getByTestId('session-view').first()
  await expect(区画).toBeVisible({ timeout: 30_000 })
  const 横並びの面 = await セッションのメモを開く(区画)

  // 単独画面で書いたものが出ている
  await expect(横並びの面.getByTestId('memo-body')).toHaveText('単独画面から', { timeout: 30_000 })

  // 横並びからも書けて、同じ順で並ぶ
  await 書いて送る(page, 横並びの面, '横並びから')
  await expect
    .poll(async () => await 本文たち(横並びの面), { timeout: 30_000 })
    .toEqual(['単独画面から', '横並びから'])
})

test('カードの印は乗ると出て、押すとメモが読める', async ({ page }) => {
  await openDashboard(page)
  const { tile, cardId } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)
  await 書いて送る(page, 面, 'カードから読む')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
  await page.goBack()

  const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
  // **透明度を持つのは群（`.tile-ops`）で、印自身ではない。** 印の計算値を読むと
  // 親がいくら透明でも `1` が返るので、**乗る前でも通ってしまう**
  const 群 = shell.getByTestId('tile-ops')
  await expect(群).toHaveCSS('opacity', '0')
  await shell.hover()
  await expect(群).toHaveCSS('opacity', '1')

  await shell.getByTestId('memo-tile').click()
  const 読む面 = page.getByTestId('memo-pane')
  await expect(読む面).toBeVisible()
  await expect(読む面.getByTestId('memo-body')).toHaveText('カードから読む', { timeout: 30_000 })
  // **一覧から開く面は読むだけ**（要件7）
  await expect(読む面.getByTestId('memo-readonly')).toBeVisible()
  await expect(読む面.getByTestId('memo-compose')).toHaveCount(0)
})

test('あるセッションのメモが、別のセッションに出ない', async ({ page }) => {
  await openDashboard(page)
  const 一つ目 = await メモを書けるセッション(page)
  await openSession(page, 一つ目.tile)
  const 面 = await セッションのメモを開く(page)
  await 書いて送る(page, 面, '一つ目のセッションのメモ')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
  await page.goBack()

  const 二つ目 = await メモを書けるセッション(page)
  expect(二つ目.session).not.toBe(一つ目.session)
  await openSession(page, 二つ目.tile)
  const 別の面 = await セッションのメモを開く(page)

  await expect(別の面.getByTestId('memo-bubble')).toHaveCount(0)
  await expect(別の面).not.toContainText('一つ目のセッションのメモ')
})

test('あとから片付けたものほど下に積まれる', async ({ page }) => {
  // **上段の中の並びは「片付けた時刻」の順**（要件6）。1件だけ片付けても分からないので、
  // **2件を順に片付けて、後のほうが下に来る**ことを見る
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)

  await 書いて送る(page, 面, 'さきに片付ける')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
  await 書いて送る(page, 面, 'あとで片付ける')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(2, { timeout: 30_000 })

  // **先に「さきに片付ける」を片付ける。** 順を付けるので、1件ずつ着地を待つ
  await 面
    .getByTestId('memo-bubble')
    .filter({ hasText: 'さきに片付ける' })
    .getByTestId('memo-check')
    .click()
  await expect
    .poll(async () => await 面.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(), {
      timeout: 30_000,
    })
    .toEqual(['あとで片付ける'])

  await 面
    .getByTestId('memo-bubble')
    .filter({ hasText: 'あとで片付ける' })
    .getByTestId('memo-check')
    .click()
  await expect
    .poll(async () => await 面.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(), {
      timeout: 30_000,
    })
    .toEqual([])

  // 上段は「片付けた時刻」の順。**あとで片付けたほうが下**
  await 面.getByTestId('memo-checked-toggle').click()
  await expect
    .poll(
      async () => await 面.getByTestId('memo-checked').getByTestId('memo-body').allInnerTexts(),
      { timeout: 30_000 },
    )
    .toEqual(['さきに片付ける', 'あとで片付ける'])
})

test('終わったセッションでも、メモは読める（書けはしない）', async ({ page }) => {
  // **目的1がこれである**（設計§6-9）。接続断や終了のあとに「どれがどれか」を
  // 判別したいので、**動いているセッションでしか読めないなら役に立たない**
  await openDashboard(page)
  const { tile } = await メモを書けるセッション(page)
  await openSession(page, tile)
  const 面 = await セッションのメモを開く(page)
  await 書いて送る(page, 面, '終わっても読みたい')
  await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })

  // 電源で止める（`archiveAll` と同じ作法。**点いているときだけ押す**）
  const power = page.getByTestId('power-card')
  if ((await power.getAttribute('data-power')) === 'on') {
    await power.click()
  }

  // 読むだけの面へ変わる。**本文は読めたまま**
  await expect(面.getByTestId('memo-readonly')).toBeVisible({ timeout: 30_000 })
  await expect(面.getByTestId('memo-body')).toHaveText('終わっても読みたい')
  // 書く口は出ない。**コピーは残る**（読むためだけに開く面なので持ち出す道は残す）
  await expect(面.getByTestId('memo-compose')).toHaveCount(0)
  await expect(面.getByTestId('memo-copy')).toHaveCount(1)
})

/* ==========================================================================
   全体メモだけ
   ========================================================================== */

test('全体メモは4つの画面のどこからでも開けて、同じ中身が出る', async ({ page }) => {
  await openDashboard(page)
  const 枠 = await addProject(page)
  const host = (await 枠.getAttribute('data-host'))!
  const project = (await 枠.getAttribute('data-project'))!
  const { tile } = await メモを書けるセッション(page)

  /*
    **自分の吹き出しだけを見る。** 全体メモはカードに紐づかないので `archiveAll` では
    消えず、**前のテストが残したものが混ざりうる**（実測：筋の本が途中で落ちて後片付けまで
    届かなかったとき、この本が巻き添えで落ちた）。**テストは連鎖させない。**
  */
  const 自分のだけ = (面: Locator) =>
    面.getByTestId('memo-bubble').filter({ hasText: 'どこからでも読める' })

  // ①一覧で書く
  const 一覧の面 = await 全体メモを開く(page)
  await 書いて送る(page, 一覧の面, 'どこからでも読める')
  await expect(自分のだけ(一覧の面)).toHaveCount(1, { timeout: 30_000 })
  await page.keyboard.press('Escape')

  // ②PJT 専用画面
  await page.goto(`/p/${encodeURIComponent(host)}/${encodeURIComponent(project)}`)
  await expect(自分のだけ(await 全体メモを開く(page))).toHaveCount(1, { timeout: 30_000 })
  await page.keyboard.press('Escape')

  // ③セッション専用画面
  await openDashboard(page)
  await openSession(page, page.locator(`[data-testid="session-tile"]`).first())
  await expect(自分のだけ(await 全体メモを開く(page))).toHaveCount(1, { timeout: 30_000 })
  await page.keyboard.press('Escape')

  // ④設定画面
  await page.getByTestId('settings-link').click()
  const 設定で見えた = await 全体メモを開く(page)
  await expect(自分のだけ(設定で見えた)).toHaveCount(1, { timeout: 30_000 })
  expect(tile).toBeTruthy()

  // **後始末。** 全体メモはカードに紐づかないので、放っておくと次のテストへ残る
  await 自分のだけ(設定で見えた).getByTestId('memo-edit').click()
  await 設定で見えた.getByTestId('memo-remove').click()
  await 設定で見えた.getByTestId('memo-remove-confirm').click()
  await expect(自分のだけ(設定で見えた)).toHaveCount(0, { timeout: 30_000 })
})

test('一覧で書きかけたものが、別の画面で開いたときに残っている', async ({ page }) => {
  // **全体メモは画面を跨いで開き直される**ので、ここが特に効く（設計§8-1）
  await openDashboard(page)
  const 一覧の面 = await 全体メモを開く(page)
  await 打つ(page, 一覧の面, 'まだ送っていない')
  await expect(入力欄(一覧の面)).toHaveText('まだ送っていない')
  await page.keyboard.press('Escape')

  await page.getByTestId('settings-link').click()
  const 設定の面 = await 全体メモを開く(page)
  await expect(入力欄(設定の面)).toHaveText('まだ送っていない')
})

/* ==========================================================================
   指で触る端末
   ========================================================================== */

test.describe('指で触る端末', () => {
  // **`hasTouch` が `(pointer: coarse)` と `(hover: none)` の両方を立てる**
  test.use({ hasTouch: true })

  test('長押しで選ぶと印が出て、指で読める', async ({ page }) => {
    // **タッチに hover は無い**ので、選択の側が無いとスマホから永久に届かない
    await openDashboard(page)
    const { tile, cardId } = await メモを書けるセッション(page)
    await openSession(page, tile)
    const 面 = await セッションのメモを開く(page)
    await 書いて送る(page, 面, '指で読むメモ')
    await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })
    // **`goBack()` ではなく一覧へ行き直す。** 指の端末では戻った直後に小窓がまだ
    // 描かれておらず、**群そのものが見つからない**ことがあった（実測）
    await page.goto('/')

    const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
    await expect(shell).toBeVisible({ timeout: 30_000 })
    const 群 = shell.getByTestId('tile-ops')
    await expect(群).toHaveCSS('opacity', '0')

    // `touchscreen.tap()` では長押しにならないので CDP で合成する
    await holdTouch(page, tile, { holdMs: 600 })
    await expect(shell).toHaveAttribute('data-selected', 'true')
    await expect(群).toHaveCSS('opacity', '1')

    await shell.getByTestId('memo-tile').tap()
    await expect(page.getByTestId('memo-pane').getByTestId('memo-body')).toHaveText('指で読むメモ', {
      timeout: 30_000,
    })
  })

  test('指でも書けて、片付けられる', async ({ page }) => {
    await openDashboard(page)
    const { tile } = await メモを書けるセッション(page)
    await openSession(page, tile)
    const 面 = await セッションのメモを開く(page)

    await 入力欄(面).tap()
    await page.keyboard.type('指で書いた')
    await page.keyboard.press('Control+Enter')
    await expect(面.getByTestId('memo-bubble')).toHaveCount(1, { timeout: 30_000 })

    // **3つのボタンは `hover` が無くても出る**（`focus-within` でも出す作法）
    await 面.getByTestId('memo-check').tap()
    await expect
      .poll(
        async () =>
          await 面.getByTestId('memo-list').getByTestId('memo-body').allInnerTexts(),
        { timeout: 30_000 },
      )
      .toEqual([])
  })
})
