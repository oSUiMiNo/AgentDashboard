import { expect, test } from '@playwright/test'
import {
  WORK_DIR,
  addProject,
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  pickOption,
  setTerminalView,
  spawnSession,
} from './helpers'

/**
 * 権限モードの通し確認（テスト計画フェーズ5・6のブラウザ側）。
 *
 * 相手は擬似 claude だが、**本物と同じ形のフッタを出し、Shift+Tab で同じ順序に巡回する**
 * （設計§11 の実測に合わせてある）ので、「起動 → 表示 → 切替 → 一覧へ反映」までを
 * 課金なしで通せる。
 */

test.afterEach(async ({ page }) => {
  // **設定を先に戻す。** 後片付けの途中で失敗しても、トグルだけは必ず戻る。
  // 設定はアカウントごとの記録に残るので、残すと次のテストの権限モードの既定が
  // 「全承認をスキップ」に変わり、無関係なテストが全承認スキップで
  // セッションを起こすことになる（実際に一度そうなった）
  await page.request.put('/api/settings', {
    data: { always_bypass_permissions: false },
  })
  await archiveAll(page)
})

test('ドロップダウンで選んだモードが小窓に出る', async ({ page }) => {
  await openDashboard(page)
  // 起動の入口は枠の「+」へ移った（イシューグループ_2026_0805_0514 §13）。
  // 危険度の判断が要るのは起こす瞬間だけなので、選択もそこに付く
  const group = await addProject(page, WORK_DIR)
  await group.getByTestId('spawn-open').click()
  await expect(group.getByTestId('spawn-mode').locator('option')).toHaveCount(3)

  await group.getByTestId('spawn-mode').selectOption('acceptEdits')
  await group.getByTestId('spawn-button').click()
  await expect(page.getByTestId('session-tile')).toHaveCount(1)

  const tile = page.getByTestId('session-tile').first()
  await expect(tile.getByTestId('permission-mode')).toHaveAttribute(
    'data-mode',
    'acceptEdits',
  )
  await expect(tile.getByTestId('permission-mode')).toHaveText('編集を自動承認')
})

test('セッション画面から切り替えると一覧の小窓にも反映される', async ({
  page,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const view = page.getByTestId('session-view')
  // 起動直後はフッタから読まれる（SessionStart フックはモードを運ばない）
  await expect(view.getByTestId('permission-mode-picker')).toHaveAttribute(
    'data-mode',
    'default',
    { timeout: 15_000 },
  )

  await pickOption(view.getByTestId('permission-mode-picker'), 'plan')
  await expect(view.getByTestId('permission-mode-picker')).toHaveAttribute(
    'data-mode',
    'plan',
    { timeout: 15_000 },
  )

  // 要件が名指ししている点：切替の結果が一覧の小窓にも出ること
  await page.goto('/')
  const back = page.getByTestId('session-tile').first()
  await expect(back.getByTestId('permission-mode')).toHaveAttribute(
    'data-mode',
    'plan',
  )
})

test('巡回に入らないモードを選ぶと理由が画面に出る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const view = page.getByTestId('session-view')
  await expect(view.getByTestId('permission-mode-picker')).toHaveAttribute(
    'data-mode',
    'default',
    { timeout: 15_000 },
  )

  // dontAsk は起動時にしか選べない（設計§11）。黙って何も起きないのが一番困る
  await pickOption(view.getByTestId('permission-mode-picker'), 'dontAsk')
  /*
    **出る先はカードで、画面全体の帯ではない**（復旧設計§9-5）。この失敗は `card_id`
    を名乗っており、行き先は種別ではなく名指しの有無で決まる。横並びで見ているとき、
    帯に出すと**どのカードの話なのか分からない**。

    帯に出続けるのは名指しの無い失敗だけで、そちらは `terminal.spec.ts`（起動に失敗
    したときは、まだカードが無いので名乗れない）が押さえている。
  */
  await expect(view.getByTestId('card-error')).toContainText(
    '切り替えられません',
    { timeout: 30_000 },
  )
  await expect(page.getByTestId('error-banner')).toHaveCount(0)

  /*
    **溜まっている間はベルが出る**（細かい修正 設計§7-4）。1件も無いときは出さないので、
    ここで出ていることが「溜まっている」の証拠になる。
  */
  const bell = view.getByTestId('notice-bell')
  await expect(bell).toBeVisible()
  await bell.click()
  /*
    **一覧は区画の中に居ない。** `Popover` は Portal で `body` の直下へ出るので、
    `session-view` から引くと見つからない（フェーズ2の `tile-ops` と同じ形の取り違え）。
  */
  await expect(page.getByTestId('notice-item').first()).toContainText('切り替えられません')
  await page.keyboard.press('Escape')

  /*
    **5秒で消える**（同 §7-3）。モードの切替は単発の操作結果なので流してよい——
    要件が名指ししていた「ずっと出続けて邪魔」がこれである。

    **消えるところまで見る。** jsdom では時計を進めれば済むが、実際に消えるかは
    ここでしか分からない。
  */
  await expect(view.getByTestId('card-error')).toHaveCount(0, { timeout: 15_000 })
  await expect(view.getByTestId('notice-bell')).toHaveCount(0)
})

