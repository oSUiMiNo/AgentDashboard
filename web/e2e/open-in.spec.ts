import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  addProject,
  archiveAll,
  openDashboard,
  spawnSession,
  WORK_DIR,
} from './helpers'

/**
 * サイドバーからエクスプローラ・VSCode で開く（イシュー「サイドバーにエクスプローラで
 * 開くボタンが欲しい」設計§8・§9-4）。
 *
 * # ここでしか確かめられないこと
 *
 * **押す→口→起こし口の配線が、本番の実行ファイルで通るか。** 単体テストは部品と口を
 * 別々に見ているので、`serve()` が口を生やしているか、画面が正しいパスで POST するかは
 * ここでしか分からない。印が出て、閉じたら読み直しのうちに消えるところまで通す。
 *
 * # 本物は起こさない
 *
 * 4173 は `AGENTDASHBOARD_OPEN_IN=record:.e2e-state/open-in` で起きている。押すと窓を
 * 出す代わりに `requests.jsonl` へ1行書き、VSCode の待ちは `close-<id>` を置くまで続く。
 * 本物を起こすと、開発者の画面に窓が出る。
 *
 * **番号は決め打ちしない。** `id` はサーバのプロセスごとに 1 から数え、E2E の全部の
 * テストで続き番号になる。自分が増やした行から読む。
 */

const PROJECT_DIR = path.join(WORK_DIR, 'adash-e2e-open-in')
const FILE = '計画.md'
const DIR = 'MyDocs'
const RECORD_DIR = path.resolve(import.meta.dirname, '../.e2e-state/open-in')
const REQUESTS = path.join(RECORD_DIR, 'requests.jsonl')
/** 読み直し 3 秒＋待ちの見張り 200ms に余裕を足す */
const 消えるまで = 10_000

type 記録 = { id: number; app: string; kind: string; path: string; wait: boolean }

/** VSCode で開いて、まだ閉じていない待ちの番号。帳面の上限（8）を食い潰さないため */
const 開いた待ち: number[] = []
/** 自分が置いた `close-<id>`。後片付けで自分のものだけ消す */
const 置いた: number[] = []

function 記録を読む(): 記録[] {
  if (!fs.existsSync(REQUESTS)) return []
  const 行たち = fs.readFileSync(REQUESTS, 'utf8').split('\n').filter(Boolean)
  const 読めた: 記録[] = []
  for (const line of 行たち) {
    try {
      読めた.push(JSON.parse(line) as 記録)
    } catch {
      // 追記の最中に読むと最後の行が途中で切れうる。数が合わずに待ちが続くだけにする
      break
    }
  }
  return 読めた
}

/** 押した後に増えた行を、ちょうど1行増えるまで待って返す */
async function 増えた1行(before: number): Promise<記録> {
  await expect
    .poll(() => 記録を読む().length, { message: '記録の起こし口に1行増えること' })
    .toBe(before + 1)
  return 記録を読む()[before]
}

function 閉じる(id: number) {
  fs.writeFileSync(path.join(RECORD_DIR, `close-${id}`), '')
  置いた.push(id)
}

test.beforeAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(PROJECT_DIR, DIR), { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, FILE), '# 計画\n\n- [x] 済んだこと\n')
})

test.afterAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
})

test.afterEach(async ({ page }) => {
  /*
    **待ちを閉じてから、終わったのを口に聞き、それから印を消す。** 先に `close-*` を
    消すと待ちが二度と終わらない。テストが途中で落ちても帳面の 8 を食い潰さない。
  */
  for (const id of 開いた待ち.filter((id) => !置いた.includes(id))) {
    閉じる(id)
  }
  if (開いた待ち.length > 0) {
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/hosts/local/open')
          const view = (await res.json()) as { opened: { path: string }[] }
          return view.opened.filter((entry) => entry.path.startsWith(PROJECT_DIR)).length
        },
        { message: '自分が開いた待ちが全部終わること', timeout: 消えるまで },
      )
      .toBe(0)
  }
  for (const id of 置いた) {
    fs.rmSync(path.join(RECORD_DIR, `close-${id}`), { force: true })
  }
  開いた待ち.length = 0
  置いた.length = 0

  await page.evaluate(() => {
    globalThis.localStorage?.removeItem('agentdashboard.project-files-open')
    globalThis.localStorage?.removeItem('agentdashboard.project-files-place')
  })
  await page.reload()
  await archiveAll(page)
})

