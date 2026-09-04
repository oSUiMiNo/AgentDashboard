import { expect, test } from '@playwright/test'
import { addProject, archiveAll, openDashboard } from './helpers'
import { TOAST_EXIT_MS, TOAST_LIFE_MS } from '../src/stores/appNotices'

/**
 * 最前面のトーストとベル（トーストとベル設計§8〜§10）。
 *
 * # ここでしか確かめられないこと
 *
 * 単体（`src/stores/appNotices.test.ts` ほか）が言えるのは「そう書いてある」ことまでで、
 * jsdom は CSS を適用しない。**実際に前へ出るか・下の操作を食わないか・狭い窓で
 * 全幅になるか**は、CSS が本当に回る場所でしか確かめられない。
 *
 * # 寿命の値は実装から読む
 *
 * `TOAST_LIFE_MS` を import しているのは、**テストに数字を書き写さないため**である
 * （`roam.spec.ts` と同じ作法）。値は「7秒ほど」で根拠が弱く、実物を見て決め直す
 * ことになっている——書き写すと、動かしたときにここだけ古い数字が残る。
 */

/** 知らせを1件出す。**存在しないディレクトリで起こす**のが、いちばん確実な出し方 */
async function 知らせを出す(page: import('@playwright/test').Page) {
  const group = await addProject(page, '/存在しないはずのディレクトリ')
  await group.getByTestId('spawn-open').click()
  await group.getByTestId('spawn-mode').selectOption('')
  await group.getByTestId('spawn-button').click()
}

test.beforeEach(async ({ page }) => {
  // **設定は開く前に戻す。** 設定は記録に残るので、静止のまま終わった前のテストの
  // 値を画面が読んでしまう——開いたあとに直しても、その画面はもう古い値で動いている
  await page.request.put('/api/settings', { data: { motion_quiet: 'lively' } })
  // **OS の「動きを減らす」も明示的に外す。** 既定が環境に左右されるので、
  // 指定しないとゲージが出ない機械で落ちる（`roam.spec.ts` と同じ作法）
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openDashboard(page)
  await archiveAll(page)
})

test('左から出て、しばらくで消え、ベルに残る', async ({ page }) => {
  await 知らせを出す(page)

  const toast = page.getByTestId('toast')
  await expect(toast).toContainText('作業ディレクトリが存在しません')

  // **場所を押しのけない**（要件の核）。層は `fixed` なので、本体の座標が動かない
  const layer = page.getByTestId('toast-layer')
  await expect(layer).toHaveCSS('position', 'fixed')

  // 寿命ぶん待つと消える。**消えかけの猶予も足す**
  await expect(toast).toHaveCount(0, { timeout: TOAST_LIFE_MS + TOAST_EXIT_MS + 5_000 })

  // **ベルには残る。** トーストは出口の1つでしかない（設計§1）
  await expect(page.getByTestId('app-notice-bell')).toBeVisible()
  await page.getByTestId('app-notice-bell').click()
  await expect(page.getByTestId('app-notice-item').first()).toContainText(
    '作業ディレクトリが存在しません',
  )
})

test('ベルを開くと未読が消える', async ({ page }) => {
  await 知らせを出す(page)
  await expect(page.getByTestId('toast')).toBeVisible()

  // **未読のバッジが出ている**
  await expect(page.getByTestId('app-notice-unread')).toBeVisible()

  await page.getByTestId('app-notice-bell').click()
  // **開いた瞬間に全件が既読になる**（設計§10-3）
  await expect(page.getByTestId('app-notice-unread')).toHaveCount(0)
})

test('狭い窓では全幅になり、角丸が外れる', async ({ page }) => {
  // **動機がスマホなので、ここは外せない**（設計§8-3）
  await page.setViewportSize({ width: 375, height: 720 })
  await 知らせを出す(page)

  const toast = page.getByTestId('toast')
  await expect(toast).toBeVisible()

  const box = await toast.boundingBox()
  expect(box?.width).toBeCloseTo(375, 0)
  await expect(toast).toHaveCSS('border-radius', '0px')
})