test('片方を切り替えても、もう片方の表示は変わらない', async ({ page }) => {
  await openDashboard(page)
  const first = await spawnSession(page)
  const second = await spawnSession(page)
  const firstId = await first.getAttribute('data-card-id')
  const secondId = await second.getAttribute('data-card-id')

  // どちらもフッタから読まれるまで待つ
  for (const id of [firstId, secondId]) {
    await expect(
      page.locator(`[data-testid="session-tile"][data-card-id="${id}"]`)
        .getByTestId('permission-mode'),
    ).toHaveAttribute('data-mode', 'default', { timeout: 15_000 })
  }

  await page.goto(`/s/${firstId}`)
  await pickOption(page.getByTestId('permission-mode-picker'), 'acceptEdits')
  await expect(page.getByTestId('permission-mode-picker')).toHaveAttribute(
    'data-mode',
    'acceptEdits',
    { timeout: 15_000 },
  )

  await page.goto('/')
  await expect(
    page.locator(`[data-testid="session-tile"][data-card-id="${firstId}"]`)
      .getByTestId('permission-mode'),
  ).toHaveAttribute('data-mode', 'acceptEdits')
  await expect(
    page.locator(`[data-testid="session-tile"][data-card-id="${secondId}"]`)
      .getByTestId('permission-mode'),
  ).toHaveAttribute('data-mode', 'default')
})

test('設定のトグルはリロードしても別タブでも保たれる', async ({ page, context }) => {
  await openDashboard(page)
  await page.getByTestId('settings-link').click()
  await expect(page.getByTestId('settings-page')).toBeVisible()

  await page.getByTestId('always-bypass-toggle').check()
  await expect(page.getByTestId('always-bypass-toggle')).toBeChecked()

  // 保存先はサーバなので、開き直しても残る
  await page.reload()
  await expect(page.getByTestId('always-bypass-toggle')).toBeChecked()

  // 起動時の権限モードの既定が「全承認をスキップ」になる（選択肢は減らない）
  await page.goto('/')
  const group = await addProject(page, WORK_DIR)
  await group.getByTestId('spawn-open').click()
  await expect(group.getByTestId('spawn-mode')).toHaveAttribute(
    'data-mode',
    'bypassPermissions',
  )
  await expect(group.getByTestId('spawn-mode').locator('option')).toHaveCount(3)

  // 別のタブでも同じ値になる（ブラウザごとに食い違わない）
  const other = await context.newPage()
  await other.goto('/settings')
  await expect(other.getByTestId('always-bypass-toggle')).toBeChecked()
  await other.close()
})

