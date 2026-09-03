import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { archiveAll, holdTouch, openDashboard, spawnSession } from './helpers'

/**
 * 名前を付ける／過去のセッションから起こす（名前付け設計§9。テスト計画フェーズ6）。
 *
 * # 走査元は隔離してある
 *
 * 実在の確認は `<AGENTDASHBOARD_CLAUDE_HOME>/.claude/projects` を舐める。
 * `playwright.config.ts` が `.e2e-state/claude-home` を指しているので、**開発者の
 * 本物のホームを見にいかない**（あちらは 1,119 フォルダあり、遅いうえに機械ごとに
 * 結果が変わる）。履歴はこのテストが自分で置く。
 *
 * # `fleet` は要らない
 *
 * 接続断のカードを作る必要が無いので、既定の1台構成で足りる。
 */

/** E2E 用に隔離した、CLI の履歴の置き場所。 */
const CLAUDE_HOME = path.resolve('.e2e-state/claude-home')

/**
 * 過去のセッションの履歴を1本置く。
 *
 * **フォルダ名は何でもよい。** 走査は総なめなので、パスから作った名前と一致しなくても
 * 見つかる（設計§8-4）。ここで規則どおりの名前を作ってしまうと、**規則に頼っていても
 * 気づけない**テストになる。
 */
function 履歴を置く(claudeSessionId: string) {
  const dir = path.join(CLAUDE_HOME, '.claude', 'projects', 'e2e-どこでもよい')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${claudeSessionId}.jsonl`), '{}\n')
}

/** サーバに聞いて、そのカードの CLI セッションIDを取る。 */
async function セッションIDを取る(page: import('@playwright/test').Page, cardId: string) {
  return await expect
    .poll(
      async () => {
        const rows = await page.evaluate(async () => {
          const response = await fetch('/api/sessions')
          return (await response.json()) as {
            card_id: string
            claude_session_id: string | null
          }[]
        })
        return rows.find((row) => row.card_id === cardId)?.claude_session_id ?? null
      },
      { message: '呼び戻し先が記録に載るのを待つ', timeout: 30_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const rows = await page.evaluate(async () => {
        const response = await fetch('/api/sessions')
        return (await response.json()) as {
          card_id: string
          claude_session_id: string | null
        }[]
      })
      return rows.find((row) => row.card_id === cardId)!.claude_session_id!
    })
}

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('外したセッションを、枠の「＋」から呼び戻せる', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  const session = await セッションIDを取る(page, cardId)

  // 履歴を置いてから外す。**置かないと「実在しない」と判定されて選択肢に出ない**
  履歴を置く(session)
  await archiveAll(page)

  // 枠を作り直して「＋」を開く（`archiveAll` は枠も消す）
  const 次 = await spawnSession(page)
  await 次.click({ button: 'left' })
  await page.getByTestId('spawn-open').first().click()
  const picker = page.getByTestId('spawn-past').first()
  await expect(picker).toBeVisible({ timeout: 30_000 })

  // 外したセッションが選択肢に出ていること
  await expect(picker.locator(`option[value="${session}"]`)).toHaveCount(1)
})

test('実在しないセッションは選択肢に出ない', async ({ page }) => {
  // **確かめて無かったものだけを外す**（設計§8-5）。履歴を置かずに外したので、
  // PC は「無い」と答える
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  const session = await セッションIDを取る(page, cardId)
  await archiveAll(page)

  const 次 = await spawnSession(page)
  await 次.click({ button: 'left' })
  await page.getByTestId('spawn-open').first().click()

  // 選択欄そのものが出ないか、出ても当のセッションは載っていない
  const picker = page.getByTestId('spawn-past').first()
  if (await picker.isVisible().catch(() => false)) {
    await expect(picker.locator(`option[value="${session}"]`)).toHaveCount(0)
  }
})


test('カードから名前を付けると、読み込み直しても残る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = (await tile.getAttribute('data-card-id'))!
  const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)

  // **鉛筆は小窓の中に居ない**（器の直下の兄弟）。中から探すと 0 件で通ってしまう
  await shell.hover()
  await shell.getByTestId('nickname-edit').click()
  await page.getByTestId('nickname-input').fill('あとで直すやつ')
  await page.getByTestId('nickname-input').press('Enter')

  const title = page.locator(
    `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
  )
  await expect(title).toHaveText('あとで直すやつ', { timeout: 30_000 })
  // **利用者が付けた名前**として出ていること（CLI の名前と見分けが付く）
  await expect(title).toHaveAttribute('data-nickname', 'user')

  await page.reload()
  await expect(title).toHaveText('あとで直すやつ', { timeout: 30_000 })
})

test.describe('指で触る端末', () => {
  // **`hasTouch` が `(pointer: coarse)` と `(hover: none)` の両方を立てる**
  // （`isMobile` ではない。`dpad.spec.ts` の実測）
  test.use({ hasTouch: true })

  test('長押しで選ぶと鉛筆が出て、指で押せる', async ({ page }) => {
    // **タッチに hover は無い**ので、選択の側が無いとスマホから永久に届かない
    // （名前付け設計§9-3）
    await openDashboard(page)
    const tile = await spawnSession(page)
    const cardId = (await tile.getAttribute('data-card-id'))!
    const shell = page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
    const pencil = shell.getByTestId('nickname-edit')

    // 長押しの前は見えていない（`opacity: 0`）
    await expect(pencil).toHaveCSS('opacity', '0')

    // `touchscreen.tap()` では長押しにならないので CDP で合成する
    await holdTouch(page, tile, { holdMs: 600 })
    await expect(shell).toHaveAttribute('data-selected', 'true')
    await expect(pencil).toHaveCSS('opacity', '1')

    await pencil.tap()
    await page.getByTestId('nickname-input').fill('指で付けた名前')
    await page.getByTestId('nickname-input').press('Enter')

    await expect(
      page.locator(
        `[data-testid="session-tile"][data-card-id="${cardId}"] [data-testid="session-title"]`,
      ),
    ).toHaveText('指で付けた名前', { timeout: 30_000 })
  })
})
