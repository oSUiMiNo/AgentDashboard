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

const 長い一覧の数 = 60

test.beforeAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(PROJECT_DIR, DIR), { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, FILE), '# 計画\n\n- [x] 済んだこと\n')
  for (let i = 0; i < 長い一覧の数; i++) {
    fs.writeFileSync(path.join(PROJECT_DIR, DIR, `f_${String(i).padStart(2, '0')}.txt`), `${i}\n`)
  }
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
    /*
      **`innerText()` を一発で読まない。** `waitForEvent('page')` は新しいタブがまだ
      `about:blank` の段でも解決しうる。そこで読むと空文字を掴んで落ちる——しかも
      **たまにしか落ちない**ので、原因からいちばん遠いところに出る。
      再試行を持つ `toContainText` で待つ（`project-files.spec.ts` と同じ形）。
    */
    await expect(新しいタブ.locator('body')).toContainText('済んだこと')
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

const PJT_NAME = path.basename(PROJECT_DIR)
const 起点より上 = path.dirname(PROJECT_DIR)

function パンくず(panel: Locator, name: string): Locator {
  return panel.getByTestId('folder-crumb').filter({ hasText: new RegExp(`^${name}$`) })
}

function 横の答え(段: Locator): Locator {
  return 段.locator('xpath=..').getByTestId('folder-crumb-copy-state')
}

async function MyDocsへ入る(panel: Locator) {
  await panel.getByTestId('folder-entry').filter({ hasText: DIR }).click()
  await expect(panel.getByTestId('folder-browser')).toHaveAttribute(
    'data-path',
    path.join(PROJECT_DIR, DIR),
  )
  await expect(panel.getByTestId('folder-entry')).toHaveCount(長い一覧の数)
}

async function 止まった真ん中(page: Page, target: Locator): Promise<{ x: number; y: number }> {
  let 前 = await target.boundingBox()
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(50)
    const 今 = await target.boundingBox()
    if (前 && 今 && 前.x === 今.x && 前.y === 今.y && 前.width === 今.width && 前.height === 今.height) {
      return { x: 今.x + 今.width / 2, y: 今.y + 今.height / 2 }
    }
    前 = 今
  }
  throw new Error('位置が落ち着きません')
}

async function 写したもの(page: Page): Promise<string> {
  return await page.evaluate(() => navigator.clipboard.readText())
}

