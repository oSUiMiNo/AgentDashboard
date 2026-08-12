import { expect, test } from '@playwright/test'
import {
  WORK_DIR,
  addProject,
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
} from './helpers'

/**
 * ターミナルビューの通し確認（フェーズ1で作った経路の維持）。
 *
 * ビルドした core サーバ本体に繋ぎ、擬似 claude を相手に
 * 「起動 → 画面に出力が出る → キー入力が届く → 大量出力でフロー制御が働く → 終了」
 * までをブラウザから行う。設計§4/§10 が定める経路が実際に通っていることの検証にあたる。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('セッションを起動してブラウザのターミナルから操作できる', async ({
  page,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // キー入力が PTY まで届き、応答が戻ってくる
  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')

  // ダッシュボードから終了させたものは「異常終了」ではなく「終了」と出る
  await page.getByRole('button', { name: '終了' }).click()
  await expect(page.getByTestId('session-view')).toHaveAttribute(
    'data-status',
    'ended',
  )
  await expect(page.getByText('終了', { exact: true }).first()).toBeVisible()
})

test('Enter と Shift+Enter は改行し、Ctrl+Enter で送信する', async ({
  page,
}) => {
  // xterm の既定では Enter も Shift+Enter も同じ CR を送る。受け取る CLI から見れば
  // 同じバイト列なので、**改行したいのに送信される**。読み替えを外すと、`received` が
  // 3本（abc / def / ghi）に割れてここが落ちる
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('terminal').click()
  await page.keyboard.type('abc')
  await page.keyboard.press('Enter')
  await page.keyboard.type('def')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('ghi')
  await page.keyboard.press('Control+Enter')

  // 1回の指示として届くこと。擬似 claude は受け取った本文をそのまま書き戻すので、
  // 改行が保たれていれば3行に分かれて出る
  await expectTerminalToContain(page, '[fake-claude] received: abc\ndef\nghi')
})

test('大量出力でフロー制御が働き、最後まで取りこぼさず届く', async ({
  page,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // E2E 用の設定はしきい値を小さくしてある（web/e2e/config.toml）ので、
  // 数MBでウォーターマークに到達する
  const floodBytes = 8 * 1024 * 1024
  await typeLine(page, `flood ${floodBytes}`)

  // 出力の途中で少なくとも1回は停止を要求していること
  await expect
    .poll(
      async () =>
        Number(
          await page
            .getByTestId('terminal-status')
            .getAttribute('data-pause-count'),
        ),
      { message: 'フロー制御が発火すること', timeout: 60_000 },
    )
    .toBeGreaterThan(0)

  // 止めても捨てていないので、最後まで届く
  await expectTerminalToContain(page, '[fake-claude] flood-end')

  const status = page.getByTestId('terminal-status')
  // 落ち着いたら再開している（止まりっぱなしにならない）
  await expect(status).toHaveAttribute('data-flow', 'running')

  // 受け取った量が要求量を下回っていない＝取りこぼしていない
  const totalBytes = Number(await status.getAttribute('data-total-bytes'))
  expect(totalBytes).toBeGreaterThanOrEqual(floodBytes)
})

test('存在しない作業ディレクトリを指定すると理由が表示される', async ({
  page,
}) => {
  await openDashboard(page)

  // **枠は足せる。** パスの実在を見るのは起こす瞬間で、枠のほうは寝ている PC の
  // ぶんも足せる必要がある（設計§17）
  const group = await addProject(page, '/存在しないはずのディレクトリ')
  await group.getByTestId('spawn-open').click()
  await group.getByTestId('spawn-mode').selectOption('')
  await group.getByTestId('spawn-button').click()

  await expect(page.getByTestId('error-banner')).toContainText(
    '作業ディレクトリが存在しません',
  )
  await expect(page.getByTestId('session-tile')).toHaveCount(0)
})

test('Windows 側から貼ったバックスラッシュ区切りのパスでも起動できる', async ({
  page,
}) => {
  await openDashboard(page)

  // 利用者がエクスプローラのアドレス欄からそのまま貼る形
  await spawnSession(page, WORK_DIR.replaceAll('/', '\\'))

  // グループ化キーは入力した形ではなく解決後の絶対パスになること。
  // ここが入力のままだと、同じフォルダなのに打ち方の違いで別グループに割れる
  await expect(
    page.locator(`[data-testid="project-group"][data-project="${WORK_DIR}"]`),
  ).toHaveCount(1)
})

/**
 * 選択ダイアログの確定（ローカルイシュー「送信以外の操作も Ctrl+Enter になっている」）。
 *
 * 権限確認や `/rewind` のメニューは、画面に `Enter to confirm` と出ているのに素の Enter が
 * 効かなかった。Enter を一律に改行へ読み替えていたためで、確定には `Ctrl+Enter` が要った。
 * **`Ctrl` を持たないスマホでは確定そのものができなかった。**
 *
 * 擬似 claude の `/model` の確認画面を相手にする。**本物と同じ形**（`❯ 1. …` と
 * `Esc to cancel`）を描き、方向キーで選択が動き、CR で確定する。
 * 責任の受諾（`BYPASS_NOTICE`）ではなくこちらを使うのは、**あちらの既定が
 * `No, exit`** で、確定させると擬似 claude ごと終わってしまうため。
 */
