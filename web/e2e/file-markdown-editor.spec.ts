import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { addProject, archiveAll, openDashboard, spawnSession, WORK_DIR } from './helpers'

const FILE = '編集する文書.md'
const SOURCE = '---\ntitle: 合成した試験文書\n---\n\n見出し\n=======\n\n本文の目印\n\n<br/>\n<br/>\n\n- [ ] 確認する\n\n| 項目 | 状態 |\n| --- | --- |\n| 元の値 | 未確認 |\n\n```typescript\nconst value = 1\nconsole.log(value)\n```\n\n<!-- 変更しないコメント -->\n'
let projectDir = ''
let file = ''
let pageErrors: string[] = []

test.beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(WORK_DIR, 'adash-e2e-markdown-'))
  fs.mkdirSync(path.join(projectDir, 'MyDocs'))
  file = path.join(projectDir, 'MyDocs', FILE)
})

test.beforeEach(({ page }) => {
  fs.writeFileSync(file, SOURCE, 'utf8')
  pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
})

test.afterEach(async ({ page }) => {
  await archiveAll(page)
  expect(pageErrors).toEqual([])
})

test.afterAll(() => {
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true })
})

async function openFile(page: Page, single = false) {
  await openDashboard(page)
  if (single) {
    const tile = await spawnSession(page, projectDir)
    const id = await tile.getAttribute('data-card-id')
    expect(id).toBeTruthy()
    await page.goto(`/s/${id}`)
  } else {
    const project = await addProject(page, projectDir)
    await project.dblclick({ position: { x: 5, y: 5 } })
  }
  await page.getByTestId('project-files-toggle').click()
  const sidebar = page.getByTestId('project-files-panel')
  await sidebar.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await sidebar.getByTestId('folder-entry').filter({ hasText: FILE }).click()
  /*
    狭い窓ではサイドバーが本文へ被さり、帯の `project-files-toggle` はその下に隠れて
    押せない（`Sidebar.tsx` の設計）。狭い窓向けの専用閉じるボタン
    `project-files-close` があればそちらを押し、無ければ（＝広い窓で被さっていない）
    従来どおり `project-files-toggle` で閉じる。
  */
  const closeButton = page.getByTestId('project-files-close')
  if (await closeButton.isVisible()) {
    await closeButton.click()
  } else if (await sidebar.isVisible()) {
    await page.getByTestId('project-files-toggle').click()
  }
  const editor = page.getByTestId('file-markdown-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  return editor
}

test('ブロックとソースを往復して保存した内容が実ファイルへ残る', async ({ page }) => {
  const editor = await openFile(page)
  const paragraph = editor.locator('p').filter({ hasText: '本文の目印' }).first()
  await paragraph.click()
  await expect(editor).not.toHaveClass(/virtual-cursor-enabled/)
  await expect(editor.locator('.prosemirror-virtual-cursor')).toHaveCount(0)
  await expect(editor).toHaveCSS('caret-color', 'rgb(61, 217, 230)')
  await page.keyboard.press('End')
  await page.keyboard.insertText('・追記')
  await expect(page.getByTestId('file-save')).toBeEnabled()
  expect(fs.readFileSync(file, 'utf8')).toBe(SOURCE)

  await page.getByTestId('file-toggle-mode').click()
  const source = page.getByTestId('file-editor')
  await expect(source).toBeVisible()
  expect((await source.boundingBox())?.height).toBeGreaterThan(100)
  expect(await source.inputValue()).toContain('本文の目印・追記')
  await source.fill((await source.inputValue()).replace('・追記', '・ソースから追記'))
  await page.getByTestId('file-toggle-mode').click()
  await expect(editor).toContainText('本文の目印・ソースから追記')
  await editor.locator('p').filter({ hasText: '本文の目印' }).first().click()
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(SOURCE.replace('本文の目印', '本文の目印・ソースから追記'))
  await expect(page.getByTestId('file-save')).toBeDisabled()
  await page.reload()
  await expect(page.getByTestId('file-markdown-editor')).toContainText('本文の目印・ソースから追記')
})

test('スラッシュで見出しを追加し履歴とチェック操作が保存へ届く', async ({ page }) => {
  const editor = await openFile(page)
  await editor.locator(':scope > p').last().click()
  await page.keyboard.insertText('/')
  const menu = page.locator('.milkdown-slash-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS('overflow-y', 'hidden')
  const items = menu.locator('.menu-groups')
  await expect(items).toHaveCSS('overflow-y', 'auto')
  const size = await items.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }))
  expect(size.scroll).toBeGreaterThan(size.client)
  const tabs = menu.locator('.tab-group')
  await expect(tabs).toBeVisible()
  await expect(tabs.locator('ul')).toHaveCSS('overflow-x', 'auto')
  const before = await tabs.boundingBox()
  expect(before).not.toBeNull()
  await items.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => items.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const after = await tabs.boundingBox()
  expect(after).not.toBeNull()
  expect(after!.y).toBe(before!.y)
  const menuSize = await menu.evaluate((element) => ({ height: element.getBoundingClientRect().height, max: Number.parseFloat(getComputedStyle(element).maxHeight) }))
  expect(menuSize.height).toBeLessThanOrEqual(menuSize.max + 2)
  await items.evaluate((element) => { element.scrollTop = 0 })
  await menu.getByText('見出し 2', { exact: true }).click()
  await page.keyboard.insertText('追加した見出し')
  await expect(editor.getByRole('heading', { level: 2, name: '追加した見出し' })).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(editor).not.toContainText('追加した見出し')
  await page.keyboard.press('Control+Shift+z')
  await expect(editor).toContainText('追加した見出し')

  const checkbox = editor.getByRole('checkbox', { name: '確認する' })
  await checkbox.focus()
  await page.keyboard.press('Space')
  await expect(checkbox).toBeChecked()
  await page.getByTestId('file-save').click()
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('## 追加した見出し')
  expect(fs.readFileSync(file, 'utf8')).toMatch(/[-*+] \[x\] 確認する/)
})

