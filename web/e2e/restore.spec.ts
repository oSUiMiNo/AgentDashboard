import { expect, test } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  fireHook,
  openDashboard,
  openSession,
  showTerminal,
  showTranscript,
  spawnSession,
  typeLine,
  writeTranscript,
} from './helpers'

/**
 * リロードからの復元（テスト計画フェーズ5「リロード復元」）。
 *
 * **真実は常にサーバ側にある**、という設計§11 の言い分が本当かを確かめる。ブラウザを
 * 作り直しても、一覧・状態・履歴・端末のスクロールバックがすべて戻ってくるなら、
 * ブラウザ側は使い捨ての写しでよいことになる。
 *
 * 戻す手順は「REST で全体 → WebSocket を開く → 開いていた購読を出し直す」。自動再接続も
 * 同じ手順を通るので、ここが通っていれば接続が落ちても同じように戻る（単体側は
 * `src/stores/ws.test.ts`）。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('リロードしても状態・履歴・端末の内容が戻る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 端末に痕跡を残す（スクロールバックはサーバのリングバッファが持っている）
  const marker = 'リロード前のしるし'
  await fireHook(page, 'SessionStart')
  await fireHook(page, 'UserPromptSubmit')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await typeLine(page, marker)
  await expectTerminalToContain(page, `[fake-claude] received: ${marker}`)

  await showTranscript(page)
  const rowCount = async () =>
    Number(
      await page.getByTestId('transcript-status').getAttribute('data-row-count'),
    )
  await expect
    .poll(rowCount, { message: '履歴が届くこと', timeout: 30_000 })
    .toBeGreaterThan(0)
  const before = await rowCount()

  // ここでブラウザを作り直す
  await page.reload()

  // 状態はサーバが持っているので、フックの結果がそのまま出る
  const view = page.getByTestId('session-view')
  await expect(view).toBeVisible()
  await expect(view).toHaveAttribute('data-status', 'working')

  // 履歴は購読の出し直しで戻る
  await showTranscript(page)
  await expect
    .poll(rowCount, { message: '履歴が戻ること', timeout: 30_000 })
    .toBe(before)

  // 端末はサーバのリングバッファからスナップショットが届いて描き直される。
  // リロード前に打ち込んだ内容がそのまま見えれば、操作の続きができる
  await showTerminal(page)
  await expectTerminalToContain(page, `[fake-claude] received: ${marker}`)
})
