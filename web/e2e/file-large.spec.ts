import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { addProject, archiveAll, openDashboard, spawnSession, WORK_DIR } from './helpers'

/**
 * 大きいファイル（ファイル閲覧の上限を設定から変え、大きいものは流し読みする）の E2E。
 *
 * フェーズ6 は設定のカードの部分。フェーズ7 でファイルビュアの部分（窓で読む面・断り文の
 * 導線・5 MB の HTML）を足す。
 *
 * # 変えた上限は必ず既定へ戻す
 *
 * **上限はサーバ全体の1つの値で、E2E は1つのサーバを spec の順に共有する。** 途中で落ちて
 * 1 MB が残ると、後の spec（`file-viewer.spec.ts` など）が「大きすぎます」で巻き込まれる。
 */

const MIB = 1024 * 1024
const GIB = 1024 * MIB

test.describe('設定：ファイル閲覧の上限', () => {
  test.afterEach(async ({ page }) => {
    const 戻した = await page.request.put('/api/settings', {
      data: { file_view_max_bytes: 'default' },
    })
    expect(戻した.ok()).toBe(true)
  })

  test('16個が選べて、読み直しても残る・ローカルでは警告が出ない', async ({ page }) => {
    await openDashboard(page)
    await page.getByTestId('settings-link').click()

    const select = page.getByTestId('file-view-limit-select')
    await expect(select).toHaveValue(String(5 * GIB))
    const 既定 = select.locator('option', { hasText: '・既定' })
    await expect(既定).toHaveCount(1)
    await expect(既定).toHaveText('5 GB（5,368,709,120 バイト）・既定')

    const values = await select
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    expect(values).toHaveLength(16)

    for (const value of values) {
      const 保存 = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/settings') &&
          response.request().method() === 'PUT',
      )
      await select.selectOption(value)
      expect((await 保存).status()).toBe(200)
      await expect(select).toHaveValue(value)
      // **ローカルなので警告が一度も出ない**（サーバを介さず、クラウドでもない）
      await expect(page.getByTestId('file-view-limit-confirm')).toHaveCount(0)
    }

    // 読み直しは最初・途中・最後の3回。値の保存は DB の試験（`server-core/tests/db.rs`）と
    // 設定の口の試験（`core/tests/settings_io.rs`）が16個全部を通している（テスト計画 3-3）
    for (const value of [String(MIB), String(50 * MIB), String(20 * GIB)]) {
      const 保存 = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/settings') &&
          response.request().method() === 'PUT',
      )
      await select.selectOption(value)
      expect((await 保存).status()).toBe(200)
      await page.reload()
      await expect(page.getByTestId('file-view-limit-select')).toHaveValue(value)
    }
  })

  test('ハッシュで開くと、上限のカードが見える位置へ送られる', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    await openDashboard(page)

    // **対照**：低い窓ではカードが下に隠れていることを先に確かめる。これが崩れたら
    // 下の確かめは空振りになるので、ここで理由つきで落ちる
    await page.goto('/settings')
    await expect(page.getByTestId('file-view-limit')).toBeAttached()
    await expect(
      page.getByTestId('file-view-limit'),
      '低い窓ではカードが最初から見えていないこと（見えていると送る確かめが空振りになる）',
    ).not.toBeInViewport()

    await page.goto('/settings#file-view-limit')
    await expect(page.getByTestId('file-view-limit')).toBeInViewport()
  })
})

/**
 * 大きいファイルの材料。**4 GiB の疎なファイル**（先頭と末尾だけに字を書き、間は書かない）。
 *
 * - 中身を書かないのでディスクを食わない（/tmp は ext4）
 * - 先頭と末尾の字は**それぞれ 2 MiB 以上**——短いと、開いた直後の窓や「末尾へ」の窓が
 *   読めず、窓を4枚より多く読んで捨てる動きも確かめられない
 * - 間は NUL なので、先頭の字を読み進めると「テキストではない」で止まる（それも確かめる）
 */