test('表の行列操作とコード編集が実ファイルへ戻る', async ({ page }) => {
  const editor = await openFile(page)
  const cell = editor.locator('td p').first()
  await cell.fill('更新した値')
  const controls = page.getByRole('button', { name: '選択中のブロック操作' })
  await controls.click()
  await page.getByRole('menuitem', { name: '下に行を追加', exact: true }).click()
  await expect(editor.locator('tr')).toHaveCount(3)
  await editor.locator('td p').first().click()
  await controls.click()
  await page.getByRole('menuitem', { name: '右に列を追加', exact: true }).click()
  await expect(editor.locator('tr').first().locator('th, td')).toHaveCount(3)
  const code = editor.locator('.cm-content')
  await code.fill('const value = 2\nconsole.log(value)')
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('const value = 2')
  expect(fs.readFileSync(file, 'utf8')).toContain('更新した値')
  expect(fs.readFileSync(file, 'utf8')).toContain('<!-- 変更しないコメント -->')
})

test('保存前のブロック編集を読み直しても復元する', async ({ page }) => {
  const editor = await openFile(page)
  await editor.locator('p').filter({ hasText: '本文の目印' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('・書きかけ')
  await expect(page.getByTestId('file-save')).toBeEnabled()
  await page.reload()
  await expect(page.getByTestId('file-markdown-editor')).toContainText('本文の目印・書きかけ')
  expect(fs.readFileSync(file, 'utf8')).toBe(SOURCE)
  await expect(page.getByTestId('file-save')).toBeEnabled()
})

test('外部で変更されたファイルをブロック編集で黙って上書きしない', async ({ page }) => {
  const editor = await openFile(page)
  await editor.locator('p').filter({ hasText: '本文の目印' }).first().click()
  await page.keyboard.insertText('自分の編集')
  const external = SOURCE + '\n外部の変更が増えた\n'
  fs.writeFileSync(file, external, 'utf8')
  await page.getByTestId('file-save').click()
  await expect(page.getByTestId('file-conflict-choice')).toBeVisible()
  expect(fs.readFileSync(file, 'utf8')).toBe(external)
  await expect(editor).toContainText('自分の編集')
})

test('ブロック編集中の検索は操作ラベルを除外して更新される', async ({ page }) => {
  const editor = await openFile(page)
  await page.getByTestId('file-find-open').click()
  const search = page.getByTestId('file-find-input')
  await search.fill('本文の目印')
  await expect(page.getByTestId('file-find-count')).toHaveText('1 / 1')
  await search.fill('そのまま保持')
  await expect(page.getByTestId('file-find-count')).toHaveText('見つかりません')
  await search.fill('新しい検索語')
  await expect(page.getByTestId('file-find-count')).toHaveText('見つかりません')
  await editor.locator('p').filter({ hasText: '本文の目印' }).first().click()
  await page.keyboard.insertText('新しい検索語')
  await expect(page.getByTestId('file-find-count')).toHaveText('1 / 1')
})

test('長いコードの未表示行を検索して編集と保存へ戻れる', async ({ page }) => {
  const marker = 'コード末尾検索標識'
  const lines = Array.from({ length: 500 }, (_, index) => `const line_${index} = ${index}`)
  fs.writeFileSync(file, `# 長いコード\n\n\`\`\`javascript\n${lines.join('\n')}\n// ${marker}\n\`\`\`\n`, 'utf8')
  const editor = await openFile(page)
  await expect(editor.locator('.cm-content')).toBeVisible()
  await expect(editor.locator('.cm-line').filter({ hasText: marker })).toHaveCount(0)
  await page.getByTestId('file-find-open').click()
  const search = page.getByTestId('file-find-input')
  await search.fill(marker)
  await expect(page.getByTestId('file-find-count')).toHaveText('1 / 1')
  await expect(editor.locator('.cm-line').filter({ hasText: marker })).toBeVisible()
  await expect(search).toBeFocused()
  await page.getByTestId('file-find-close').click()
  await expect(editor.locator('.cm-content')).toBeFocused()
  await page.keyboard.insertText('置換した標識')
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('置換した標識')
  expect(fs.readFileSync(file, 'utf8')).not.toContain(marker)
})

for (const single of [false, true]) {
  test(`${single ? 'セッション' : 'PJT'}専用画面の狭い幅でも本文と操作メニューが収まる`, async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 900 })
    const editor = await openFile(page, single)
    const body = page.getByTestId('file-body')
    await expect.poll(() => body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const before = await editor.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    await page.getByTestId('file-zoom-in').click()
    await expect.poll(() => editor.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(before)
    await page.getByRole('button', { name: '選択中のブロック操作' }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const rect = await menu.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeGreaterThanOrEqual(0)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(400)
  })
}
