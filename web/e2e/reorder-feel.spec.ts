import { expect, test } from '@playwright/test'
import { archiveAll, openDashboard, spawnSession, WORK_DIR } from './helpers'
import {
  カード,
  カードの並び,
  ノードの様子,
  ノードを控える,
  フレームごとに運ぶ,
  一フレーム待つ,
  中心,
  変形を読む,
  掴む,
  落ち着くまで待つ,
  書き換えの数,
  書き換えを数え始める,
  標本を張る,
  標本を読む,
  並びの標本,
  並びを標本する,
  近い,
} from './reorder-helpers'

/**
 * 並べ替えの**手触り**（並べ替え設計§15・テスト計画フェーズ8）。
 *
 * `reorder.spec.ts` が見ているのは「並びが正しくなること」で、利用者の指摘6件を
 * 1本も捕まえられなかった。ここは「並び方が気持ちいいこと」を見る——追従・
 * 1枚だけ動く・掴みが解けない・離しても飛ばない。
 *
 * **各テストが自分でカードを起こし、`archiveAll` で片付ける。** 並びの手触りは
 * 前のテストの残りに左右されやすい。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

async function カードを並べる(page: Parameters<typeof spawnSession>[0], n: number) {
  for (let index = 0; index < n; index += 1) {
    await spawnSession(page, WORK_DIR)
  }
  await expect(page.getByTestId('session-tile')).toHaveCount(n)
  await 落ち着くまで待つ(page)
  const group = page.getByTestId('project-group').first()
  const ids = await カードの並び(group)
  return { group, ids }
}

test('掴んだカードは、指に 1:1 で追従する', async ({ page }) => {
  test.setTimeout(120_000)
  await openDashboard(page)
  const { ids } = await カードを並べる(page, 3)
  const 本人 = カード(page, ids[0])
  const 先 = カード(page, ids[2])

  const 握り = await 掴む(page, await 中心(本人))
  await expect(本人).toHaveAttribute('data-dragging', 'true')
  const goal = await 中心(先)
  const steps = 12
  for (let step = 1; step <= steps; step += 1) {
    const point = {
      x: 握り.x + ((goal.x - 握り.x) * step) / steps,
      y: 握り.y + ((goal.y - 握り.y) * step) / steps,
    }
    await page.mouse.move(point.x, point.y)
    await 一フレーム待つ(page)
    // **各ステップで、translate ＝ 指 − 握り点**（1px 以内）。読むのは動かした直後
    const { translate } = await 変形を読む(本人)
    expect(
      近い(translate, { x: point.x - 握り.x, y: point.y - 握り.y }),
      `指 (${point.x},${point.y}) に対して translate (${translate.x},${translate.y})`,
    ).toBe(true)
  }
  await page.mouse.up()
})

test('1歩で書き換わるのは、隣の1枚だけ', async ({ page }) => {
  test.setTimeout(120_000)
  await openDashboard(page)
  const { ids } = await カードを並べる(page, 3)
  const 本人 = カード(page, ids[0])
  await 書き換えを数え始める(カード(page, ids[1]), '隣')
  await 書き換えを数え始める(カード(page, ids[2]), '隣の隣')

  const 握り = await 掴む(page, await 中心(本人))
  // 隙間の真ん中（本人の右端＋6px）を少し越える。**隣と入れ替わるが、隣の隣は関係ない**
  const box = await 本人.boundingBox()
  if (!box) throw new Error('位置が取れません')
  await フレームごとに運ぶ(page, 握り, { x: 握り.x + box.width / 2 + 12, y: 握り.y }, 8)
  await expect(async () => {
    expect(await 書き換えの数(page, '隣')).toBeGreaterThan(0)
  }).toPass()
  expect(await 書き換えの数(page, '隣の隣')).toBe(0)
  await page.mouse.up()
})

test('右（下）へ3回続けて動かしても、掴みが解けない', async ({ page }) => {
  /*
    **要件「追加要望」2。** React は後ろへ動く要素のノードだけを外して差し直すので、
    右（下）へ動かすと掴んでいる本人が外れてキャプチャが落ちていた。運んでいる間は
    DOM を並べ替えないので、ノードは同じままで `lostpointercapture` は来ない。
  */
  test.setTimeout(120_000)
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 6)
  const 本人 = カード(page, ids[0])
  await ノードを控える(本人)

  const 握り = await 掴む(page, await 中心(本人))
  let from = 握り
  for (const 次 of [ids[1], ids[2], ids[3]]) {
    const to = await 中心(カード(page, 次))
    await フレームごとに運ぶ(page, from, { x: to.x + 4, y: to.y }, 10)
    from = { x: to.x + 4, y: to.y }
    await expect(本人, `${次} の上まで運んだところ`).toHaveAttribute('data-dragging', 'true')
    const { same, lost } = await ノードの様子(本人)
    expect(same, 'ノードが差し直された').toBe(true)
    expect(lost, 'lostpointercapture が来た').toBe(0)
  }
  // 運んでいる間、DOM の並びは掴んだ瞬間のまま
  expect(await カードの並び(group)).toEqual(ids)
  await page.mouse.up()
  // 離すと確定する。本人は 3 つ後ろ
  await expect.poll(async () => (await カードの並び(group)).indexOf(ids[0])).toBe(3)
})

