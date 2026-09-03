import { expect, test, type Locator, type Page } from '@playwright/test'
import { addProject, openDashboard, spawnSession, WORK_DIR } from './helpers'
import path from 'node:path'

/**
 * 掴んで並べ替える（並べ替え設計§3・テスト計画フェーズ5「並べ替え」）。
 *
 * # ここでしか言えないこと
 *
 * 単体は矩形を字で書いているので（`lib/reorder.test.ts`）、**実際に位置から落とし先が
 * 決まること**はここでしか確かめられない。jsdom は幅を常に 800・左端を常に 0 で返す。
 *
 * # 指は CDP で合成する
 *
 * `page.dispatchEvent` はリスナーへ届きはするが**既定動作が一切起きない**ので、
 * 握れているかを一度も確かめないまま緑になる（`swipeTerminal` と同じ理由）。
 * あわせて **`jitter` を入れる**——真っ直ぐな合成タッチだけだと壊した状態でも通る
 * ことが既存イシューで実測されている（2px と 12px では通り、30px で初めて落ちた）。
 */

/** 枠の並び（パスだけ）。 */
async function 枠の並び(page: Page): Promise<string[]> {
  return page.getByTestId('project-group').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-project') ?? ''),
  )
}

/** その枠の中のカードの並び（カードID）。 */
async function カードの並び(group: Locator): Promise<string[]> {
  return group.getByTestId('tile-shell').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-card-id') ?? ''),
  )
}

/**
 * マウスで掴んで、点まで運ぶ。
 *
 * **掴む場所を指定できる。** 掴み手を外して**本体をそのまま掴む**ようになったので
 * （利用者の指定・2026-09-03）、枠は中心を掴むと**中のカードを掴んでしまう**
 * ——枠を運びたいときは余白（左上）を渡す。
 */
async function マウスで運ぶ(
  page: Page,
  target: Locator,
  to: { x: number; y: number },
  位置?: { x: number; y: number },
) {
  const box = await target.boundingBox()
  if (!box) {
    throw new Error('掴む相手の位置が取れません')
  }
  const from =
    位置 === undefined
      ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      : { x: box.x + 位置.x, y: box.y + 位置.y }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8,
    )
  }
  await page.mouse.up()
}

/**
 * **指で**掴んで運ぶ。
 *
 * `jitter` の1回目は「横へ 30px・縦へ 15px」。**ここで向きを確定させると、その
 * なぞりは二度と握れない**という道が実機にあるので、真っ直ぐには動かさない。
 *
 * **押してすぐには動かさない。** 本体を掴むようになったので、指は**長押しが成立して
 * から**掴む（利用者の指定・スマホのホーム画面と同じ形）。ここで待たずに動かすと、
 * 8px を超えた時点で長押しの計測が捨てられ、**縦スクロールになる**——それは
 * 壊れているのではなく仕様どおりで、別のテストがその側を見ている。
 */
async function 指で運ぶ(
  page: Page,
  target: Locator,
  to: { x: number; y: number },
  jitter = 30,
  位置?: { x: number; y: number },
) {
  const box = await target.boundingBox()
  if (!box) {
    throw new Error('掴む相手の位置が取れません')
  }
  const from =
    位置 === undefined
      ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      : { x: box.x + 位置.x, y: box.y + 位置.y }
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y }],
    })
    // **長押しが成立するまで待つ**（400ms ＋ 余白）。動かさずに待つのが条件
    await page.waitForTimeout(600)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + jitter, y: from.y + jitter / 2 }],
    })
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * step) / 8,
            y: from.y + ((to.y - from.y) * step) / 8,
          },
        ],
      })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }
}

/**
 * 2つの枠を作る。戻り値は（先, 後）のパス。
 *
 * **テストごとに別の名前を使う。** 同じサーバを共有しているので、前のテストが
 * 並べ替えた結果がそのまま残る——同じ枠を使い回すと、2本目は「もう並んでいる」
 * ところから始まって**何も確かめない**（実際にそうなった）。
 */