test.describe('マウスで右クリック（パンくずと余白・追加の要望 2026-11-23）', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('パンくずのフォルダ名を右クリックすると、そのフォルダを相手にメニューが出て、移動はしない', async ({
    page,
  }) => {
    const panel = await openSidebar(page)
    await MyDocsへ入る(panel)

    const 段 = パンくず(panel, PJT_NAME)
    await 段.click({ button: 'right' })
    await expect(page.getByTestId('folder-menu')).toHaveCount(1)
    await expect(page.getByTestId('folder-name-full')).toHaveText(PJT_NAME)
    await expect(page.getByTestId('folder-menu-copy-name')).toHaveText('フォルダ名をコピー')
    await page.getByTestId('folder-menu-copy-abs').click()

    await expect(横の答え(段)).toHaveText('コピーしました')
    expect(await 写したもの(page)).toBe(PROJECT_DIR)
    await expect(panel.getByTestId('folder-crumb-copy-state')).toHaveCount(1)
    await expect(panel.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      path.join(PROJECT_DIR, DIR),
    )
  })

  test('「…」は押しても移動せず、本物のマウスで右クリックすると起点より上のフォルダのメニューが出る', async ({
    page,
  }) => {
    const panel = await openSidebar(page)
    const 点 = panel.getByTestId('folder-crumb').first()
    await expect(点).toHaveText('…')
    await expect(点).toHaveAttribute('title', `起点より上：${起点より上}`)
    const 真ん中 = await 止まった真ん中(page, 点)

    await page.mouse.click(真ん中.x, 真ん中.y)
    await page.waitForTimeout(300)
    await expect(page.getByTestId('folder-menu')).toHaveCount(0)
    await expect(panel.getByTestId('folder-browser')).toHaveAttribute('data-path', PROJECT_DIR)

    await page.mouse.click(真ん中.x, 真ん中.y, { button: 'right' })
    await expect(page.getByTestId('folder-menu')).toHaveCount(1)
    await expect(page.getByTestId('folder-name-full')).toHaveText(path.basename(起点より上))
    await page.getByTestId('folder-menu-copy-name').click()

    await expect(横の答え(点)).toHaveText('コピーしました')
    expect(await 写したもの(page)).toBe(path.basename(起点より上))
    await expect(panel.getByTestId('folder-browser')).toHaveAttribute('data-path', PROJECT_DIR)
  })

  test('一覧の余白を右クリックすると、いまのフォルダを相手にメニューが出て、答えはパンくずの末尾の横に出る', async ({
    page,
  }) => {
    const panel = await openSidebar(page)

    await panel.getByTestId('folder-blank').click({ button: 'right' })
    await expect(page.getByTestId('folder-menu')).toHaveCount(1)
    await expect(page.getByTestId('folder-name-full')).toHaveText(PJT_NAME)
    await page.getByTestId('folder-menu-copy-abs').click()

    await expect(横の答え(パンくず(panel, PJT_NAME))).toHaveText('コピーしました')
    expect(await 写したもの(page)).toBe(PROJECT_DIR)
  })

  test('余白の行を足しても、行の高さと並びは変わらない（短い一覧でも長い一覧でも）', async ({
    page,
  }) => {
    const panel = await openSidebar(page)
    const 一覧 = panel.getByTestId('folder-browser').locator('ul')

    const 測る = () =>
      一覧.evaluate((ul) => {
        ul.scrollTop = 0
        const 器 = ul.getBoundingClientRect()
        const 行 = Array.from(ul.children)
          .filter((li) => li.getAttribute('data-testid') !== 'folder-blank')
          .map((li) => {
            const r = li.getBoundingClientRect()
            return [r.left - 器.left, r.top - 器.top, r.width, r.height].map((v) => Math.round(v * 100) / 100)
          })
        const blank = ul.querySelector<HTMLElement>('[data-testid="folder-blank"]')
        const 余白 = blank?.getBoundingClientRect()
        const 最後 = 行.at(-1)
        return {
          行,
          余白の高さ: 余白?.height ?? -1,
          余白の上と最後の行の下: 余白 && 最後 ? Math.abs(余白.top - 器.top - (最後[1] + 最後[3])) : -1,
          中身の高さ: ul.scrollHeight,
          器の高さ: ul.clientHeight,
        }
      })
    const 余白なしで測る = () =>
      一覧.evaluate((ul) => {
        const blank = ul.querySelector<HTMLElement>('[data-testid="folder-blank"]')
        ul.style.display = 'block'
        if (blank) blank.style.display = 'none'
        ul.scrollTop = 0
        const 器 = ul.getBoundingClientRect()
        const 行 = Array.from(ul.children)
          .filter((li) => li.getAttribute('data-testid') !== 'folder-blank')
          .map((li) => {
            const r = li.getBoundingClientRect()
            return [r.left - 器.left, r.top - 器.top, r.width, r.height].map((v) => Math.round(v * 100) / 100)
          })
        ul.style.display = ''
        if (blank) blank.style.display = ''
        return 行
      })

    const 短い = await 測る()
    expect(短い.行).toHaveLength(2)
    expect(短い.行).toEqual(await 余白なしで測る())
    expect(短い.余白の上と最後の行の下).toBeLessThan(0.5)
    expect(短い.中身の高さ).toBe(短い.器の高さ)
    expect(短い.余白の高さ).toBeGreaterThan(100)

    await MyDocsへ入る(panel)
    const 長い = await 測る()
    expect(長い.行).toHaveLength(長い一覧の数)
    expect(長い.行).toEqual(await 余白なしで測る())
    expect(長い.余白の上と最後の行の下).toBeLessThan(0.5)
    expect(長い.中身の高さ).toBeGreaterThan(長い.器の高さ)
    expect(長い.余白の高さ).toBeGreaterThanOrEqual(31.5)
    expect(長い.余白の高さ).toBeLessThanOrEqual(32.5)
  })
})

test.describe('指で触る画面（パンくずと余白・追加の要望 2026-11-23）', () => {
  test.use({ hasTouch: true })

  test('余白を長押しすると、いまのフォルダのメニューが1つだけ出る', async ({ page }) => {
    const panel = await openSidebar(page)

    await 長押しで開く(page, panel.getByTestId('folder-blank'))

    await expect(page.getByTestId('folder-menu')).toHaveCount(1)
    await expect(page.getByTestId('folder-name-full')).toHaveText(PJT_NAME)
  })

  test('行を長押ししても、行のメニューが1つだけ出る（余白のメニューは重ならない）', async ({
    page,
  }) => {
    const panel = await openSidebar(page)

    await 長押しで開く(page, 行の器(panel, DIR))

    await expect(page.getByTestId('folder-menu')).toHaveCount(1)
    await expect(page.getByTestId('folder-name-full')).toHaveText(DIR)
  })

  test('パンくずのフォルダ名を長押しすると、メニューが出て、移動はしない', async ({ page }) => {
    const panel = await openSidebar(page)
    await MyDocsへ入る(panel)

    await 長押しで開く(page, パンくず(panel, PJT_NAME))

    await expect(page.getByTestId('folder-menu')).toHaveCount(1)
    await expect(page.getByTestId('folder-name-full')).toHaveText(PJT_NAME)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('folder-menu')).toHaveCount(0)
    await page.waitForTimeout(500)
    await expect(panel.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      path.join(PROJECT_DIR, DIR),
    )
  })
})
