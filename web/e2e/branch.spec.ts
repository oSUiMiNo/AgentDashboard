import { expect, test } from '@playwright/test'
import {
  addProject,
  archiveAll,
  fireHook,
  openDashboard,
  openSession,
  spawnSession,
  WORK_DIR,
} from './helpers'

/**
 * 枝分かれ（ブランチ設計§7。テスト計画フェーズ5）。
 *
 * **実物のブラウザでしか見られないものに絞る。** jsdom は配置も色の解決もしないので、
 * 「PJT 専用画面にだけ出る」「押している間は押せない」「枝が元の左隣に並ぶ」は
 * ここでしか通しで確かめられない。
 *
 * 相手は擬似 claude なので課金しない。**擬似は `/branch` を教えてある**（フェーズ1）
 * ——受け取ると名乗る CLI 側のIDだけを張り替え、席はそのまま生き続ける。
 */

/**
 * 枠の宛先を控える。**一覧に居るうちに呼ぶこと**——セッション専用画面には枠が
 * 描かれていないので、あちらから引くと空の枠を掴む（実際に踏んだ）。
 */
async function 枠を控える(page: import('@playwright/test').Page) {
  const group = await addProject(page, WORK_DIR)
  return {
    host: (await group.getAttribute('data-host')) ?? '',
    project: (await group.getAttribute('data-project')) ?? '',
  }
}

/** 控えた宛先で PJT 専用画面を開く。 */
async function PJT専用画面へ(
  page: import('@playwright/test').Page,
  枠: { host: string; project: string },
) {
  await page.goto(`/p/${encodeURIComponent(枠.host)}/${encodeURIComponent(枠.project)}`)
}

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('横並びから押すと、枝が元の左隣に並ぶ', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')
  const 枠 = await 枠を控える(page)

  // 入力待ちへ倒す。**起動直後は押せない**（§3-4）ので、ここを飛ばすと断られる。
  // **応答も載せる**——本物の CLI は1ターンも会話していない席の `/branch` を断るので、
  // 段取り役も送る前に断る（`No conversation to branch`。2026-09-05 実測）
  await openSession(page, tile)
  await fireHook(page, 'Stop', '{"last_assistant_message":"はい"}')

  await PJT専用画面へ(page, 枠)
  const ボタン = page.getByTestId('branch-card')
  await expect(ボタン).toBeVisible()
  await expect(ボタン).toBeEnabled({ timeout: 30_000 })
  await ボタン.click()

  // 段取りが終わると区画が2つになる（枝＋呼び戻した元）
  await expect(page.getByTestId('session-view')).toHaveCount(2, { timeout: 60_000 })

  // **左が枝、右が元。** 並べ替えまで済んで初めてこの順になる（§3-3）
  const 並び = page.getByTestId('session-view')
  await expect(並び.nth(0)).toHaveAttribute('data-card-id', cardId ?? '')

  // 枝の側にだけ札が出る（§7-5）
  await expect(並び.nth(0).getByTestId('branch-badge')).toBeVisible()
  await expect(並び.nth(1).getByTestId('branch-badge')).toHaveCount(0)
})

test('セッション専用画面には出ない', async ({ page }) => {
  // §7-1。あちらには「左隣」が無いので、押しても置き先が無い
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  await fireHook(page, 'Stop', '{"last_assistant_message":"はい"}')

  await expect(page.getByTestId('session-view')).toBeVisible()
  await expect(page.getByTestId('branch-card')).toHaveCount(0)
})

test('起動直後は押せず、理由が読める', async ({ page }) => {
  // §3-4。**`/branch` は指示として送られる**ので、受け付けられない状態で押すと
  // 入力欄へ積まれ、しばらく後の別の地点で分かれてしまう
  await openDashboard(page)
  await spawnSession(page)
  const 枠 = await 枠を控える(page)
  await PJT専用画面へ(page, 枠)

  const ボタン = page.getByTestId('branch-card')
  await expect(ボタン).toBeVisible()
  await expect(ボタン).toBeDisabled()
  await expect(ボタン).toHaveAttribute('title', /起動中|作業中|状態が分からない|1ターンも会話/)
})

test('操作列は、枝分かれを足しても2行のまま', async ({ page }) => {
  // **罠2**（§10-2）。折り返した瞬間に、行数を数えている単体4箇所が落ちる。
  // 実物のブラウザでは**溢れる**という別の壊れ方をしうるので、ここでも見る
  await openDashboard(page)
  await spawnSession(page)
  const 枠 = await 枠を控える(page)
  await PJT専用画面へ(page, 枠)

  const 操作列 = page.getByTestId('session-ops').first()
  await expect(操作列.locator('[data-row]')).toHaveCount(2)

  // 横に溢れていないこと（`flex-wrap` を持たないので、溢れると外へはみ出す）
  const はみ出し = await 操作列.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(はみ出し, '操作列が横へ溢れている').toBeLessThanOrEqual(1)
})