test('広い窓では決めた幅と角丸になる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await 知らせを出す(page)

  const toast = page.getByTestId('toast')
  await expect(toast).toBeVisible()

  const box = await toast.boundingBox()
  expect(box?.width).toBeCloseTo(320, 0)
  await expect(toast).toHaveCSS('border-radius', '6px')
})

test('層は下の操作を食わない', async ({ page }) => {
  await 知らせを出す(page)
  await expect(page.getByTestId('toast')).toBeVisible()

  // **層は画面いっぱいに貼ってある。** `pointer-events` を戻していると、
  // トーストが出ている間じゅう左上のものが押せなくなる（設計§8-2）
  await expect(page.getByTestId('toast-layer')).toHaveCSS('pointer-events', 'none')
  await expect(page.getByTestId('toast')).toHaveCSS('pointer-events', 'auto')
})

test('動きを止めていても、知らせは出て消える', async ({ page }) => {
  // **7秒で消えることは段によらない**（設計§9・利用者の決定）。
  // 設定画面から入れて、そのまま一覧へ戻る——記録へ入ってから読み直される
  await page.goto('/settings')
  await page.getByTestId('motion-quiet-select').selectOption('still')
  await page.goto('/')

  await 知らせを出す(page)
  const toast = page.getByTestId('toast')
  await expect(toast).toBeVisible()

  // **静止では印を出す**（賑やかのときは属性ごと出ない）
  await expect(page.getByTestId('toast-layer')).toHaveAttribute('data-quiet', 'still')

  // **ゲージは隠す**——止まった満タンの棒は「まだ時間がある」と読めてしまう
  await expect(toast.locator('.toast-gauge')).toHaveCSS('opacity', '0')

  // それでも消える
  await expect(toast).toHaveCount(0, { timeout: TOAST_LIFE_MS + TOAST_EXIT_MS + 5_000 })
})

test('賑やかのときはゲージが見えて、乗せている間は止まる', async ({ page }) => {
  await 知らせを出す(page)
  const toast = page.getByTestId('toast')
  await expect(toast).toBeVisible()

  // **マウスを乗せて止めてから測る**（設計§8-4）。乗せないと寿命で消えるので、
  // 測っている最中に相手が居なくなる
  await toast.hover()

  const gauge = toast.locator('.toast-gauge')
  // **残り時間が読める**のが要件の核（設計§8-3）
  await expect(gauge).not.toHaveCSS('opacity', '0')
  await expect(gauge).toHaveCSS('animation-play-state', 'paused')

  // **止めている間は消えない。** 読んでいる最中に消えるのは読み落としそのもの
  await page.waitForTimeout(TOAST_LIFE_MS + TOAST_EXIT_MS + 1_000)
  await expect(toast).toBeVisible()
})

test('知らせは、面より前に出る重なり順を持つ', async ({ page }) => {
  // **重なり順の実効性は、画面でしか確かめられない**（設計§8-2）。
  // 既存の最大は 50（ダイアログ・ポップオーバー）で、トーストは 60
  await 知らせを出す(page)
  const layer = page.getByTestId('toast-layer')
  await expect(layer).toBeVisible()

  // **先に測る。** トーストは7秒で消えるので、面を開いてからでは間に合わない
  const toastZ = Number(await layer.evaluate((el) => getComputedStyle(el).zIndex))
  expect(toastZ).toBeGreaterThan(0)

  // 枠を足す面（`fixed` ＋ `z-50`）を開く
  await page.getByTestId('project-add-open').click()
  const sheet = page.getByTestId('project-add-sheet')
  await expect(sheet).toBeVisible()

  const sheetZ = await sheet.evaluate((el) => {
    // 面そのものか、その親のどこかが重なり順を持っている
    let node: HTMLElement | null = el as HTMLElement
    while (node) {
      const z = getComputedStyle(node).zIndex
      if (z !== 'auto') {
        return Number(z)
      }
      node = node.parentElement
    }
    return 0
  })
  expect(toastZ).toBeGreaterThan(sheetZ)
})