function 大きいログを置く(file: string) {
  const fd = fs.openSync(file, 'w')
  try {
    const head = Array.from(
      { length: 44_000 },
      (_, i) => `head line ${String(i + 1).padStart(6, '0')} あいうえおかきくけこさしすせそ\n`,
    ).join('')
    const tail =
      Array.from(
        { length: 44_000 },
        (_, i) => `tail line ${String(i + 1).padStart(6, '0')} たちつてとなにぬねのはひふへほ\n`,
      ).join('') + '末尾の印\n'
    const headBytes = Buffer.from(head, 'utf8')
    const tailBytes = Buffer.from(tail, 'utf8')
    expect(headBytes.length).toBeGreaterThan(2 * MIB)
    expect(tailBytes.length).toBeGreaterThan(2 * MIB)
    fs.writeSync(fd, headBytes, 0, headBytes.length, 0)
    fs.ftruncateSync(fd, 4 * GIB)
    fs.writeSync(fd, tailBytes, 0, tailBytes.length, 4 * GIB - tailBytes.length)
  } finally {
    fs.closeSync(fd)
  }
}

/** 約 5,062,904 バイトの HTML（利用者がスクリーンショットで開こうとした大きさ）。末尾に印 */
function 大きいHTMLを置く(file: string) {
  const 段 =
    '<section><h2>調べたこと</h2><p>段落の文章です。読み手が詰まらないよう短く書きます。</p>' +
    '<table><tr><th>項目</th><th>値</th></tr><tr><td>例</td><td>1</td></tr></table></section>\n'
  const 頭 = '<!doctype html><html><head><meta charset="utf-8"><title>まとめ</title></head><body>\n'
  const 尻 = '<p id="tail">描いた末尾の印</p>\n</body></html>\n'
  const 目標 = 5_062_904
  const 段のバイト = Buffer.byteLength(段, 'utf8')
  const 回数 = Math.floor((目標 - Buffer.byteLength(頭 + 尻, 'utf8')) / 段のバイト)
  fs.writeFileSync(file, 頭 + 段.repeat(回数) + 尻, 'utf8')
}

/**
 * その字が、ファイルの本文の箱（`file-body`）の見えている範囲に入っているか。
 *
 * **要素の可視（`toBeInViewport`）では見られない。** 窓1枚は 256 KiB の字を持つ1つの
 * `span` なので、その端が見えているだけで「見えている」と言ってしまう。字そのものの
 * 位置を Range で測る。
 */
async function 字が見えている(page: Page, 字: string): Promise<boolean> {
  return page.evaluate((needle) => {
    const box = document.querySelector('[data-testid="file-body"]')
    const pre = document.querySelector('[data-testid="file-window-text"]')
    if (box === null || pre === null) return false
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      const r = range.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      return r.height > 0 && r.top >= b.top && r.bottom <= b.bottom
    }
    return false
  }, 字)
}

/** 窓で読む面の窓（`span[data-start]`）の数と、先頭と末尾の位置 */
async function 窓の並び(page: Page) {
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-testid="file-window-text"] span[data-start]')]
    return {
      数: spans.length,
      先頭: Number(spans[0]?.getAttribute('data-start') ?? -1),
      末尾: Number(spans[spans.length - 1]?.getAttribute('data-end') ?? -1),
    }
  })
}

