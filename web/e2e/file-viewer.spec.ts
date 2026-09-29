import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { addProject, archiveAll, openDashboard, WORK_DIR } from './helpers'

let projectDir = ''
let pageErrors: string[] = []

const CODE = Array.from({ length: 80 }, (_, i) => `def handler_${i}():\n    total = ${i}\n    return total\n`).join('\n')

test.beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(WORK_DIR, 'adash-e2e-viewer-'))
  fs.mkdirSync(path.join(projectDir, 'docs'))
})

test.beforeEach(({ page }) => {
  fs.writeFileSync(path.join(projectDir, 'app.py'), CODE, 'utf8')
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# 読む\n\n[概要](docs/概要.md) を見る。\n', 'utf8')
  fs.writeFileSync(path.join(projectDir, 'docs', '概要.md'), '# 概要\n\n本文\n', 'utf8')
  fs.writeFileSync(path.join(projectDir, 'data.bin'), Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256)))
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(projectDir, `長いタブの名前_${i}.txt`), `${i}\n`, 'utf8')
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

async function openProject(page: Page) {
  await openDashboard(page)
  const project = await addProject(page, projectDir)
  await project.dblclick({ position: { x: 5, y: 5 } })
  await page.getByTestId('project-files-toggle').click()
  return page.getByTestId('project-files-panel')
}

async function closeSidebar(page: Page) {
  const closeButton = page.getByTestId('project-files-close')
  if (await closeButton.isVisible()) await closeButton.click()
  else if (await page.getByTestId('project-files-panel').isVisible()) await page.getByTestId('project-files-toggle').click()
}

test('探す欄で Enter を押し続けても、焦点は探す欄に残り本文は変わらない', async ({ page }) => {
  const sidebar = await openProject(page)
  await sidebar.getByTestId('folder-entry').filter({ hasText: 'app.py' }).click()
  await closeSidebar(page)
  const editor = page.getByTestId('file-editor')
  await expect(editor).toHaveValue(CODE)
  await page.getByTestId('file-find-open').click()
  await page.getByTestId('file-find-input').fill('total')
  await expect(page.getByTestId('file-find-count')).toHaveText('1 / 160')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Enter')
  await page.keyboard.press('Shift+Enter')
  await expect(page.getByTestId('file-find-input')).toBeFocused()
  await expect(page.getByTestId('file-find-count')).toHaveText('4 / 160')
  await expect(editor).toHaveValue(CODE)
  await expect(page.getByTestId('file-save')).toBeDisabled()
  const marks = page.getByTestId('file-editor-marks').locator('mark')
  await expect(marks).toHaveCount(160)
  const current = page.getByTestId('file-editor-marks').locator('mark[data-current]')
  await expect(current).toHaveCount(1)
  const box = (await current.boundingBox())!
  const body = (await page.getByTestId('file-body').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(body.y)
  expect(box.y + box.height).toBeLessThanOrEqual(body.y + body.height)
  expect(await current.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('file-editor-marks')).toHaveCount(0)
  await expect(editor).toBeFocused()
  expect(fs.readFileSync(path.join(projectDir, 'app.py'), 'utf8')).toBe(CODE)
})

test('タブが帯からあふれても、開いたタブは ✕ まで見えるところへ送られる', async ({ page }) => {
  const sidebar = await openProject(page)
  for (let i = 0; i < 9; i++) {
    await sidebar.getByTestId('folder-entry').filter({ hasText: `長いタブの名前_${i}.txt` }).click()
    const selected = page.getByRole('tab', { selected: true })
    await expect(selected).toHaveText(`長いタブの名前_${i}.txt`)
    await expect.poll(async () => page.evaluate(() => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]')!
      const whole = tab.parentElement!.getBoundingClientRect()
      const strip = tab.closest('.overflow-x-auto')!.getBoundingClientRect()
      return whole.left >= strip.left - 1 && whole.right <= strip.right + 1
    })).toBe(true)
  }
  const strip = page.getByRole('tab', { selected: true }).locator('xpath=ancestor::*[contains(@class,"overflow-x-auto")][1]')
  expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
})

test('文書の中の相対リンクは、ファイルのタブで開く', async ({ page }) => {
  const sidebar = await openProject(page)
  await sidebar.getByTestId('folder-entry').filter({ hasText: 'README.md' }).click()
  await closeSidebar(page)
  const editor = page.getByTestId('file-markdown-editor')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  const pages = page.context().pages().length
  await editor.locator('a', { hasText: '概要' }).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByRole('tab', { selected: true })).toHaveText('概要.md')
  await expect(page.getByTestId('file-markdown-editor').locator('h1')).toHaveText('概要')
  await page.getByRole('tab', { name: 'README.md' }).click()
  await page.getByTestId('file-markdown-editor').locator('a', { hasText: '概要' }).click()
  const preview = page.locator('.milkdown-link-preview[data-show="true"] a.link-display')
  await expect(preview).toHaveText('docs/概要.md')
  await preview.click()
  await expect(page.getByRole('tab', { selected: true })).toHaveText('概要.md')
  expect(page.context().pages().length).toBe(pages)
})

test('テキストでないファイルは、落ち着いた案内とブラウザで開く道を出す', async ({ page }) => {
  const sidebar = await openProject(page)
  await sidebar.getByTestId('folder-entry').filter({ hasText: 'data.bin' }).click()
  const notice = page.getByTestId('file-unsupported')
  await expect(notice).toContainText('テキストではないので、ここでは中身を表示できません。')
  await expect(notice.getByRole('link', { name: 'ブラウザで開く' })).toHaveAttribute('href', /as=raw/)
  await expect(page.getByTestId('file-error')).toHaveCount(0)
  await expect(page.getByTestId('file-zoom')).toBeHidden()
  await expect(page.getByTestId('file-zoom')).toHaveCount(1)
})

test('サイドバーのパンくずは、PJT より上を1つにまとめる', async ({ page }) => {
  const sidebar = await openProject(page)
  const crumbs = sidebar.getByTestId('folder-crumbs')
  await expect(crumbs).toHaveText(`…/${path.basename(projectDir)}`)
  await expect(sidebar.getByTestId('folder-crumb').first()).toHaveAttribute('title', `起点より上：${path.dirname(projectDir)}`)
  expect((await crumbs.boundingBox())!.height).toBeLessThanOrEqual(40)
})
