import { expect, test } from '@playwright/test'
import {
  archiveAll,
  openDashboard,
  openSession,
  pickOption,
  spawnSession,
} from './helpers'

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

/**
 * `e2e/global-setup.ts` が置く既定。**注入が効かなかったときの値と違う**ものを
 * 選んであるので、この値が出れば注入が本当に動いたことになる。
 */
const INJECTED = { model: 'claude-opus-5', label: 'Opus 5' }

test('利用者のグローバル既定が注入されて、起こしたセッションがその値で始まる', async ({
  page,
}) => {
  // **設計§6 の主の仕掛け**。これが効いていなければ、擬似 claude は組み込み既定
  // （`default` → Sonnet 5）で始まる。以前の E2E はその状態を見ていたので、
  // 注入と回復の実装を丸ごと消しても緑のままだった
  await openDashboard(page)
  const tile = await spawnSession(page)

  await expect(tile.getByTestId('model')).toHaveAttribute(
    'data-model',
    INJECTED.model,
    { timeout: SETTLE },
  )
  await expect(tile.getByTestId('model')).toHaveText(INJECTED.label)
})

test('セッション画面から切り替えると一覧の小窓にも反映される', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const view = page.getByTestId('session-view')
  const picker = view.getByTestId('model-picker')

  // 起動直後は注入した既定（利用者のグローバル設定）で始まる
  await expect(picker).not.toHaveAttribute('data-model', '', { timeout: SETTLE })

  await pickOption(picker, 'haiku')
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
  await pickOption(picker, 'haiku')
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
  const group = page.getByTestId('project-group').first()
  const project = await group.getAttribute('data-project')
  // 鍵は（PC, パス）の組（設計§16）。枠が名乗っている PC をそのまま使う
  const host = await group.getAttribute('data-host')
  await page.goto(
    `/p/${encodeURIComponent(host ?? 'local')}/${encodeURIComponent(project ?? '')}`,
  )

  const views = page.getByTestId('session-view')
  await expect(views).toHaveCount(2)

  const pickers = views.getByTestId('model-picker')
  await expect(pickers.first()).not.toHaveAttribute('data-model', '', {
    timeout: SETTLE,
  })
  // **注入された既定と違うモデルを選ぶ。** 2本とも既定で始まっているので、
  // 既定と同じものを選ぶと何も起きず、「連動しなかった」ことを確かめられない
  await pickOption(pickers.first(), 'haiku')
  await expect(pickers.first()).toHaveAttribute(
    'data-model',
    'claude-haiku-4-5-20251001',
    { timeout: SETTLE },
  )
  await expect(pickers.nth(1)).toHaveAttribute('data-model', INJECTED.model)
})

test('切り替えたあとに起こしたセッションは元の既定で始まる', async ({ page }) => {
  // **連動のもう1つの顔**（経路3）。走行中のセッションを見ているだけでは気づけない
  await openDashboard(page)
  const first = await spawnSession(page)
  await openSession(page, first)

  const picker = page.getByTestId('session-view').getByTestId('model-picker')
  // 出発点が**注入された既定**であることを名指しで押さえる。ここを緩めると、
  // 注入が死んでいても「2本とも組み込み既定で同じ」で緑になってしまう
  await expect(picker).toHaveAttribute('data-model', INJECTED.model, {
    timeout: SETTLE,
  })
  const original = await picker.getAttribute('data-model')
  await pickOption(picker, 'haiku')
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
