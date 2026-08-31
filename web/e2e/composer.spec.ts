import { expect, test } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
} from './helpers'

/**
 * Composer からの指示送信の通し確認（設計§4/§6）。
 *
 * ブラウザの入力欄 → WebSocket（`send_input`）→ core → PTY、という経路がつながって
 * いることを確かめる。相手は擬似 claude なので**バイトが届いたこと**までが範囲で、
 * 「複数行が本物の TUI で1つの指示として解釈されるか」は実 CLI テスト
 * （`server/crates/core/tests/real_cli.rs`）が担う。擬似 claude は TUI ではなく、
 * bracketed paste を解釈しないため、ここで確かめても意味が無い。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('入力欄から送った指示が PTY まで届く', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('composer-input').fill('こんにちは')
  // 送信は Ctrl+Enter（端末と同じ割り当て。`lib/keys.ts`）
  await page.keyboard.press('Control+Enter')

  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
  // 送ったら入力欄は空に戻る（同じ指示を二重に送る事故を防ぐ）
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})

test('スラッシュコマンドも加工せずそのまま届く', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('composer-input').fill('/status')
  await page.keyboard.press('Control+Enter')

  await expectTerminalToContain(page, '[fake-claude] received: /status')
})

test('複数行の指示は bracketed paste で包まれて届く', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  const input = page.getByTestId('composer-input')
  await input.fill('1行目')
  // **素の Enter は送信ではなく改行**。ここで送信されていれば入力欄は空になるので、
  // 次の検査がそのまま「Enter で送らない」ことの回帰になる
  await page.keyboard.press('Enter')
  await page.keyboard.type('2行目')
  await expect(input).toHaveValue('1行目\n2行目')

  await page.keyboard.press('Control+Enter')

  // 貼り付けの開始記号が端末まで届いていれば、サーバが包んだことが分かる。
  // 包まないと1行目だけが確定してしまう
  await expectTerminalToContain(page, '[200~1行目')
  await expectTerminalToContain(page, '2行目')
})

test('終了したセッションでは指示を送れない', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // **ボタンでは作れなくなった。** 「終了」を押すとカードごと一覧から外れるので
  // （帯の設計§5）、`ended` のまま残るカードは**こちらが頼んでいない終わり方**を
  // したものだけになる。擬似 claude は入力行 `exit` で自分から終わるので、それで作る
  await typeLine(page, 'exit')
  await expect(page.getByTestId('session-view')).toHaveAttribute(
    'data-status',
    'ended',
    { timeout: 20_000 },
  )
  // 残ったカードは「消息不明」と出る（設計§6）
  await expect(page.getByTestId('session-view')).toContainText('消息不明')
  await expect(page.getByTestId('composer-input')).toBeDisabled()
})
