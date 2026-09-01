import { expect, test } from '@playwright/test'
import {
  archiveAll,
  attachImage,
  expectTerminalToContain,
  openDashboard,
  openSession,
  showTranscript,
  spawnSession,
  terminalText,
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
  // 残ったカードは「スリープ」と出る（設計§6）
  await expect(page.getByTestId('session-view')).toContainText('スリープ')
  await expect(page.getByTestId('composer-input')).toBeDisabled()
})

/**
 * 画像を添付して送ると、履歴に画像の行が出ること（画像添付 テスト計画フェーズ6）。
 *
 * **ここが「端から端まで」の唯一の場所である。** ブラウザで付ける → REST で PC へ置く
 * → 本文へパスを混ぜて PTY へ書く → 印を待って確定する → claude が JSONL を書く
 * → パーサが相棒レコードから置き場所を取る → 画面に絵が出る、という鎖の全部が
 * ここでしか一度に通らない。
 */
test('添付した画像が履歴の行として出る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await attachImage(page)
  // 送信を押すまではブラウザの中にしかない（設計§2）
  await expect(page.getByTestId('composer-attachments')).toBeVisible()

  await page.getByTestId('composer-input').fill('これを見て')
  await page.keyboard.press('Control+Enter')

  // 送れたら添付の列は畳まれる
  await expect(page.getByTestId('composer-attachments')).toBeHidden()
  await expectTerminalToContain(page, '[fake-claude] received: これを見て')

  // 履歴に画像の行が出ること。**絵そのものは生ファイルの口から取り返す**ので、
  // ここで見るのは「行が出たか」まで
  // 履歴は**フックを契機に**読まれるので、届くまで少し待つ（`transcript.spec.ts` と同じ）
  await showTranscript(page)
  await expect(page.getByText('画像').first()).toBeVisible({ timeout: 30_000 })
})

test('付けてから外すと、添付なしの送信になる', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await attachImage(page)
  await page.getByTestId('composer-attachment-remove').first().click()
  await expect(page.getByTestId('composer-attachments')).toBeHidden()

  await page.getByTestId('composer-input').fill('添付なし')
  await page.keyboard.press('Control+Enter')

  await expectTerminalToContain(page, '[fake-claude] received: 添付なし')
  // 外したものが運ばれていないこと＝印が出ていないこと
  const text = await terminalText(page)
  expect(text).not.toContain('[Image #')
})

test('2枚付けると、2枚とも履歴に出る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await attachImage(page, 'one.png')
  await attachImage(page, 'two.png')
  await expect(page.getByTestId('composer-attachment-remove')).toHaveCount(2)

  await page.getByTestId('composer-input').fill('2枚見て')
  await page.keyboard.press('Control+Enter')

  // **印で見る。本文で見ない。**
  //
  // 端末は120桁で折り返すので、**本文の後ろに続く長いパスが行を割る**——実際に
  // `received: 2` と `枚見て` に割れて、素直な部分一致では当たらなかった。印は短く、
  // 割れる余地が無い。しかも `[Image #2]` が出たこと自体が「2枚ぶん揃うまで
  // 確定しなかった」ことの証明になる（設計§7-1）
  await expectTerminalToContain(page, '[Image #2]')

  await showTranscript(page)
  await expect(page.getByText('画像')).toHaveCount(2, { timeout: 30_000 })
})

test('大きすぎる画像は、運ぶ前に断られて理由が出る', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 上限は 8 MiB（設計§8-1）。**運ばせてから断らない**ので、ここで止まる
  await page
    .getByTestId('composer-file')
    .setInputFiles({
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(8 * 1024 * 1024 + 1),
    })

  await expect(page.getByTestId('composer-trouble')).toContainText('上限')
  // 断られたものは列に並ばない
  await expect(page.getByTestId('composer-attachments')).toBeHidden()
})