async function 枠を2つ(page: Page, 印: string): Promise<[string, string]> {
  const 先 = path.join(WORK_DIR, `reorder-${印}-a`)
  const 後 = path.join(WORK_DIR, `reorder-${印}-b`)
  await addProject(page, 先)
  await addProject(page, 後)
  return [先, 後]
}

test('枠をマウスで掴んで並べ替えられる', async ({ page }) => {
  await openDashboard(page)
  const [先, 後] = await 枠を2つ(page, 'mouse')

  const 前 = await 枠の並び(page)
  expect(前.indexOf(先)).toBeLessThan(前.indexOf(後))

  // 後ろの枠の掴み手を、先の枠の中心まで運ぶ
  const 後の枠 = page.locator(`[data-testid="project-group"][data-project="${後}"]`)
  const 先の枠 = page.locator(`[data-testid="project-group"][data-project="${先}"]`)
  const 的 = await 先の枠.boundingBox()
  if (!的) {
    throw new Error('枠の位置が取れません')
  }
  // **枠の余白を掴む。** 中心はカードなので、そちらを掴んでしまう
  await マウスで運ぶ(
    page,
    後の枠,
    { x: 的.x + 的.width / 2, y: 的.y + 的.height / 2 },
    { x: 5, y: 5 },
  )

  await expect
    .poll(async () => {
      const 後で = await 枠の並び(page)
      return 後で.indexOf(後) < 後で.indexOf(先)
    })
    .toBe(true)

  // **リロードしても残る**（記録に入っていることの担保。§2）
  await page.reload()
  await openDashboard(page)
  const 読み直し = await 枠の並び(page)
  expect(読み直し.indexOf(後)).toBeLessThan(読み直し.indexOf(先))
})

/*
  **指の話は、指の文脈でしか確かめられない。**

  押し方の割り当ては `(pointer: coarse) and (hover: none)` で切り替わる（`lib/pointer.ts`）。
  素のデスクトップ文脈に CDP でタッチを撃っても**その問い合わせは偽のまま**なので、
  長押しの計測そのものが始まらない——**実機では起きない状況を試して落ちていた**。

  `isMobile` を立てると Chromium が携帯の見立てになり、粗いポインタとして答える。
*/
test.describe('指で触る画面', () => {
  test.use({ hasTouch: true, isMobile: true })

  test('枠を指で掴んでも並べ替えられる', async ({ page }) => {
    await openDashboard(page)
    const [先, 後] = await 枠を2つ(page, 'touch')

    const 後の枠 = page.locator(`[data-testid="project-group"][data-project="${後}"]`)
    const 先の枠 = page.locator(`[data-testid="project-group"][data-project="${先}"]`)
    const 的 = await 先の枠.boundingBox()
    if (!的) {
      throw new Error('枠の位置が取れません')
    }
    await 指で運ぶ(
      page,
      後の枠,
      { x: 的.x + 的.width / 2, y: 的.y + 的.height / 2 },
      30,
      { x: 5, y: 5 },
    )

    await expect
      .poll(async () => {
        const 後で = await 枠の並び(page)
        return 後で.indexOf(後) < 後で.indexOf(先)
      })
      .toBe(true)
  })

  test('長押しせずに指でなぞると、並びは変わらず縦に流れる', async ({ page }) => {
    /*
      **これが「縦スクロールを殺していない」ことを見る唯一の道である。**

      本体を掴めるようにしたので、指で触ったときに**スクロールと運びを見分ける**必要が
      ある。見分け方は長押しで、成立するまでは `preventDefault()` を1本も呼ばない
      ——だから**押してすぐ動かせば、普通にページが流れる**。

      jsdom では言えない（スクロールを持たない）。
    */
    await openDashboard(page)
    const [先, 後] = await 枠を2つ(page, 'scroll')

    const 前 = await 枠の並び(page)
    const 後の枠 = page.locator(`[data-testid="project-group"][data-project="${後}"]`)
    const 箱 = await 後の枠.boundingBox()
    if (!箱) {
      throw new Error('枠の位置が取れません')
    }

    const cdp = await page.context().newCDPSession(page)
    try {
      const from = { x: 箱.x + 5, y: 箱.y + 5 }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from.x, y: from.y }],
      })
      // **待たずにすぐ動かす。** 8px を超えた時点で長押しの計測が捨てられる
      for (let step = 1; step <= 8; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: from.x, y: from.y - step * 20 }],
        })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await cdp.detach()
    }

    // **並びは1つも動かない**
    expect(await 枠の並び(page)).toEqual(前)
    expect(前.indexOf(先)).toBeLessThan(前.indexOf(後))
  })
})