/**
 * サイドバーを**開いた状態にする**。開け閉めは PJT ごとに覚えられて画面をまたいで戻るので、
 * 素で押すと既に開いていたものを畳んでしまう。
 */
async function サイドバーを開いた状態にする(page: Page): Promise<Locator> {
  const toggle = page.getByTestId('project-files-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()
  return panel
}

/** PJT 専用画面でサイドバーを開いて返す。セッションは1本も要らない */
async function openSidebar(page: Page): Promise<Locator> {
  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)

  await group.dblclick({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()

  const panel = await サイドバーを開いた状態にする(page)
  await expect(panel.getByTestId('folder-browser')).toHaveAttribute('data-path', PROJECT_DIR)
  // 行が出揃うまで待つ（`data-path` は読み終えた印ではない）
  await expect(panel.getByTestId('folder-entry')).toHaveCount(2)
  return panel
}

/** その行の器（メニューを掛けてあるのは `li` のほう） */
function 行の器(panel: Locator, name: string): Locator {
  return panel
    .getByTestId('folder-entry')
    .filter({ hasText: name })
    .locator('xpath=ancestor::li[1]')
}

async function 右クリックで開く(page: Page, 器: Locator) {
  await expect(page.getByTestId('folder-menu')).toHaveCount(0)
  await 器.click({ button: 'right' })
  await expect(page.getByTestId('folder-menu')).toBeVisible()
}

test('PJT 専用画面のサイドバーで、パンくずの行に2つのボタンが出る', async ({ page }) => {
  const panel = await openSidebar(page)

  const 器 = panel.getByTestId('folder-crumbs-row').getByTestId('open-in-buttons')
  await expect(器).toBeVisible()
  await expect(器.getByTestId('open-in-explorer')).toBeEnabled()
  await expect(器.getByTestId('open-in-vscode')).toBeEnabled()
  // 何を開くのかを言っていること
  await expect(器.getByTestId('open-in-explorer')).toHaveAttribute(
    'title',
    /エクスプローラで開く：adash-e2e-open-in/,
  )
})

test('エクスプローラのボタンを押すと、PJT のルートを開く頼みが1行記録される', async ({
  page,
}) => {
  const panel = await openSidebar(page)

  const before = 記録を読む().length
  await panel.getByTestId('open-in-explorer').click()
  const 行 = await 増えた1行(before)

  // **行の中身まで読む。** 数だけだと、起こし口が別のものを書いても通る
  expect(行).toMatchObject({ app: 'explorer', kind: 'dir', path: PROJECT_DIR, wait: false })
})

test('ファイルを右クリックして VSCode で開くと、行に印が付き、閉じると消える', async ({
  page,
}) => {
  const panel = await openSidebar(page)
  const 器 = 行の器(panel, FILE)

  await 右クリックで開く(page, 器)
  const 項目 = page.getByTestId('folder-menu-open-vscode')
  await expect(項目).toHaveText('VSCode で開く')
  const before = 記録を読む().length
  await 項目.click()

  const 行 = await 増えた1行(before)
  expect(行).toMatchObject({
    app: 'vscode',
    kind: 'file',
    path: path.join(PROJECT_DIR, FILE),
    wait: true,
  })
  開いた待ち.push(行.id)

  // POST の答えで印がすぐ出る。**在るほうを先に見てから**、他の行に無いことを見る
  await expect(器.getByTestId('folder-opened-mark')).toBeVisible()
  await expect(行の器(panel, DIR).getByTestId('folder-opened-mark')).toHaveCount(0)

  await 右クリックで開く(page, 器)
  await expect(page.getByTestId('folder-menu-open-vscode')).toHaveText(
    'VSCode で開いています（前に出す）',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('folder-menu')).toHaveCount(0)

  閉じる(行.id)
  await expect(器.getByTestId('folder-opened-mark')).toHaveCount(0, { timeout: 消えるまで })

  // PJT のルートを VSCode で開くと、ボタンが開いている印になり、閉じると戻る
  const vscode = panel.getByTestId('open-in-vscode')
  const before2 = 記録を読む().length
  await vscode.click()
  const 行2 = await 増えた1行(before2)
  expect(行2).toMatchObject({ app: 'vscode', kind: 'dir', path: PROJECT_DIR, wait: true })
  開いた待ち.push(行2.id)
  await expect(vscode).toHaveAttribute('data-open', 'true')

  閉じる(行2.id)
  await expect(vscode).not.toHaveAttribute('data-open', 'true', { timeout: 消えるまで })
})

test('フォルダを右クリックしてエクスプローラで開くと、そのフォルダの頼みが記録される', async ({
  page,
}) => {
  const panel = await openSidebar(page)

  await 右クリックで開く(page, 行の器(panel, DIR))
  const before = 記録を読む().length
  await page.getByTestId('folder-menu-open-explorer').click()

  const 行 = await 増えた1行(before)
  expect(行).toMatchObject({
    app: 'explorer',
    kind: 'dir',
    path: path.join(PROJECT_DIR, DIR),
    wait: false,
  })
})

test('セッション専用画面のサイドバーにも、同じボタンが出て押せる', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page, PROJECT_DIR)
  await tile.dblclick()
  await expect(page.getByTestId('session-view')).toBeVisible()

  const panel = await サイドバーを開いた状態にする(page)
  await expect(panel.getByTestId('folder-browser')).toHaveAttribute('data-path', PROJECT_DIR)

  await expect(panel.getByTestId('open-in-buttons')).toBeVisible()
  const before = 記録を読む().length
  await panel.getByTestId('open-in-explorer').click()

  // この画面からも口まで届くこと（片方だけに実装して入れたと言わない）
  const 行 = await 増えた1行(before)
  expect(行).toMatchObject({ app: 'explorer', kind: 'dir', path: PROJECT_DIR })
})

