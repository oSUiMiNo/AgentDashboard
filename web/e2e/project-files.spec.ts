import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
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

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeAll(() => {
  fs.mkdirSync(path.join(PROJECT_DIR, 'MyDocs'), { recursive: true })
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'MyDocs', PLAN),
    '# 計画\n\n- [x] 済んだこと\n- [ ] まだのこと\n',
    'utf8',
  )
})

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