test('カードを並べ替えると、PJT 専用画面も同じ順になる', async ({ page }) => {
  // **正が1本であることを実物で見る**（設計§2）。ホームで動かした結果が、
  // 横並びの画面にもそのまま出る
  await openDashboard(page)
  // **実在するフォルダでしか起こせない。** 枠は名前だけで作れるが、セッションは
  // そこで claude を起こすので、無いパスだと起動そのものが通らない
  const cwd = WORK_DIR
  await spawnSession(page, cwd)
  await spawnSession(page, cwd)

  const 枠 = page.locator(`[data-testid="project-group"][data-project="${cwd}"]`)
  const 前 = await カードの並び(枠)
  expect(前).toHaveLength(2)

  const 二枚目 = 枠.getByTestId('tile-shell').nth(1)
  /*
    **測る前に見えるところへ持ってくる。** `boundingBox()` が返すのは見えている場所の
    座標で、**スクロールの外にあるものは的が合わない**。前のテストが枠を6つ作るので、
    この枠は下へ押し出されている——**通しでだけ落ちる**形で出た（単独では通る）。
  */
  await 二枚目.scrollIntoViewIfNeeded()
  const 一枚目の箱 = await 枠.getByTestId('tile-shell').nth(0).boundingBox()
  if (!一枚目の箱) {
    throw new Error('カードの位置が取れません')
  }
  // **カードは本体をそのまま掴む**（掴み手は無くなった）
  await マウスで運ぶ(page, 二枚目, {
    x: 一枚目の箱.x + 一枚目の箱.width / 2,
    y: 一枚目の箱.y + 一枚目の箱.height / 2,
  })

  await expect
    .poll(async () => (await カードの並び(枠))[0])
    .toBe(前[1])

  // PJT 専用画面でも同じ順であること
  // **開くのはダブルクリック**（設計§4-1）
  // **開くのはダブルクリック**（設計§4-1）。既存の通しと同じ場所（枠の左上5px）
  await 枠.dblclick({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()
  const 横並び = await page
    .getByTestId('session-view')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-card-id') ?? ''))
  expect(横並び[0]).toBe(前[1])
})

test('掴んでいる間だけ、押しのけられる側も滑る', async ({ page }) => {
  /*
    **ここは実物のブラウザでしか言えない。** jsdom は矩形を固定で返すので FLIP の差分が
    必ず 0 になり、**滑る動きそのものを1つも確かめられない**。

    見るのは3つ——**印が掴んでいる間だけ立つ**こと、**押しのけられた側にも走っている
    動きが在る**こと（＝「持っているカードだけでなく、入れ替わる側も」の実体）、
    **傾きが実際に出ている**こと（クラスは付いていても `motion` に潰されていた）。
  */
  await openDashboard(page)
  const [先, 後] = await 枠を2つ(page, 'motion')

  const 後の枠 = page.locator(`[data-testid="project-group"][data-project="${後}"]`)
  const 先の枠 = page.locator(`[data-testid="project-group"][data-project="${先}"]`)
  await 後の枠.scrollIntoViewIfNeeded()
  const 箱 = await 後の枠.boundingBox()
  const 的 = await 先の枠.boundingBox()
  if (!箱 || !的) {
    throw new Error('枠の位置が取れません')
  }

  // 掴む前は立っていない
  await expect(後の枠).toHaveAttribute('data-reordering', 'false')

  const from = { x: 箱.x + 5, y: 箱.y + 5 }
  const to = { x: 的.x + 的.width / 2, y: 的.y + 的.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8,
    )
  }

  // **掴んでいる間は立つ**
  await expect(後の枠).toHaveAttribute('data-reordering', 'true')
  await expect(後の枠).toHaveAttribute('data-dragging', 'true')

  // **傾きと縮みが実際に出ている**（個別プロパティ。`transform` は `motion` のもの）。
  // 枠は面が大きいので 1.02 ではなく 0.97（要件「追加要望」1）。滑りの途中を読まないよう待つ
  await expect
    .poll(() => 後の枠.evaluate((el) => getComputedStyle(el).rotate))
    .toBe('1deg')
  await expect
    .poll(() => 後の枠.evaluate((el) => getComputedStyle(el).scale))
    .toBe('0.97')

  // **押しのけられた側にも動きが走っている**
  const 押しのけられた側 = await 先の枠.evaluate((el) => el.getAnimations().length)
  expect(押しのけられた側).toBeGreaterThan(0)

  await page.mouse.up()

  // **離してもすぐには降ろさない**（戻る動きが切れないため）。滑り終われば降りる
  await expect(後の枠).toHaveAttribute('data-reordering', 'false', { timeout: 3_000 })
})

test('「静止」を選ぶと、並べ替えは滑らない', async ({ page }) => {
  /*
    **設定の約束を守っていることを、実物で見る。** 「すべて止める」と言っている段で
    ここだけ動くと、約束が嘘になる。並べ替えそのものは動かなくても機能する。
  */
  await openDashboard(page)
  const [, 後] = await 枠を2つ(page, 'quiet')
  const 後の枠 = page.locator(`[data-testid="project-group"][data-project="${後}"]`)
  await 後の枠.scrollIntoViewIfNeeded()
  const 箱 = await 後の枠.boundingBox()
  if (!箱) {
    throw new Error('枠の位置が取れません')
  }

  await page.request.put('/api/settings', { data: { motion_quiet: 'still' } })
  await page.reload()
  await openDashboard(page)

  try {
    await page.mouse.move(箱.x + 5, 箱.y + 5)
    await page.mouse.down()
    await page.mouse.move(箱.x + 40, 箱.y + 5)
    await page.mouse.move(箱.x + 80, 箱.y + 5)
    // 個別プロパティごとに1つずつ並ぶ（`translate, scale, rotate`）。**全部 0 であること**
    const 時間 = await 後の枠.evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    )
    expect(時間.split(',').map((each) => each.trim())).toEqual(
      時間.split(',').map(() => '0s'),
    )
    await page.mouse.up()
  } finally {
    // **戻し忘れると、後続の無関係なテストが静止のまま走る**
    await page.request.put('/api/settings', { data: { motion_quiet: 'lively' } })
  }
})

test('区画の掴み手は、いまも出る', async ({ page }) => {
  /*
    **このテストは末尾に置く。** 同じ作業フォルダにセッションを1本増やすので、
    枚数を数えるテストより前に置くと、あちらが「2枚のはず」で落ちる（実際に落ちた）。

    **掴み手を外したのはカードと PJT枠だけ**（利用者の指定）。セッションの区画は
    このままである——「セッションの上にハンドルがあるのはいい」。

    ここが消えると、**横並びの画面で並べ替える道が1つも無くなる**。
  */
  await openDashboard(page)
  const cwd = WORK_DIR
  await spawnSession(page, cwd)

  const 枠 = page.locator(`[data-testid="project-group"][data-project="${cwd}"]`)
  // 一覧には無い
  await expect(枠.getByTestId('reorder-handle')).toHaveCount(0)

  await 枠.dblclick({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()
  // 横並びには有る
  await expect(
    page.getByTestId('group-view').getByTestId('reorder-handle').first(),
  ).toBeVisible()
})
