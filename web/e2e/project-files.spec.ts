import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { addProject, archiveAll, openDashboard, WORK_DIR } from './helpers'

/**
 * PJT 専用画面の左パネル（イシューグループ_2026_0805_0514 設計§14・§15。
 * テスト計画フェーズ5）。
 *
 * ここでしか確かめられないのは「**画面 → REST → セッションホスト → 実ファイル**」が
 * 1本に繋がっていること。単体テストは応答を作り物にしているので、実物のフォルダを
 * 読めるかどうかについては何も言っていない。
 *
 * 目的は要件のいちばん短い言い方に沿って「**左でパスをコピーして、右の入力欄へ貼る**」
 * が成立すること。
 */

/** 実物を読ませるための小さな PJT。中身が決まっていないと主張が書けない。 */
const PROJECT_DIR = path.join(WORK_DIR, 'adash-e2e-files')
const PLAN = '計画.md'
/** 画面に収まらない長さの文書（`ファイルの中身をスクロールできない` 設計§8）。 */
const LONG = '長い文書.md'
/** 末尾に置く目印。**辿り着けたこと**は、数ではなくこれが見えることで言う。 */
const TAIL = 'いちばん最後の行'
/** 一覧のほうも溢れさせる数。同じ器の中で高さを取り合うので、両方を見る。 */
const FILLERS = 60

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeAll(() => {
  const docs = path.join(PROJECT_DIR, 'MyDocs')
  fs.mkdirSync(docs, { recursive: true })
  fs.writeFileSync(
    path.join(docs, PLAN),
    '# 計画\n\n- [x] 済んだこと\n- [ ] まだのこと\n',
    'utf8',
  )

  // **短いファイルでは症状が出ない**（収まってしまう）ので、材料の長さがそのまま
  // このテストの効き目になる。**上限（`MAX_FILE_BYTES` ＝ 256 KiB）の内側**に収める——
  // 超えると読まずに断られるので、遡りを1度も測れないまま緑になる
  const lines = Array.from({ length: 3_000 }, (_, at) => `- ${at + 1} 行目\n`)
  fs.writeFileSync(
    path.join(docs, LONG),
    `# 長い文書\n\n${lines.join('')}\n## ${TAIL}\n`,
    'utf8',
  )

  for (let at = 0; at < FILLERS; at += 1) {
    fs.writeFileSync(
      path.join(docs, `埋め草-${String(at).padStart(2, '0')}.txt`),
      'x\n',
      'utf8',
    )
  }
})

/**
 * その箱が「遡れる状態か」を実測する。
 *
 * **要素が在ることを見ても分からない。** 高さが決まっていない箱は中身と一緒に伸びるので、
 * `overflow-auto` が付いていても `scrollHeight` と `clientHeight` が並んだままになる
 * （`ファイルの中身をスクロールできない` 設計§2）。jsdom には配置が無いので、
 * これを測れるのは実物のブラウザだけである。
 */
async function scrollState(box: Locator) {
  return box.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  }))
}

/** 下端まで遡らせる。**溢れているだけでは、動くとは限らない**ので実際に動かす。 */
async function scrollToBottom(box: Locator) {
  await box.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
}

/** 溢れていること・実際に動くことを、まとめて見る。 */
async function expectScrollable(box: Locator) {
  await box.evaluate((el) => {
    el.scrollTop = 0
  })
  const before = await scrollState(box)
  expect(
    before.scrollHeight,
    '中身が箱より高いこと（高さが決まっていないと、ここが並ぶ）',
  ).toBeGreaterThan(before.clientHeight)

  await scrollToBottom(box)
  expect((await scrollState(box)).scrollTop, '実際に遡れること').toBeGreaterThan(0)
}

test.afterAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
})

test.afterEach(async ({ page }) => {
  // **開閉の記憶を既定へ戻してから片付ける**（設計§14 で覚える作りにしてある）。
  // 開いたまま終わると、狭い画面ではドロワーが全面を覆い、**このテストの後片付けも
  // 無関係な次のテストも押せなくなる**。ガイドライン「E2E が設定を書き換えるとき」
  // と同じ扱いで、残る側の状態は必ず戻す
  await page.evaluate(() => {
    globalThis.localStorage?.removeItem('agentdashboard.project-files-open')
  })
  await page.reload()
  await archiveAll(page)
})

test('左パネルを開き、ファイルを読み、相対パスをコピーできる', async ({
  page,
}) => {
  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)

  // 枠の余白から PJT 専用画面へ（セッションは1本も起こしていない）
  await group.click({ position: { x: 5, y: 5 } })
  await expect(page).toHaveURL(`/p/local/${encodeURIComponent(PROJECT_DIR)}`)
  await expect(page.getByTestId('group-view')).toBeVisible()

  // セッションが0本でも「+」は出る（設計§14）
  await expect(page.getByTestId('spawn-open')).toBeVisible()

  // ハンバーガーで左パネルが開く
  await expect(page.getByTestId('project-files-panel')).toHaveCount(0)
  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  // 起点は枠のパス。**実物のフォルダが読めている**ことがここで分かる
  await expect(panel.getByTestId('folder-browser')).toHaveAttribute(
    'data-path',
    PROJECT_DIR,
  )
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: PLAN }).click()

  // 整形されて、進捗（チェックボックス）がそのまま読める
  const view = panel.getByTestId('file-view')
  await expect(view).toBeVisible()
  const boxes = view.getByRole('checkbox')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.first()).toBeChecked()
  await expect(boxes.last()).not.toBeChecked()

  // 相対パスと、その基準が出ている
  await expect(view.getByTestId('file-relative-path')).toHaveText(
    `MyDocs/${PLAN}`,
  )
  await expect(view.getByTestId('file-relative-base')).toContainText(PROJECT_DIR)

  // コピーした値が、そのまま貼れる形で入る
  await view.getByTestId('file-copy').click()
  await expect(view.getByTestId('file-copied')).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toBe(`MyDocs/${PLAN}`)

  // 開いたことは覚えている（設計§14）。一覧へ出て戻っても畳まれていない
  await page.goto('/')
  await page.goto(`/p/local/${encodeURIComponent(PROJECT_DIR)}`)
  await expect(page.getByTestId('project-files-panel')).toBeVisible()
})

