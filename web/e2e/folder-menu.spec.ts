import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  addProject,
  archiveAll,
  holdTouch,
  openDashboard,
  WORK_DIR,
} from './helpers'

/**
 * サイドバーの行の右クリックメニュー（イシュー「サイドバーのファイルを、中クリックで
 * ブラウザの新しいタブに開く」の追補・2026-09-08）。
 *
 * # ここでしか確かめられないこと
 *
 * **指で長押ししたときにメニューが出るか。** これが本題である——利用者の要望は
 * 「**スマホでも同じことができるように**」で、**中クリックも Ctrl＋クリックも
 * スマホには無い**。つまりメニューは2本目の道ではなく、**指で触る画面にとっては
 * 唯一の道**である。
 *
 * `jsdom` では確かめられない。長押しは `radix-ui` が `pointerdown` から 700ms
 * 数えて開く作りで、**`pointerType` が `mouse` でないことが条件**——本物の
 * タッチイベントが要る。`hasTouch: true` を立てた実ブラウザでだけ測れる。
 *
 * **単体テストは「メニューの中身」を見ており、こちらは「メニューが出るか」を見る。**
 * 役割が違うので、どちらも要る。
 *
 * # 動かすと落ちる
 *
 * `radix-ui` は **`pointermove` が1回来ただけで長押しを取り消す**（遊びが無い）。
 * だから [`holdTouch`] は `touchStart` → 待つ → `touchEnd` だけを送り、
 * **途中で動かさない**。実機の指は必ず少し動くので、**ここが通っても実機で
 * 出ないことはありうる**——そちらはテスト計画 6-14 で踏む。
 */

/** 実物を読ませるための小さな PJT。 */
const PROJECT_DIR = path.join(WORK_DIR, 'adash-e2e-folder-menu')
const FILE = '計画.md'
const DIR = 'MyDocs'

/** `radix-ui` の長押しは 700ms。**余裕を持って超えさせる**（境目を測るテストではない） */
const 長押し = 1000

test.beforeAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(PROJECT_DIR, DIR), { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, FILE), '# 計画\n\n- [x] 済んだこと\n')
})

test.afterAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
})

test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    globalThis.localStorage?.removeItem('agentdashboard.project-files-open')
    globalThis.localStorage?.removeItem('agentdashboard.project-files-place')
  })
  await page.reload()
  await archiveAll(page)
})

/** サイドバーを開いて返す。セッションは1本も要らない。 */
async function openSidebar(page: Page): Promise<Locator> {
  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)

  await group.dblclick({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('folder-browser')).toHaveAttribute(
    'data-path',
    PROJECT_DIR,
  )
  /*
    **行が出揃うまで待つ。** `data-path` は「どこを見ているか」であって「読み終えた
    か」ではない。ここを待たずに長押しへ進むと、**押した瞬間にまだ行が無く**、
    たまに落ちる（実際に揺れた）。
  */
  await expect(panel.getByTestId('folder-entry')).toHaveCount(2)
  return panel
}

/** 長押しでメニューを開く。**開く前に閉じていることを確かめる**——出たままだと何も測れない */
async function 長押しで開く(page: Page, 器: Locator) {
  await expect(page.getByTestId('folder-menu')).toHaveCount(0)
  await holdTouch(page, 器, { holdMs: 長押し })
  await expect(page.getByTestId('folder-menu')).toBeVisible()
}

/** その行の器（メニューを掛けてあるのは `li` のほう）。 */
function 行の器(panel: Locator, name: string): Locator {
  return panel
    .getByTestId('folder-entry')
    .filter({ hasText: name })
    .locator('xpath=ancestor::li[1]')
}

test.describe('指で触る画面', () => {
  test.use({ hasTouch: true })

  test('ファイルを長押しすると、メニューが出て新しいタブへ開ける', async ({
    page,
  }) => {
    const panel = await openSidebar(page)

    await 長押しで開く(page, 行の器(panel, FILE))

    const 項目 = page.getByTestId('folder-menu-open-tab')
    await expect(項目).toBeVisible()

    // 行き先は中クリックと同じ場所。**道によって結果が違ってはいけない**
    const href = await 項目.getAttribute('href')
    expect(href).toContain('/api/hosts/local/file')
    expect(href).toContain(encodeURIComponent(`${PROJECT_DIR}/${FILE}`))
    expect(href).toContain('as=raw')
    await expect(項目).toHaveAttribute('target', '_blank')
  })

  test('押すと、本当に新しいタブが開いて中身が出る', async ({ page, context }) => {
    const panel = await openSidebar(page)
    await 長押しで開く(page, 行の器(panel, FILE))
    await expect(page.getByTestId('folder-menu-open-tab')).toBeVisible()

    // **「リンクが在る」ことと「開く」ことは別。** 実際に開かせて中身まで見る
    const [新しいタブ] = await Promise.all([
      context.waitForEvent('page'),
      page.getByTestId('folder-menu-open-tab').click(),
    ])
    await 新しいタブ.waitForLoadState()
    expect(await 新しいタブ.locator('body').innerText()).toContain('済んだこと')
    await 新しいタブ.close()
    // **元のタブへ戻す。** 戻さないと、次のテストの長押しが届かないことがある
    await page.bringToFront()
  })

  test('フォルダを長押ししても、開く項目は出ない（行き先の URL が無い）', async ({
    page,
  }) => {
    const panel = await openSidebar(page)

    await 長押しで開く(page, 行の器(panel, DIR))

    // メニュー自体は出る（コピーは使える）
    await expect(page.getByTestId('folder-menu-copy-abs')).toBeVisible()
    await expect(page.getByTestId('folder-menu-open-tab')).toHaveCount(0)
  })
})