test('PJT の追加シートのフォルダ一覧には、ボタンも右クリックの項目も出ない', async ({
  page,
}) => {
  // **先に、出る条件が揃っていることを見る。** 否定の検査は原因が無いと空になる
  const サイドバー = await openSidebar(page)
  await expect(サイドバー.getByTestId('open-in-buttons')).toBeVisible()

  await openDashboard(page)
  await page.getByTestId('project-add-open').click()
  const sheet = page.getByTestId('project-add-sheet')
  await expect(sheet).toBeVisible()
  const 一覧 = sheet.getByTestId('folder-browser')
  await expect(一覧).toBeVisible()
  await expect(一覧.getByTestId('folder-entry').first()).toBeVisible()

  await expect(sheet.getByTestId('open-in-buttons')).toHaveCount(0)
  await expect(sheet.getByTestId('folder-crumbs-row')).toHaveCount(0)

  const 最初の行 = 一覧.getByTestId('folder-entry').first().locator('xpath=ancestor::li[1]')
  await 右クリックで開く(page, 最初の行)
  // 在るはずの項目を先に見てから、無いはずの項目を数える
  await expect(page.getByTestId('folder-menu-copy-abs')).toBeVisible()
  await expect(page.getByTestId('folder-menu-open-explorer')).toHaveCount(0)
  await expect(page.getByTestId('folder-menu-open-vscode')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('project-add-close').click()
  await expect(sheet).toHaveCount(0)
})