test('選択ダイアログでは素の Enter が確定になる', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 会話が進んでいないと確認画面は出ない（本物と同じ）
  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')

  await typeLine(page, '/model haiku')
  await expectTerminalToContain(page, 'Esc to cancel')

  // ここが本題。**素の Enter** で確定する
  await page.getByTestId('terminal').click()
  await page.keyboard.press('Enter')

  // **切り替わった値まで見る。** 接頭辞だけだと「取りやめ」（`model-set: （取りやめ）`）
  // にも一致してしまい、確定でも取り消しでも緑になる
  await expectTerminalToContain(page, '[fake-claude] model-set: haiku')
})

test('選択ダイアログでは方向キーで選び直してから確定できる', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
  await typeLine(page, '/model haiku')
  await expectTerminalToContain(page, 'Esc to cancel')

  // 既定は「Yes, switch」。1つ下げると「No, go back」になる。
  // **矢印が効かないと選択が動かない**ので、結果が変わることが符号の証拠にもなる
  await page.getByTestId('terminal').click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  await expectTerminalToContain(page, '[fake-claude] model-set: （取りやめ）')
})

test('選択ダイアログでも Ctrl+Enter で確定できる', async ({ page }) => {
  // 判定が外れたときの逃げ道。ここが画面に依存すると、利用者は手段を失う
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
  await typeLine(page, '/model haiku')
  await expectTerminalToContain(page, 'Esc to cancel')

  await page.getByTestId('terminal').click()
  await page.keyboard.press('Control+Enter')

  // **切り替わった値まで見る。** 接頭辞だけだと「取りやめ」（`model-set: （取りやめ）`）
  // にも一致してしまい、確定でも取り消しでも緑になる
  await expectTerminalToContain(page, '[fake-claude] model-set: haiku')
})

test('ダイアログが消えれば Enter は改行へ戻る', async ({ page }) => {
  // **直しすぎていないことの回帰。** 判定が「一度選択待ちを見たら以後ずっと確定」に
  // なっていると、複数行の指示が打てなくなる
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
  await typeLine(page, '/model haiku')
  await expectTerminalToContain(page, 'Esc to cancel')
  await page.getByTestId('terminal').click()
  await page.keyboard.press('Enter')
  // **切り替わった値まで見る。** 接頭辞だけだと「取りやめ」（`model-set: （取りやめ）`）
  // にも一致してしまい、確定でも取り消しでも緑になる
  await expectTerminalToContain(page, '[fake-claude] model-set: haiku')

  // ダイアログが消えたあとは、Enter が改行として効く
  await page.keyboard.type('あか')
  await page.keyboard.press('Enter')
  await page.keyboard.type('あお')
  await page.keyboard.press('Control+Enter')

  await expectTerminalToContain(page, '[fake-claude] received: あか\nあお')
})
