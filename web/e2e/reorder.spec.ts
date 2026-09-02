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

/** 掴み手をマウスで掴んで、点まで運ぶ。 */
async function マウスで運ぶ(page: Page, handle: Locator, to: { x: number; y: number }) {
  const box = await handle.boundingBox()
  if (!box) {
    throw new Error('掴み手の位置が取れません')
  }
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
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
 * 掴み手を**指で**掴んで運ぶ。
 *
 * `jitter` の1回目は「横へ 30px・縦へ 15px」。**ここで向きを確定させると、その
 * なぞりは二度と握れない**という道が実機にあるので、真っ直ぐには動かさない。
 */
async function 指で運ぶ(
  page: Page,
  handle: Locator,
  to: { x: number; y: number },
  jitter = 30,
) {
  const box = await handle.boundingBox()
  if (!box) {
    throw new Error('掴み手の位置が取れません')
  }
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y }],
    })
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
  await マウスで運ぶ(page, 後の枠.getByTestId('reorder-handle'), {
    x: 的.x + 的.width / 2,
    y: 的.y + 的.height / 2,
  })

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

test('枠を指で掴んでも並べ替えられる', async ({ page }) => {
  await openDashboard(page)
  const [先, 後] = await 枠を2つ(page, 'touch')

  const 後の枠 = page.locator(`[data-testid="project-group"][data-project="${後}"]`)
  const 先の枠 = page.locator(`[data-testid="project-group"][data-project="${先}"]`)
  const 的 = await 先の枠.boundingBox()
  if (!的) {
    throw new Error('枠の位置が取れません')
  }
  await 指で運ぶ(page, 後の枠.getByTestId('reorder-handle'), {
    x: 的.x + 的.width / 2,
    y: 的.y + 的.height / 2,
  })

  await expect
    .poll(async () => {
      const 後で = await 枠の並び(page)
      return 後で.indexOf(後) < 後で.indexOf(先)
    })
    .toBe(true)
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
  const 一枚目の箱 = await 枠.getByTestId('tile-shell').nth(0).boundingBox()
  if (!一枚目の箱) {
    throw new Error('カードの位置が取れません')
  }
  await マウスで運ぶ(page, 二枚目.getByTestId('reorder-handle'), {
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
