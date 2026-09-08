import { expect, test } from '@playwright/test'
import { archiveAll, openDashboard, spawnSession } from './helpers'

/**
 * 中クリック／Ctrl＋クリックで新しいタブに開く
 * （イシュー `カードと枠を、中クリックで新しいタブに開く` テスト計画フェーズ6）。
 *
 * # ここでしか確かめられないこと
 *
 * **新しいタブが本当に開くかは jsdom では言えない。** 単体（`openInNewTab.test.tsx`）が
 * 見ているのは「`window.open` に何が渡ったか」までで、**ブラウザが実際にタブを増やすか**、
 * **元のタブが一覧のまま残るか**は、本物のブラウザにしか答えられない。
 *
 * 中ボタンは `page.mouse.down({ button: 'middle' })` で撃つ。**`click()` には中ボタンの
 * 指定があるが、`auxclick` を確実に出すために down/up を分けて書く。**
 *
 * # 丸いアイコン（ブラウザの自動スクロール）は、ここでは見えない
 *
 * あれはブラウザ自身が描くもので **DOM に現れない**ので、機械では確かめようがない。
 * テスト計画では【要人間】に置いてある。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('カードを中クリックすると、セッション専用画面が新しいタブに開く', async ({
  page,
  context,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')
  expect(cardId).toBeTruthy()

  const 新しいタブ = context.waitForEvent('page')
  await tile.hover()
  await page.mouse.down({ button: 'middle' })
  await page.mouse.up({ button: 'middle' })

  const 開いた = await 新しいタブ
  await 開いた.waitForLoadState('domcontentloaded')
  expect(new URL(開いた.url()).pathname).toBe(`/s/${cardId}`)

  // **元のタブは一覧のまま。** 増えるのはタブだけで、見ている場所は動かない
  expect(new URL(page.url()).pathname).toBe('/')
  await 開いた.close()
})

test('カードを Ctrl＋左クリックしても、同じ行き先が新しいタブに開く', async ({
  page,
  context,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')

  const 新しいタブ = context.waitForEvent('page')
  await tile.click({ modifiers: ['ControlOrMeta'] })

  const 開いた = await 新しいタブ
  await 開いた.waitForLoadState('domcontentloaded')
  expect(new URL(開いた.url()).pathname).toBe(`/s/${cardId}`)
  expect(new URL(page.url()).pathname).toBe('/')
  await 開いた.close()
})

test('枠の余白を中クリックすると、PJT 専用画面が新しいタブに開く', async ({
  page,
  context,
}) => {
  await openDashboard(page)
  await spawnSession(page)
  const 枠 = page.getByTestId('project-group').first()
  const 見出し = 枠.getByRole('heading', { level: 2 })

  const 新しいタブ = context.waitForEvent('page')
  // **余白を押す。** 見出しは枠の直下にあり、カードでも操作でもない
  await 見出し.hover()
  await page.mouse.down({ button: 'middle' })
  await page.mouse.up({ button: 'middle' })

  const 開いた = await 新しいタブ
  await 開いた.waitForLoadState('domcontentloaded')
  expect(new URL(開いた.url()).pathname).toMatch(/^\/p\//)
  expect(new URL(page.url()).pathname).toBe('/')
  await 開いた.close()
})

test('カードを中クリックしても、開くタブは1枚だけ——枠のぶんまで開かない', async ({
  page,
  context,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await tile.getAttribute('data-card-id')

  const 前 = context.pages().length
  const 新しいタブ = context.waitForEvent('page')
  await tile.hover()
  await page.mouse.down({ button: 'middle' })
  await page.mouse.up({ button: 'middle' })
  const 開いた = await 新しいタブ
  await 開いた.waitForLoadState('domcontentloaded')

  expect(new URL(開いた.url()).pathname).toBe(`/s/${cardId}`)
  // **1枚だけ。** 泡立ちを止めていないと、PJT のぶんまで開いて2枚になる
  expect(context.pages().length).toBe(前 + 1)
  await 開いた.close()
})

test('中クリックしても、選択が変わらない', async ({ page, context }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)

  const 新しいタブ = context.waitForEvent('page')
  await tile.hover()
  await page.mouse.down({ button: 'middle' })
  await page.mouse.up({ button: 'middle' })
  const 開いた = await 新しいタブ
  await 開いた.close()

  // **選ばれていない。** 選ばれていれば帯（まとめて操作）が出る
  await expect(tile).toHaveAttribute('data-selected', 'false')
})