test('既定が全承認スキップでも別のモードで起こせて、起動後は既定へ戻る', async ({
  page,
}) => {
  // トグルが決めるのは**既定**であって選択肢の数ではない。そして選んだ値は
  // 起動のたびに捨てる——残すと、次の1本を意図しないモードで起こすことになる
  await page.request.put('/api/settings', {
    data: { always_bypass_permissions: true },
  })
  await openDashboard(page)
  const group = await addProject(page, WORK_DIR)
  await group.getByTestId('spawn-open').click()
  await expect(group.getByTestId('spawn-mode')).toHaveAttribute(
    'data-mode',
    'bypassPermissions',
  )

  await group.getByTestId('spawn-mode').selectOption('acceptEdits')
  await group.getByTestId('spawn-button').click()
  await expect(page.getByTestId('session-tile')).toHaveCount(1)

  // 起こしたのは選んだモード
  await expect(
    page.getByTestId('session-tile').first().getByTestId('permission-mode'),
  ).toHaveAttribute('data-mode', 'acceptEdits')
  // そして選択は捨てられ、既定へ戻っている（開き直すと既定で出る）
  await group.getByTestId('spawn-open').click()
  await expect(group.getByTestId('spawn-mode')).toHaveAttribute(
    'data-mode',
    'bypassPermissions',
  )
})

test('全承認をスキップで起動すると、確認に自動で答えて起動しきる', async ({
  page,
}) => {
  await openDashboard(page)
  const group = await addProject(page, WORK_DIR)
  await group.getByTestId('spawn-open').click()
  await group.getByTestId('spawn-mode').selectOption('bypassPermissions')
  await group.getByTestId('spawn-button').click()
  await expect(page.getByTestId('session-tile')).toHaveCount(1)

  await page.getByTestId('session-tile').first().dblclick()
  await expect(page.getByTestId('session-view')).toBeVisible()
  await setTerminalView(page, true)

  // 責任の受諾を尋ねる画面に、こちらで答えている（既定は「いいえ」なので決め打ち禁止）
  await expectTerminalToContain(page, '[fake-claude] bypass-accepted')

  // 一覧へ戻って、そのモードで動いていることが小窓からも分かること
  await page.goto('/')
  await expect(
    page.getByTestId('session-tile').first().getByTestId('permission-mode'),
  ).toHaveAttribute('data-mode', 'bypassPermissions', { timeout: 15_000 })
})

test('補足は開いたときだけ出る（選んだあとの表示には出ない）', async ({
  page,
}) => {
  // **要件の後半そのもの。** 標準の `<select>` は閉じているときに選択肢の文字を
  // そのまま出すので、`自動（環境によっては切り替えられません）` と補足まで出ていた。
  // 自前にしたのはここだけのため（帯の設計§4・案B）
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const picker = page.getByTestId('permission-mode-picker')
  await expect(picker).toBeVisible()

  // 閉じているとき：補足は出ていない
  await expect(picker).not.toContainText('起動時にしか選べません')
  await expect(picker).not.toContainText('（')

  // 開いたとき：補足が読める
  await picker.click()
  const 確認しない = page.locator('[role="option"][data-value="dontAsk"]')
  await expect(確認しない).toContainText('確認しない')
  await expect(確認しない).toContainText('起動時にしか選べません')
  // いつでも行けるものには何も足さない
  await expect(page.locator('[role="option"][data-value="plan"]')).toHaveText(
    'プラン',
  )

  // 選んで閉じたあと：また出ない
  await page.locator('[role="option"][data-value="plan"]').click()
  await expect(picker).toHaveAttribute('data-mode', 'plan', { timeout: 15_000 })
  await expect(picker).not.toContainText('（')
})

test('スマホ相当の幅でも開いて選べる', async ({ page }) => {
  // **標準の部品をやめた瞬間に失われうるもの。** 実機（フェーズ5）より前に、
  // 少なくとも「狭い窓で開いて押せる」ことは手元で見ておく
  await page.setViewportSize({ width: 375, height: 780 })
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const picker = page.getByTestId('permission-mode-picker')
  await pickOption(picker, 'plan')
  await expect(picker).toHaveAttribute('data-mode', 'plan', { timeout: 15_000 })

  // **一覧がトリガーに被さって、いま何を選んでいるか分からなくなっていないこと。**
  // `position="popper"` にしてあるのはこのため
  await picker.click()
  const 一覧 = page.locator('[role="listbox"]')
  await expect(一覧).toBeVisible()
  const 上 = await picker.boundingBox()
  const 下 = await 一覧.boundingBox()
  expect(下!.y).toBeGreaterThanOrEqual(上!.y + 上!.height - 1)
})
