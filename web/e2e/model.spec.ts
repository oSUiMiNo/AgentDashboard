import { expect, test } from '@playwright/test'
import { archiveAll, openDashboard, openSession, spawnSession } from './helpers'

/**
 * モデル切替（テスト計画フェーズ5「切替」「購読の粒度」）。
 *
 * 要件が名指しで心配している「1つ切り替えたら他も連動する」を、**実際に2本並べて**
 * 確かめる。単体テストはストアの中身しか見ないので、画面まで通した確認はここでしか
 * できない。
 *
 * 擬似 claude が相手なのでクォータは使わない。
 */

/** `refreshInterval` の周期で確定が届くまで待つ。マーカーではなく状態を待つ */
const SETTLE = 20_000

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('セッション画面から切り替えると一覧の小窓にも反映される', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const view = page.getByTestId('session-view')
  const picker = view.getByTestId('model-picker')

  // 起動直後は注入した既定（利用者のグローバル設定）で始まる
  await expect(picker).not.toHaveAttribute('data-model', '', { timeout: SETTLE })

  await picker.selectOption('haiku')
  // 送った値は別名、CLI が名乗るのはフルID。一致しないのが正しい
  await expect(picker).toHaveAttribute(
    'data-model',
    'claude-haiku-4-5-20251001',
    { timeout: SETTLE },
  )
  // 版番号つきで出ること（要望）
  await expect(picker).toContainText('Haiku 4.5')

  // 要件が名指ししている点：切替の結果が一覧の小窓にも出ること
  await page.goto('/')
  const back = page.getByTestId('session-tile').first()
  await expect(back.getByTestId('model')).toHaveAttribute(
    'data-model',
    'claude-haiku-4-5-20251001',
  )
  await expect(back.getByTestId('model')).toHaveText('Haiku 4.5')
})

test('片方を切り替えても、もう片方の表示は変わらない', async ({ page }) => {
  // **要件が名指しで心配している点**（経路1）。値をカードの外に置いた瞬間に壊れる
  await openDashboard(page)
  const first = await spawnSession(page)
  const second = await spawnSession(page)
  const firstId = await first.getAttribute('data-card-id')
  const secondId = await second.getAttribute('data-card-id')

  await openSession(page, first)
  const picker = page.getByTestId('session-view').getByTestId('model-picker')
  await expect(picker).not.toHaveAttribute('data-model', '', { timeout: SETTLE })
  // **既定と違うモデルを選ぶ。** 同じものを選ぶと「変わらなかった」のか
  // 「連動しなかった」のか区別が付かない
  const before = await picker.getAttribute('data-model')
  expect(before).not.toBe('claude-haiku-4-5-20251001')
  await picker.selectOption('haiku')
  await expect(picker).toHaveAttribute(
    'data-model',
    'claude-haiku-4-5-20251001',
    { timeout: SETTLE },
  )

  await page.goto('/')
  const firstTile = page.locator(
    `[data-testid="session-tile"][data-card-id="${firstId}"]`,
  )
  const secondTile = page.locator(
    `[data-testid="session-tile"][data-card-id="${secondId}"]`,
  )
  await expect(firstTile.getByTestId('model')).toHaveAttribute(
    'data-model',
    'claude-haiku-4-5-20251001',
  )
  await expect(secondTile.getByTestId('model')).toHaveAttribute(
    'data-model',
    before ?? '',
  )
})

test('横並び画面でも片方だけが変わる', async ({ page }) => {
  // `GroupView` は `SessionView` を N 個マウントする。**連動バグがあれば必ずここで露見する**
  await openDashboard(page)
  await spawnSession(page)
  await spawnSession(page)

  await page.getByTestId('session-tile').first().click()
  await page.goBack()
  // 同じプロジェクトの2本を横並びで開く
  const project = await page
    .getByTestId('project-group')
    .first()
    .getAttribute('data-project')
  await page.goto(`/p/${encodeURIComponent(project ?? '')}`)

  const views = page.getByTestId('session-view')
  await expect(views).toHaveCount(2)

  const pickers = views.getByTestId('model-picker')
  await expect(pickers.first()).not.toHaveAttribute('data-model', '', {
    timeout: SETTLE,
  })
  await pickers.first().selectOption('opus')
  await expect(pickers.first()).toHaveAttribute('data-model', 'claude-opus-5', {
    timeout: SETTLE,
  })
  await expect(pickers.nth(1)).not.toHaveAttribute(
    'data-model',
    'claude-opus-5',
  )
})

test('切り替えたあとに起こしたセッションは元の既定で始まる', async ({ page }) => {
  // **連動のもう1つの顔**（経路3）。走行中のセッションを見ているだけでは気づけない
  await openDashboard(page)
  const first = await spawnSession(page)
  await openSession(page, first)

  const picker = page.getByTestId('session-view').getByTestId('model-picker')
  await expect(picker).not.toHaveAttribute('data-model', '', { timeout: SETTLE })
  const original = await picker.getAttribute('data-model')
  await picker.selectOption('haiku')
  await expect(picker).toHaveAttribute(
    'data-model',
    'claude-haiku-4-5-20251001',
    { timeout: SETTLE },
  )

  await page.goto('/')
  const second = await spawnSession(page)
  await expect(second.getByTestId('model')).toHaveAttribute(
    'data-model',
    original ?? '',
    { timeout: SETTLE },
  )
})