/**
 * 狭い画面で**ページが横にはみ出さない**こと（設計§28）。
 *
 * # なぜ E2E でしか捕まらないのか
 *
 * jsdom には配置が無いので、単体テストでは幅を測れない。しかもこの壊れ方は
 * **画面が崩れて見えない**——はみ出すのはヘッダの右端で、普通に見ると何も
 * おかしくない。表に出るのは**左パネルのドロワーの右端が画面の外へ出る**形で、
 * モバイルの `fixed` が「広がったページ幅」を基準にするために起きる。
 *
 * 実機のスマホで2度報告された（閉じるボタンとコピーが見えない）。
 */
test('狭い画面で、セッション専用画面が横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  await addProject(page, PROJECT_DIR)

  await page.getByTestId('spawn-open').click()
  await page.getByTestId('spawn-button').click()
  await page.getByTestId('session-tile').first().click()
  await expect(page.getByTestId('session-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  // **ページが画面より広くなっていないこと。** これが破れると、
  // 閉じるボタンもコピーも画面の外へ出る
  const overflows = await page.evaluate(() => {
    const de = document.documentElement
    return de.scrollWidth > de.clientWidth
  })
  expect(overflows).toBe(false)

  // 実際に押せる位置に在ること（幅の計算だけでは「在るが届かない」を見逃す）
  await expect(panel.getByTestId('project-files-close')).toBeInViewport()
  await expect(panel.getByTestId('folder-copy').first()).toBeInViewport()

  // 閉じられること自体もここで見る（狭い画面ではこれが唯一の畳む手）
  await panel.getByTestId('project-files-close').click()
  await expect(panel).toBeHidden()
})

/**
 * ファイルの中身を末尾まで辿れること（`ファイルの中身をスクロールできない` 設計§8）。
 *
 * # なぜ E2E でしか捕まらないのか
 *
 * 壊れていたのは**高さの鎖**で、要素も `overflow-auto` も最初から在った。したがって
 * 「在ること」を見るテストは**壊れている側でも通る**。jsdom には配置が無く
 * `scrollHeight` も `clientHeight` も 0 を返すので、単体では原理的に測れない。
 *
 * しかも症状は「上のほうしか出ない」——**短い文書を開いたときと見分けが付かない**ので、
 * 目で見てもすぐには壊れていると分からない。
 */
test('長い文書を末尾まで辿れる（整形と生テキストの両方）', async ({ page }) => {
  await openDashboard(page)
  const panel = await openLongFile(page)

  // **一覧のほうも遡れること。** 同じ器の中で高さを取り合うので、片方を直した
  // 拍子にもう片方が伸び放題になっていないかを、同じ場所で見る
  await expectScrollable(panel.getByTestId('folder-browser').locator('ul'))

  const body = panel.getByTestId('file-body')

  // 整形して見るとき
  await expect(panel.getByTestId('file-markdown')).toBeVisible()
  await expectScrollable(body)
  // **数だけでは「遡れた」と言い切れない。** 末尾の目印が実際に見えるところまで見る
  await expect(panel.getByRole('heading', { name: TAIL })).toBeInViewport()

  // 生テキストで見るとき（**同じ箱の中で中身だけが入れ替わる**ので、片方だけ直る
  // 形にはならない。ただし「なるはず」で済ませずに、両方で測る）
  await panel.getByTestId('file-toggle-raw').click()
  await expect(panel.getByTestId('file-raw')).toBeVisible()
  await expectScrollable(body)
})

/**
 * 狭い画面（全幅のドロワー）でも遡れること。
 *
 * 高さの決まり方が変わる（`fixed inset-0` になる）ので、広い画面で直っていても
 * こちらが直っている保証は無い。**そして、この画面はスマホで使うほうが本番**である。
 */
test('狭い画面でも、ファイルの中身を遡れる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  const panel = await openLongFile(page)

  const body = panel.getByTestId('file-body')
  await expect(panel.getByTestId('file-markdown')).toBeVisible()
  await expectScrollable(body)
  // 下端が画面の外へ出ていないこと。**在るが届かない**を、位置まで見て否定する
  await expect(panel.getByRole('heading', { name: TAIL })).toBeInViewport()
})

/**
 * 左パネルを開き、`MyDocs` へ入って長い文書を開く（上の2本で共有する手順）。
 *
 * 広い画面と狭い画面で**同じ手順**を通すのが要点——手順が分かれると、
 * 片方でしか踏まない道ができる。
 */
async function openLongFile(page: Page) {
  const group = await addProject(page, PROJECT_DIR)
  await group.click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: LONG }).click()
  await expect(panel.getByTestId('file-view')).toBeVisible()
  return panel
}