test('離した瞬間に、隣は 1px も動かない', async ({ page }) => {
  test.setTimeout(120_000)
  await openDashboard(page)
  const { ids } = await カードを並べる(page, 3)
  const 本人 = カード(page, ids[0])
  const 隣 = カード(page, ids[1])

  const 握り = await 掴む(page, await 中心(本人))
  await フレームごとに運ぶ(page, 握り, await 中心(隣), 10)
  // 押しのけが滑り終わるのを待ってから離す
  await page.waitForTimeout(300)
  const 直前 = await 隣.boundingBox()
  if (!直前) throw new Error('位置が取れません')
  await 標本を張る(page, `[data-testid="tile-shell"][data-card-id="${ids[1]}"]`, 10)
  await page.mouse.up()
  const samples = await 標本を読む(page)
  for (const [frame, row] of samples.entries()) {
    expect(近い(row[0], { x: 直前.x, y: 直前.y }), `${frame} フレーム目に隣が動いた`).toBe(true)
  }
  await 一フレーム待つ(page)
})

test('区画を掴み手で右へ3回続けて動かしても、掴みが解けない', async ({ page }) => {
  /*
    **要件「追加要望」2 は区画で最初に出た。** 区画は幅 672px で、右へ3つ動かすには
    レールが画面幅を越えるので、窓を広げてスクロール無しで運ぶ（自動送りは別の段）。
  */
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 3000, height: 900 })
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 4)
  await group.dblclick({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('session-view')).toHaveCount(4)
  const 区画 = (id: string) => page.locator(`[data-testid="session-view"][data-card-id="${id}"]`)
  const 本人 = 区画(ids[0])
  await ノードを控える(本人)

  const 掴み手 = 本人.getByTestId('reorder-handle')
  const 握り = await 掴む(page, await 中心(掴み手))
  await expect(本人).toHaveAttribute('data-dragging', 'true')
  let from = 握り
  for (const 次 of [ids[1], ids[2], ids[3]]) {
    const to = await 中心(区画(次))
    await フレームごとに運ぶ(page, from, { x: to.x + 4, y: 握り.y }, 10)
    from = { x: to.x + 4, y: 握り.y }
    await expect(本人, `${次} の上まで運んだところ`).toHaveAttribute('data-dragging', 'true')
    const { same, lost } = await ノードの様子(本人)
    expect(same, 'ノードが差し直された').toBe(true)
    expect(lost, 'lostpointercapture が来た').toBe(0)
  }
  await page.mouse.up()
  await expect
    .poll(async () =>
      (
        await page.getByTestId('session-view').evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-card-id') ?? ''),
        )
      ).indexOf(ids[0]),
    )
    .toBe(3)
})

test('離した直後の並びが、掴む前の並びへ一度も戻らない', async ({ page }) => {
  /*
    **設計§15-4。** 離した瞬間に `ids`（サーバの並び）へ戻すと、返事が届くまでの
    2〜4フレーム、掴む前の並びが描かれて跳ぶ。手元の並びを返事まで保つ。
  */
  test.setTimeout(120_000)
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 3)
  const 本人 = カード(page, ids[0])
  const 握り = await 掴む(page, await 中心(本人))
  await フレームごとに運ぶ(page, 握り, await 中心(カード(page, ids[1])), 10)
  await page.waitForTimeout(300)
  await 並びを標本する(page, group, 12)
  await page.mouse.up()
  const 期待 = [ids[1], ids[0], ids[2]]
  const samples = await 並びの標本(page)
  for (const [frame, 並び] of samples.entries()) {
    expect(並び, `${frame} フレーム目`).toEqual(期待)
  }
  await expect.poll(() => カードの並び(group)).toEqual(期待)
})

