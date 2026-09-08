import { expect, test } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  spawnSession,
} from './helpers'

/**
 * 入力欄のスラッシュコマンド候補の通し確認（設計§12・テスト計画フェーズ7）。
 *
 * 集める（`lib/slashCandidates.ts`）→ 出す（`SlashMenu.tsx`）→ 押す（`Composer.tsx`）が
 * **実物のブラウザで繋がっていること**を見る。単体テストは3層それぞれを別々に見て
 * いるので、**配線が抜けていても全部緑になる**。
 *
 * # 題材は組み込みの表から採る
 *
 * この土台（`chromium`・4173）は **`HOME` を上書きしていない**ので、利用者コマンドと
 * スキルは**開発機の中身**が出る（実測106件）。機械ごとに変わるものを題材にすると
 * 他所で落ちるので、**16件の組み込み**（`lib/builtinCommands.ts`）だけを名指しする。
 *
 * PC ごとに混ざらないことは**ここでは見られない**（PC が1台しか居ない）。
 * あれは `fleet.spec.ts` の担当で、**このファイルへ書くと `chromium-fleet` に載らず、
 * 落ちるのではなく静かに0件になる**（`playwright.config.ts` はファイル名の正規表現で
 * 振り分けている）。
 */

/** 一覧に出る行。 */
const 候補の行 = '[data-testid="slash-menu"] [role="option"]'

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('/ を打つと候補が出て、8行までしか出さない', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await expect(page.getByTestId('slash-menu')).toBeHidden()
  await page.getByTestId('composer-input').fill('/')

  await expect(page.getByTestId('slash-menu')).toBeVisible()
  // **組み込みだけで16件ある**ので、この機械の中身によらず必ず溢れる（`DESIGN.md` §15.2）
  await expect(page.locator(候補の行)).toHaveCount(8)
  // 溢れたことを隠さない（設計§6-4）
  await expect(page.getByTestId('slash-menu-more')).toBeVisible()
  // **一覧が全部でないことは常に言う**（要件の完了条件）
  await expect(page.getByTestId('slash-menu-caveat')).toContainText('MCP')
})

test('当たるものが無くても黙って消えず、そのまま送れると言う', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('composer-input').fill('/存在しないコマンド')

  await expect(page.locator(候補の行)).toHaveCount(0)
  await expect(page.getByTestId('slash-menu-empty')).toContainText('そのまま送れます')
})

test('押して選ぶと入力欄に入り、そのまま送れて PTY まで届く', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const input = page.getByTestId('composer-input')
  await input.fill('/rewind')
  // **`pickOption` は使わない。** あれは先に `picker.click()` する作りで、
  // この一覧は打つと勝手に出るので、その一押しが**入力欄から焦点を外して閉じる**
  await page.locator(`${候補の行}[data-value="rewind"]`).click()

  await expect(input).toHaveValue('/rewind')

  // **候補に出るだけで送れないのは、無いより悪い。** 実際に届くところまで見る
  await page.keyboard.press('Control+Enter')
  await expectTerminalToContain(page, '[fake-claude] received: /rewind')
})

test('文の途中で `/` を打っても出て、決めても前の文が消えない', async ({
  page,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const input = page.getByTestId('composer-input')
  // **一行目の頭に限らない**（2026-09-08 の修整）。名前を思い出す道具として要る
  await input.fill('手順を踏んでから /rew')
  await expect(page.getByTestId('slash-menu')).toBeVisible()

  await page.locator(`${候補の行}[data-value="rewind"]`).click()
  // **語のぶんだけを差し替える。** 先頭から置き換えると前の文が丸ごと消える
  await expect(input).toHaveValue('手順を踏んでから /rewind')
})

test('URL を貼っている間は候補が出ない', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 語の頭の `/` だけを見る。どこでも出すと、URL を貼るたびに一覧が被さる
  await page.getByTestId('composer-input').fill('参照：https://example.com/rewind')
  await expect(page.getByTestId('slash-menu')).toBeHidden()
})

test('候補が出ても、入力欄の器の高さが変わらない', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const composer = page.getByTestId('composer')
  const 出す前 = (await composer.boundingBox())!.height

  await page.getByTestId('composer-input').fill('/')
  await expect(page.getByTestId('slash-menu')).toBeVisible()

  // **器が伸びると「端末の大きさが変わる → ResizeObserver → fit → TUI 再描画」の
  // 輪に入る**（設計§6-1）。一覧は `absolute` で器の外へ重ねるので、1px も動かない
  expect((await composer.boundingBox())!.height).toBe(出す前)
})

test('Esc で閉じる（設計§7 の表）', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('composer-input').fill('/')
  await expect(page.getByTestId('slash-menu')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('slash-menu')).toBeHidden()
  // **閉じても打ったものは消えない。** 消すと打ち直しになる
  await expect(page.getByTestId('composer-input')).toHaveValue('/')
})

test.describe('指で触る端末', () => {
  // **スマホの実寸で見る**（`DESIGN.md` の Mobile / Touch）。`hasTouch` が
  // `(pointer: coarse)` と `(hover: none)` の両方を立てる
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test('候補が窓の中に収まっている', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    await page.getByTestId('composer-input').fill('/')
    await expect(page.getByTestId('slash-menu')).toBeVisible()

    // **`toBeVisible()` では足りない**（設計§12）。あれは窓の外に居ても通るので、
    // 「収まっている」の主張には**座標の数**が要る。
    // **見た目の主張は2フェーズ連続で素通りしている**ので、ここは数で見る
    const box = (await page.getByTestId('slash-menu').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(844)
  })

  test('行の高さが、指で押せる床（48px）を割らない', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    await page.getByTestId('composer-input').fill('/')
    await expect(page.getByTestId('slash-menu')).toBeVisible()

    // **フェーズ2はここが 43px だった**（説明の無い候補は 28px）。機械のテストは
    // 全部緑のままで、焼いて測って初めて出た。**数で床を見張る**
    const 行 = page.locator(候補の行)
    for (let i = 0; i < (await 行.count()); i += 1) {
      const box = (await 行.nth(i).boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(48)
    }
  })

  test('指で押して選べる', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    const input = page.getByTestId('composer-input')
    await input.fill('/rewind')

    // **矢印キーを使わない。** スマホには方向キーが無いので、指だけで届くことが要る
    await page.locator(`${候補の行}[data-value="rewind"]`).tap()

    await expect(input).toHaveValue('/rewind')
  })
})
