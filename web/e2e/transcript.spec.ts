import { expect, test } from '@playwright/test'
import {
  archiveAll,
  fireHook,
  openDashboard,
  openSession,
  showTerminal,
  showTranscript,
  spawnSession,
  writeTranscript,
} from './helpers'

/**
 * 構造化ビューの通し確認（フェーズ3 / M3）。
 *
 * 実物のフィクスチャ（本物の claude が書いた JSONL）を擬似 claude に書かせ、
 * 「フック → パーサ → WebSocket → 画面」を端から端まで通す。単体テストは各層の中しか
 * 見ないので、経路が繋がっているかはここでしか分からない。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** セッションを起動し、トランスクリプトの場所を core に知らせるところまで。 */
async function startSession(page: Parameters<typeof openDashboard>[0]) {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  return tile
}

test('フィクスチャの履歴が構造化ビューに出る', async ({ page }) => {
  await startSession(page)

  // まだ何も書いていないので空
  await showTranscript(page)
  await expect(page.getByTestId('transcript-status')).toHaveAttribute('data-row-count', '0')

  // 打ち込む先は端末なので、書かせるときはターミナルへ戻す
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')

  await showTranscript(page)
  await expect
    .poll(
      async () =>
        Number(
          await page.getByTestId('transcript-status').getAttribute('data-row-count'),
        ),
      { message: '履歴が届くこと', timeout: 30_000 },
    )
    .toBeGreaterThan(0)

  // ユーザの指示とアシスタントの本文が根に並ぶ
  await expect(page.locator('[data-testid="transcript-row"][data-kind="user_message"]')).toHaveCount(
    1,
  )
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="assistant_text"]').first(),
  ).toBeVisible()
})

test('ツールコールを開くとコードの差分が出る', async ({ page }) => {
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await showTranscript(page)

  // Edit のツールコールを探して開く
  const editRow = page
    .locator('[data-testid="transcript-row"][data-kind="tool_call"]')
    .filter({ hasText: 'Edit' })
    .first()
  await expect(editRow).toBeVisible({ timeout: 30_000 })
  await editRow.getByRole('button').first().click()

  await expect(editRow.getByTestId('diff-view')).toBeVisible()
  // 差分の中身（消えた行・増えた行）が実際に描かれている
  await expect(editRow.getByTestId('diff-view')).toContainText('TODO')
})

test('サブエージェントの中まで掘れる', async ({ page }) => {
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/subagent/session.jsonl')
  await showTranscript(page)

  const agentRow = page
    .locator('[data-testid="transcript-row"][data-kind="tool_call"]')
    .filter({ hasText: 'Agent' })
    .first()
  await expect(agentRow).toBeVisible({ timeout: 30_000 })
  await agentRow.getByRole('button').first().click()

  // サブエージェントの行が現れ、開くとその中の作業が見える
  const subagent = page.locator('[data-testid="transcript-row"][data-kind="subagent"]').first()
  await expect(subagent).toBeVisible()
  await subagent.getByRole('button').first().click()
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="tool_call"]').filter({
      hasText: 'Glob',
    }),
  ).toBeVisible()
})

test('タブを往復してもターミナルの内容が残る', async ({ page }) => {
  // 切り替えのたびに端末を作り直すと、スクロールバックが消えて操作の続きができなくなる
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')

  await showTranscript(page)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'transcript')

  await showTerminal(page)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'terminal')
  // 戻ってきても、それまでの出力がそのまま残っている
  await expect(page.getByTestId('terminal-status')).toHaveAttribute('data-flow', 'running')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const container = document.querySelector('[data-testid="terminal"]') as
          | (HTMLDivElement & { __terminal?: { buffer: { active: { length: number } } } })
          | null
        return container?.__terminal?.buffer.active.length ?? 0
      }),
    )
    .toBeGreaterThan(0)
})