test('断られたら、元の並びへ滑って戻る', async ({ page }) => {
  test.setTimeout(120_000)
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 3)
  await page.route('**/api/sessions/order', (route) =>
    route.fulfill({ status: 409, contentType: 'text/plain', body: 'いまは並べ替えられません' }),
  )
  const 本人 = カード(page, ids[0])
  const 隣 = カード(page, ids[1])
  const 握り = await 掴む(page, await 中心(本人))
  await フレームごとに運ぶ(page, 握り, await 中心(隣), 10)
  await page.waitForTimeout(300)
  await page.mouse.up()
  // いったん手元の並びになり、断られて元へ戻る。**戻りは滑る**（隣に動きが走る）
  await expect.poll(() => カードの並び(group)).toEqual(ids)
  await expect(group.getByTestId('project-remove-error')).toContainText('いまは並べ替えられません')
  await page.unroute('**/api/sessions/order')
})

test('持ち上げと傾きは、掴んでいないカードと並べて計算値で見える', async ({ page }) => {
  // **違う状態を2つ並べて計算値で比べる**（ガイドライン「状態の印は、違う状態と並べて比べるまで数えない」）
  test.setTimeout(120_000)
  await openDashboard(page)
  const { ids } = await カードを並べる(page, 3)
  const 本人 = カード(page, ids[0])
  const 隣 = カード(page, ids[1])
  const 握り = await 掴む(page, await 中心(本人))
  await フレームごとに運ぶ(page, 握り, { x: 握り.x + 30, y: 握り.y }, 6)
  // 持ち上げ（120ms）が着き、指を止めた傾き（速度ぶん）が戻るまで待つ
  await expect.poll(async () => (await 変形を読む(本人)).scale).toBe(1.02)
  await expect.poll(async () => (await 変形を読む(本人)).rotate).toBe(1)
  const 隣の変形 = await 変形を読む(隣)
  expect(隣の変形.scale).toBe(1)
  expect(隣の変形.rotate).toBe(0)
  await page.mouse.up()
})

test('「静止」では、離した次のフレームに本人の translate が無い', async ({ page }) => {
  test.setTimeout(120_000)
  await openDashboard(page)
  const { ids } = await カードを並べる(page, 3)
  await page.request.put('/api/settings', { data: { motion_quiet: 'still' } })
  // 設定は読み直して反映する（`reorder.spec.ts` の「静止」と同じ作法）
  await page.reload()
  await openDashboard(page)
  try {
    await expect(カード(page, ids[0])).toHaveAttribute('data-quiet', 'still')
    const 本人 = カード(page, ids[0])
    const 握り = await 掴む(page, await 中心(本人))
    await フレームごとに運ぶ(page, 握り, await 中心(カード(page, ids[1])), 8)
    await page.mouse.up()
    await 一フレーム待つ(page)
    await 一フレーム待つ(page)
    // バネを通らず、その場で収まる（設計§15-7 の止める段）
    expect(await 本人.evaluate((el) => (el as HTMLElement).style.translate)).toBe('')
  } finally {
    await page.request.put('/api/settings', { data: { motion_quiet: 'lively' } })
  }
})

test('ホイールで箱が動いても、判定は指の下のスロットへ追いつく', async ({ page }) => {
  /*
    **凍結した矩形は画面の座標のまま**（設計§15-2）。箱がスクロールしたぶんを指の側に足して
    判定するので、指を止めたままホイールで1行ぶん送ると、本人は1行下のスロットへ移る。
  */
  test.setTimeout(180_000)
  // 箱がスクロールできる高さにする（カードは 3列・1行 ≒ 110px なので、12枚で 4行）
  await page.setViewportSize({ width: 1280, height: 480 })
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 12)
  const 本人 = カード(page, ids[0])
  const 握り = await 掴む(page, await 中心(本人))
  await フレームごとに運ぶ(page, 握り, { x: 握り.x + 20, y: 握り.y }, 4)
  const box = await 本人.boundingBox()
  if (!box) throw new Error('位置が取れません')
  // 1行ぶん（カードの高さ＋隙間）送る。指は動かさない
  await page.mouse.wheel(0, Math.round(box.height) + 12)
  await page.waitForTimeout(600)
  await page.mouse.up()
  await expect.poll(async () => (await カードの並び(group)).indexOf(ids[0])).toBeGreaterThanOrEqual(3)
})

