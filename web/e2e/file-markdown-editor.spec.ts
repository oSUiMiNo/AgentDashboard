import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
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
  await addTableLine(page, editor.locator('td').first(), 'row')
  await expect(editor.locator('tr')).toHaveCount(3)
  await addTableLine(page, editor.locator('td').first(), 'col')
  await expect(editor.locator('tr').first().locator('th, td')).toHaveCount(3)
  const code = editor.locator('.cm-content')
  await code.locator('.cm-line').first().click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText('const value = 2\nconsole.log(value)')
  await expect(code).toHaveText('const value = 2console.log(value)')
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('const value = 2')
  expect(fs.readFileSync(file, 'utf8')).toContain('更新した値')
  expect(fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('|')).join('\n')).not.toMatch(/<br/i)
  expect(fs.readFileSync(file, 'utf8')).toContain('<!-- 変更しないコメント -->')
})

test('ハンドルは本文の左余白に収まり、コードの道具は普段は場所を取らない', async ({ page }) => {
  const editor = await openFile(page)
  const body = page.getByTestId('file-body')
  const paragraph = editor.locator('p').filter({ hasText: '本文の目印' }).first()
  await expect.poll(async () => {
    const before = (await paragraph.boundingBox())!.x
    await page.waitForTimeout(80)
    return (await paragraph.boundingBox())!.x - before
  }).toBe(0)
  const box = (await paragraph.boundingBox())!
  await page.mouse.move(box.x + 12, box.y + 6)
  await page.mouse.move(box.x + 16, box.y + 8)
  const handle = page.locator('.milkdown-block-handle[data-show="true"]')
  await expect(handle).toBeVisible()
  const handleBox = (await handle.boundingBox())!
  const bodyBox = (await body.boundingBox())!
  expect(handleBox.x).toBeGreaterThanOrEqual(bodyBox.x)
  expect(handleBox.x + handleBox.width).toBeLessThanOrEqual(box.x)
  expect(handleBox.width).toBeLessThanOrEqual(44)
  await expect(handle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(handle).toHaveCSS('border-top-width', '0px')
  expect(box.x - bodyBox.x).toBeLessThanOrEqual(60)
  expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

  const code = editor.locator('.milkdown-code-block').first()
  await code.scrollIntoViewIfNeeded()
  await expect(code.locator('.cm-line').first()).toBeVisible()
  await page.mouse.move(bodyBox.x + 2, bodyBox.y + 2)
  const tools = code.locator('.tools')
  await expect(tools).toHaveCSS('opacity', '0')
  await expect(tools).toHaveCSS('position', 'absolute')
  const gaps = await code.evaluate((element) => {
    const block = element.getBoundingClientRect()
    const lines = element.querySelectorAll('.cm-line')
    return { top: lines[0]!.getBoundingClientRect().top - block.top, bottom: block.bottom - lines[lines.length - 1]!.getBoundingClientRect().bottom }
  })
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThanOrEqual(2)
  await code.hover()
  await expect(tools).toHaveCSS('opacity', '1')
  const copy = code.getByRole('button', { name: 'コードをコピー' })
  await expect(copy).toBeVisible()
  await expect(copy).toHaveCSS('font-size', '0px')
  await expectLanguagePickerInside(page, code)
  await openLanguagePicker(page, code)
  await page.locator('.language-picker input').first().fill('plain')
  await page.locator('.language-list-item').filter({ hasText: /^\s*text\s*$/ }).first().click()
  await expect(code.locator('.language-button')).toContainText('text')
  await page.getByTestId('file-save').click()
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('```text\nconst value = 1')
})

async function addTableLine(page: Page, cell: Locator, direction: 'row' | 'col') {
  const line = page.locator(`.line-handle[data-role="${direction === 'row' ? 'x' : 'y'}-line-drag-handle"][data-show="true"]`)
  let step = 0
  await expect(async () => {
    await cell.scrollIntoViewIfNeeded()
    const box = (await cell.boundingBox())!
    const x = direction === 'col' ? box.x + box.width - 3 : box.x + box.width / 2
    const y = direction === 'row' ? box.y + box.height - 3 : box.y + box.height / 2
    step = (step + 1) % 2
    await page.mouse.move(x - 5, y - 5)
    await page.mouse.move(x - step, y - step)
    await expect(line).toHaveCount(1, { timeout: 600 })
    await line.locator('.add-button').click({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
}

async function openLanguagePicker(page: Page, code: Locator) {
  await code.scrollIntoViewIfNeeded()
  await expect(async () => {
    const block = (await code.boundingBox())!
    await page.mouse.move(block.x + block.width / 2, block.y + block.height / 2)
    await page.mouse.move(block.x + block.width - 24, block.y + 14)
    await code.locator('.language-button').click({ timeout: 1_000 })
    await expect(page.locator('.language-picker .list-wrapper')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
}

async function expectLanguagePickerInside(page: Page, code: Locator) {
  const body = page.getByTestId('file-body')
  await openLanguagePicker(page, code)
  const list = page.locator('.language-picker .list-wrapper')
  await expect(list).toBeVisible()
  const listBox = (await list.boundingBox())!
  const bodyBox = (await body.boundingBox())!
  expect(listBox.x).toBeGreaterThanOrEqual(bodyBox.x)
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(bodyBox.x + bodyBox.width)
  expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.locator('.language-picker input').first().fill('python')
  await page.locator('.language-list-item').filter({ hasText: /^\s*Python\s*$/ }).first().click()
  await expect(list).toHaveCount(0)
  await expect(code.locator('.language-button')).toContainText('Python')
}

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
  test(`${single ? 'セッション' : 'PJT'}専用画面の狭い幅でも本文と挿入メニューが収まる`, async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 900 })
    const editor = await openFile(page, single)
    const body = page.getByTestId('file-body')
    await expect.poll(() => body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const paragraph = (await editor.locator('p').filter({ hasText: '本文の目印' }).first().boundingBox())!
    await page.mouse.move(paragraph.x + 12, paragraph.y + 6)
    await page.mouse.move(paragraph.x + 16, paragraph.y + 8)
    await page.waitForTimeout(500)
    await expect(page.locator('.milkdown-block-handle:visible')).toHaveCount(0)
    expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const code = editor.locator('.milkdown-code-block').first()
    await code.scrollIntoViewIfNeeded()
    await expect(code.locator('.cm-line').first()).toBeVisible()
    await expectLanguagePickerInside(page, code)
    const cell = editor.locator('td').first()
    await cell.scrollIntoViewIfNeeded()
    await addTableLine(page, cell, 'row')
    await expect(editor.locator('tr')).toHaveCount(3)
    expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await editor.locator('p').filter({ hasText: '本文の目印' }).first().scrollIntoViewIfNeeded()
    const before = await editor.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
    await page.getByTestId('file-zoom-in').click()
    await expect.poll(() => editor.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(before)
    await editor.locator('p').filter({ hasText: '本文の目印' }).first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('/')
    const menu = page.locator('.milkdown-slash-menu')
    await expect(menu).toBeVisible()
    const rect = await menu.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeGreaterThanOrEqual(0)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(400)
  })
}

function png(width: number, height: number) {
  const crc = (bytes: Buffer) => {
    let value = ~0
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    }
    return ~value >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(body))
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80)
  for (let row = 0; row < height; row++) rows[row * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

test('文書からの相対パスの画像を表示し、横に長い表は表の中だけで送る', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 })
  fs.mkdirSync(path.join(projectDir, 'MyDocs', '参考'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'MyDocs', '参考', '図.png'), png(120, 60))
  const wide = '| 列1 | 列2 | 列3 | 列4 | 列5 | 列6 |\n| --- | --- | --- | --- | --- | --- |\n| 左 | 中 | 右 | `code` | **太字** | 長いセルの文章を入れて横に広がる表を確かめる |\n| 二行目 | 値 | 値 | 値 | 値 | 値 |\n'
  fs.writeFileSync(file, `# 画像と表\n\n![相対の図](参考/図.png)\n\n${wide}`, 'utf8')
  const editor = await openFile(page)
  const image = editor.locator('.milkdown-image-block img').first()
  await expect(image).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(120)
  expect(fs.readFileSync(file, 'utf8')).toContain('](参考/図.png)')
  const caption = editor.locator('.milkdown-image-block .caption-input').first()
  await caption.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('・改')
  await editor.locator('h1').click()
  await page.getByTestId('file-save').click()
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('![相対の図・改](参考/図.png)')
  expect(fs.readFileSync(file, 'utf8')).not.toContain('blob:')

  const body = page.getByTestId('file-body')
  const wrapper = editor.locator('.milkdown-table-block .table-wrapper').first()
  await wrapper.scrollIntoViewIfNeeded()
  expect(await wrapper.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
  await editor.locator('td').last().click()
  const row = (await editor.locator('tr').nth(1).boundingBox())!
  const visible = (await wrapper.boundingBox())!
  let dy = -2
  await expect(async () => {
    dy = dy >= 1 ? -2 : dy + 1
    await page.mouse.move(visible.x + 30, row.y + 12)
    await page.mouse.move(visible.x + 30, row.y + dy)
    await expect(page.locator('.line-handle[data-show="true"]').first()).toBeAttached({ timeout: 600 })
  }).toPass({ timeout: 15_000 })
  expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
})

test('コードを触った後に段落を押すと、入力は段落へ入る', async ({ page }) => {
  const editor = await openFile(page)
  const code = editor.locator('.cm-content').first()
  await code.click()
  await page.keyboard.press('End')
  const paragraph = editor.locator('p').filter({ hasText: '本文の目印' }).first()
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('追記')
  await expect(paragraph).toHaveText('本文の目印追記')
  await expect(code).not.toContainText('追記')
})

test('段落からコードを押すとコードへ入り、矢印でコードの外へ出られる', async ({ page }) => {
  const editor = await openFile(page)
  await editor.locator('p').filter({ hasText: '本文の目印' }).first().click()
  const code = editor.locator('.cm-content').first()
  await code.locator('.cm-line').last().click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' // 入った')
  await expect(code).toContainText('console.log(value) // 入った')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.insertText('外の段落')
  await expect(code).not.toContainText('外の段落')
  await expect(editor.locator(':scope > p').filter({ hasText: '外の段落' })).toHaveCount(1)
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('console.log(value) // 入った\n```')
  expect(fs.readFileSync(file, 'utf8')).toContain('外の段落')
})