test.describe('ファイルビュア：大きいファイル', () => {
  let projectDir = ''
  let pageErrors: string[] = []

  test.beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(WORK_DIR, 'adash-e2e-large-'))
    大きいログを置く(path.join(projectDir, 'big.log'))
    大きいHTMLを置く(path.join(projectDir, 'report.html'))
    fs.writeFileSync(path.join(projectDir, 'two-mb.txt'), 'あいうえお\n'.repeat(Math.ceil((2 * MIB) / 16)), 'utf8')
    // 画像の上限（8 MiB）＋1。疎でよい（読まずに大きさで断られる）
    const fd = fs.openSync(path.join(projectDir, 'over-image.png'), 'w')
    fs.ftruncateSync(fd, 8 * MIB + 1)
    fs.closeSync(fd)
  })

  test.beforeEach(({ page }) => {
    pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
  })

  test.afterEach(async ({ page }) => {
    // **上限はサーバ全体の1つの値。** 断言が落ちても必ず既定へ戻す（後の spec を巻き込まない）
    const 戻した = await page.request.put('/api/settings', {
      data: { file_view_max_bytes: 'default' },
    })
    expect(戻した.ok()).toBe(true)
    await archiveAll(page)
    expect(pageErrors).toEqual([])
  })

  test.afterAll(() => {
    // **4 GiB の疎なファイルも消す**
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true })
  })

  async function PJT画面で開く(page: Page, name: string): Promise<Locator> {
    await openDashboard(page)
    const project = await addProject(page, projectDir)
    await project.dblclick({ position: { x: 5, y: 5 } })
    await page.getByTestId('project-files-toggle').click()
    const panel = page.getByTestId('project-files-panel')
    await panel.getByTestId('folder-entry').filter({ hasText: name }).click()
    // サイドバーを畳む（狭い窓では被さるので、本文を測る前に退ける）
    await page.getByTestId('project-files-toggle').click()
    await expect(panel).toBeHidden()
    return page.getByTestId('file-view')
  }

  async function 上限を変える(page: Page, bytes: number) {
    const 変えた = await page.request.put('/api/settings', { data: { file_view_max_bytes: bytes } })
    expect(変えた.ok()).toBe(true)
  }

  test('大きいファイルを開いて末尾まで辿れる。窓は4枚までで、足しても見ている行が跳ばない', async ({ page }) => {
    await PJT画面で開く(page, 'big.log')
    await expect(page.getByTestId('file-window-text')).toBeVisible()
    await expect(page.getByTestId('file-truncated')).toBeVisible()
    await expect(page.getByTestId('file-save')).toHaveCount(0)

    // **下へ読み進めても、持つ窓は4枚まで。** 離れた窓は捨てる（先頭の位置が 0 より大きくなる）
    let 捨てた = false
    for (let i = 0; i < 12; i++) {
      const 前 = await 窓の並び(page)
      expect(前.数, '持つ窓は4枚まで').toBeLessThanOrEqual(4)
      if (前.先頭 > 0) 捨てた = true
      if (await page.getByTestId('file-window-stop').isVisible()) break
      await page.getByTestId('file-body').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await expect
        .poll(async () => {
          const 後 = await 窓の並び(page)
          return 後.末尾 > 前.末尾 || (await page.getByTestId('file-window-stop').isVisible())
        })
        .toBe(true)
    }
    expect(捨てた, '離れた窓を捨てたこと（先頭の位置が 0 より大きくなった）').toBe(true)
    // 先頭の字（約 2.5 MiB）を越えると、間の NUL で止まる。位置を字で言う
    await expect(page.getByTestId('file-window-stop')).toContainText('バイト目からはテキストとして読めません')
    expect((await 窓の並び(page)).数).toBeLessThanOrEqual(4)

    // 末尾へ飛ぶ
    await page.getByTestId('file-window-end').click()
    await expect.poll(() => 字が見えている(page, '末尾の印')).toBe(true)

    // **見ている行が跳ばない。** 前へ窓を足す頼みを一度止め、足す前と後で同じ点の行を比べる
    let 放す: () => void = () => {}
    const 止める = new Promise<void>((resolve) => {
      放す = resolve
    })
    let 止めた = false
    await page.route(
      (url) => url.searchParams.get('as') === 'range',
      async (route) => {
        if (!止めた) {
          止めた = true
          await 止める
        }
        await route.continue()
      },
    )
    const 足す前 = await 窓の並び(page)
    await page.getByTestId('file-body').evaluate((el) => {
      el.scrollTop = 0
    })
    await expect.poll(() => 止めた, '前の窓の頼みが出たこと').toBe(true)
    // いまの先頭の窓の、最初の行の位置と字を控える
    const 控え = await page.evaluate((start) => {
      const span = document.querySelector(`[data-testid="file-window-text"] span[data-start="${start}"]`)
      const node = span?.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE) return null
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, 1)
      const r = range.getBoundingClientRect()
      const 行 = (node.textContent ?? '').split('\n')[0]
      return { x: r.left + 2, y: r.top + r.height / 2, 行 }
    }, 足す前.先頭)
    expect(控え, '先頭の窓の最初の行が測れること').not.toBeNull()
    放す()
    await expect.poll(async () => (await 窓の並び(page)).先頭).toBeLessThan(足す前.先頭)
    const 足した後の行 = await page.evaluate(({ x, y }) => {
      const range = document.caretRangeFromPoint(x, y)
      const node = range?.startContainer
      if (!node || node.nodeType !== Node.TEXT_NODE) return null
      const text = node.textContent ?? ''
      const offset = range!.startOffset
      const from = text.lastIndexOf('\n', offset - 1) + 1
      const to = text.indexOf('\n', offset)
      return text.slice(from, to < 0 ? undefined : to)
    }, { x: 控え!.x, y: 控え!.y })
    expect(足した後の行, '前へ窓を足しても、同じ点に同じ行が見えている').toBe(控え!.行)
    await page.unrouteAll({ behavior: 'ignoreErrors' })

    // 先頭へ戻る
    await page.getByTestId('file-window-top').click()
    await expect.poll(() => 字が見えている(page, 'head line 000001')).toBe(true)
  })

  test('5 MB の HTML が描いた形で見える（利用者のスクリーンショットの場面）', async ({ page }) => {
    await PJT画面で開く(page, 'report.html')
    const frame = page.getByTestId('file-frame')
    await expect(frame).toBeVisible()
    // **サーバが流して返したものが末尾まで届いた**（途中で切れたら末尾の印が無い）
    await expect(page.frameLocator('[data-testid="file-frame"]').locator('#tail')).toHaveText('描いた末尾の印', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('file-limit-hint')).toHaveCount(0)
    await expect(page.getByTestId('file-error')).toHaveCount(0)
  })

  test('上限を小さくして開くと導線が出て、押すと設定のカードに着く', async ({ page }) => {
    await openDashboard(page)
    await 上限を変える(page, MIB)
    await PJT画面で開く(page, 'two-mb.txt')
    await expect(page.getByTestId('file-error')).toBeVisible()
    const hint = page.getByTestId('file-limit-hint')
    await expect(hint).toContainText('いま 1 MB')
    await page.getByTestId('file-limit-open-settings').click()
    await expect(page).toHaveURL(/\/settings#file-view-limit$/)
    // **カードは押さない**（押すと可視域へ運ばれて、測る前に動いてしまう）
    await expect(page.getByTestId('file-view-limit')).toBeInViewport()
  })

  test('画像の上限は変わっていない（20 GB にしても 8 MB を超える画像は断られ、導線は出ない）', async ({ page }) => {
    await openDashboard(page)
    await 上限を変える(page, 20 * GIB)
    await PJT画面で開く(page, 'over-image.png')
    await expect(page.getByTestId('file-error')).toContainText('8388609')
    await expect(page.getByTestId('file-limit-hint')).toHaveCount(0)
  })

  test('PJT 専用画面の区画とセッション専用画面の両方で、窓で読む面と導線が出る', async ({ page }) => {
    await openDashboard(page)
    // セッションを1本起こしておく（セッション専用画面はセッションが無いと開けない）
    const tile = await spawnSession(page, projectDir)

    // PJT 専用画面の区画
    const group = await addProject(page, projectDir)
    await group.dblclick({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('group-view')).toBeVisible()
    await page.getByTestId('project-files-toggle').click()
    await page.getByTestId('project-files-panel').getByTestId('folder-entry').filter({ hasText: 'big.log' }).click()
    const column = page.getByTestId('file-column')
    await expect(column.getByTestId('file-window-text')).toBeVisible()
    await expect(column.getByTestId('file-window-end')).toBeVisible()

    // セッション専用画面。**同じ PJT のサイドバーと開いたファイルは覚えていて戻ってくる**ので、
    // 開け閉めのボタンは「押す」ではなく「開いた状態にする」（押すと畳んでしまう）
    await page.goto('/')
    await tile.dblclick()
    await expect(page.getByTestId('session-view')).toBeVisible()
    const toggle = page.getByTestId('project-files-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const panel = page.getByTestId('project-files-panel')
    await panel.getByTestId('folder-entry').filter({ hasText: 'two-mb.txt' }).click()
    await panel.getByTestId('folder-entry').filter({ hasText: 'big.log' }).click()
    await expect(page.getByTestId('file-window-text')).toBeVisible()
    await expect(page.getByTestId('file-window-end')).toBeVisible()

    // 上限で断られたときの導線も、セッション専用画面で出る
    await 上限を変える(page, MIB)
    await panel.getByTestId('folder-entry').filter({ hasText: 'two-mb.txt' }).click()
    await expect(page.getByTestId('file-limit-hint')).toContainText('いま 1 MB')
  })
})