test('端で指を止めると縦の箱が送られ、画面外へ運べる', async ({ page }) => {
  test.setTimeout(180_000)
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 15)
  const 箱 = page.locator('[data-scroll-box="home"]')
  const 本人 = カード(page, ids[0])
  const 握り = await 掴む(page, await 中心(本人))
  const bounds = await 箱.boundingBox()
  if (!bounds) throw new Error('箱の位置が取れません')
  // 下端の帯の中（端から 10px）へ運んで止める
  await フレームごとに運ぶ(page, 握り, { x: 握り.x, y: bounds.y + bounds.height - 10 }, 12)
  await expect.poll(() => 箱.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(100)
  await page.mouse.up()
  await expect.poll(async () => (await カードの並び(group)).indexOf(ids[0])).toBeGreaterThan(5)
})

test('区画は、レールの端で横に送られる', async ({ page }) => {
  test.setTimeout(180_000)
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 5)
  await group.dblclick({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('session-view')).toHaveCount(5)
  const レール = page.getByTestId('group-rail')
  const 区画 = (id: string) => page.locator(`[data-testid="session-view"][data-card-id="${id}"]`)
  const 掴み手 = 区画(ids[0]).getByTestId('reorder-handle')
  const 握り = await 掴む(page, await 中心(掴み手))
  const bounds = await レール.boundingBox()
  if (!bounds) throw new Error('レールの位置が取れません')
  await フレームごとに運ぶ(page, 握り, { x: bounds.x + bounds.width - 10, y: 握り.y }, 12)
  // 区画2本ぶん（688px × 2）送られるまで指を止めて待つ。**送っている間に判定が追いつく**
  await expect
    .poll(() => レール.evaluate((el) => el.scrollLeft), { timeout: 10_000 })
    .toBeGreaterThan(1_376)
  await page.mouse.up()
  await expect
    .poll(async () =>
      (
        await page.getByTestId('session-view').evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-card-id') ?? ''),
        )
      ).indexOf(ids[0]),
    )
    .toBeGreaterThan(1)
})

test('帯の「前へ」で並びが変わり、読み上げの文言が出る', async ({ page }) => {
  // **ドラッグ以外の道**（設計§15-6・WCAG 2.2 SC 2.5.7）。PC はシングルで「選ぶ」
  test.setTimeout(120_000)
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 3)
  await group.locator(`[data-testid="session-tile"][data-card-id="${ids[2]}"]`).click()
  const 前へ = page.getByTestId('bulk-move-back')
  await expect(前へ).toBeVisible()
  await 前へ.click()
  await expect.poll(() => カードの並び(group)).toEqual([ids[0], ids[2], ids[1]])
  await expect(page.getByTestId('bulk-live')).toContainText('移動しました')
  // 覚えている（読み直しても残る）
  await page.reload()
  await openDashboard(page)
  await expect.poll(() => カードの並び(page.getByTestId('project-group').first())).toEqual([
    ids[0],
    ids[2],
    ids[1],
  ])
})

test('キーボードだけで、選んで動かして開ける', async ({ page }) => {
  test.setTimeout(120_000)
  await openDashboard(page)
  const { group, ids } = await カードを並べる(page, 3)
  const 的 = group.locator(`[data-testid="session-tile"][data-card-id="${ids[1]}"]`)
  await 的.focus()
  await page.keyboard.press('Space')
  await expect(的).toHaveAttribute('aria-pressed', 'true')
  expect(page.url()).not.toContain('/s/')
  // 帯の「前へ」へ Tab で辿り着く
  const 前へ = page.getByTestId('bulk-move-back')
  for (let i = 0; i < 12; i += 1) {
    if (await 前へ.evaluate((el) => el === document.activeElement)) break
    await page.keyboard.press('Tab')
  }
  await expect(前へ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => カードの並び(group)).toEqual([ids[1], ids[0], ids[2]])
  // 戻って Enter で開く
  await 的.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/s/${ids[1]}`))
})
