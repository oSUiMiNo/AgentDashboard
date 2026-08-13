import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  scrollTerminalToBottom,
  spawnSession,
  swipeTerminal,
  terminalScroll,
  typeLine,
} from './helpers'

/**
 * セルフホスト構成の通し確認（セルフホスト化設計§7、テスト計画フェーズ4）。
 *
 * # ローカルモードの E2E とどこが違うのか
 *
 * 画面に映るものは同じでも、届き方がまったく違う。
 *
 * ```text
 * ローカル : PTY の生バイト ────────────────────▶ xterm.js
 * リモート : PTY の生バイト → vt100 → 画面/差分 → 種別を移し替え → xterm.js
 * ```
 *
 * 後者は**この構成でしか通らない**。フェーズ3 では「一覧に出ているカードを開いた瞬間に
 * 見つかりませんと言われる」という不具合を、動くかどうかのテストでは1つも捕まえられず、
 * 実物を見て初めて気づいた。同じ形の見落としを塞ぐのがここの役目にあたる。
 *
 * # 何を確かめれば「無改修」が言えるのか
 *
 * ブラウザ側のコード（`TerminalPane` / `frame.ts`）はセルフホスト化で1行も変えていない。
 * つまり **0x03＝作り直して書く／0x01＝書き足す** という既存の意味論のまま画面が出れば、
 * サーバの移し替え（0x04→0x03 / 0x05→0x01）が正しかったことになる。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('別の PC のセッションを起こして画面が出る', async ({ page }) => {
  await openDashboard(page)

  // 起動の指示は A2S を渡り、CardId は PC 側で採番される（設計§5-2）
  const tile = await spawnSession(page)

  // 画面はセッションホスト内の端末エミュレータが作ったもの。**生バイトは1バイトも
  // ブラウザまで来ていない**（要件5-2）
  await openSession(page, tile)

  // キー入力は逆向きに渡り、返ってきた応答は次の画面に映る
  await typeLine(page, 'リモートから')
  await expectTerminalToContain(page, '[fake-claude] received: リモートから')
})

test('更新間隔がヘッダに出る', async ({ page }) => {
  // 別の PC の画面は、何もしていない間は間隔をあけて届く（設計§11-3）。
  // 数字が無いと「相手が止まっている」と「間引かれているだけ」が区別できない
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await expect(page.getByTestId('screen-interval')).toBeVisible()
  await expect(page.getByTestId('screen-interval')).toContainText('更新間隔')
})

test('端末を閉じても一覧と履歴は動き続ける', async ({ page }) => {
  // 画面の配信を止めても、状態と履歴は別の経路（フック・batch+ack）で流れ続ける。
  // 要件5-5 が名指しで求めている「更新間隔が効くのは画面だけ」の確認にあたる
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 構造化ビューへ戻す＝ターミナルの購読を続けたまま、画面を見ていない状態
  await page.getByTestId('view-tab-transcript').click()
  await expect(page.getByTestId('session-view')).toHaveAttribute(
    'data-view',
    'transcript',
  )

  // 指示は画面配信と無関係に届く（送信は Ctrl+Enter）
  await page.getByTestId('composer-input').fill('画面を見ていなくても届く')
  await page.keyboard.press('Control+Enter')

  await page.getByTestId('view-tab-terminal').click()
  await expectTerminalToContain(
    page,
    '[fake-claude] received: 画面を見ていなくても届く',
  )
})

/**
 * タッチで遡る（テスト計画フェーズ4「リモート経路」）。
 *
 * ローカルと同じ操作でも、**xterm へ入るものが違う**——こちらはセッションホストの
 * 端末エミュレータが作った画面のエスケープ列である。だから片方だけでは片方が分からない。
 */
test.describe('タッチで遡る', () => {
  test.use({ hasTouch: true })

  /**
   * 遡れる中身を持った状態にして返す。
   *
   * **順序が命。** 差分が届いている間、xterm のスクロールバックは1行も積まれない
   * （差分は可視領域を描き直す形なので、押し出された行はどこにも残らない）。
   * **全画面フレームが届いた瞬間だけ**、そのときのスクロールバックが一度に入る
   * （フェーズ1 の実測。設計§9 の「既知の制約」）。
   *
   * だから「吐かせる → 画面の大きさを変える（＝全画面フレームを起こす）」の順で行う。
   */
  async function scrollbackLoaded(page: Page) {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)
    await typeLine(page, 'flood 200000')
    await expectTerminalToContain(page, '[fake-claude] flood-end')

    const before = await terminalScroll(page)
    await page.setViewportSize({ width: 1000, height: 700 })

    // 全画面フレームが届くと、スクロールバックごと入れ替わって総行数が跳ねる
    await expect
      .poll(async () => (await terminalScroll(page)).length, {
        message: '全画面フレームで遡る行が入ること',
        timeout: 30_000,
      })
      .toBeGreaterThan(before.length)

    await scrollTerminalToBottom(page)
    return terminalScroll(page)
  }

  test('別の PC の画面でも、なぞって遡れる', async ({ page }) => {
    const bottom = await scrollbackLoaded(page)

    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })

    const after = await terminalScroll(page)
    expect(after.viewportY).toBeLessThan(bottom.viewportY)
  })

  test('画面が作り直されても、遡っていた位置が保たれる', async ({ page }) => {
    await scrollbackLoaded(page)
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })

    const scrolled = await terminalScroll(page)
    expect(scrolled.baseY - scrolled.viewportY).toBeGreaterThan(0)

    // **作り直しが済むまで待ってから測る。** ここを待たずに「遡ったままか」を
    // 見ると、届く前の値で通ってしまう（実際にそう書いて空振りさせた）。
    // 数えているのは**書き終えた**全画面フレームなので、戻す処理まで済んでいる
    const status = page.getByTestId('terminal-status')
    const before = Number(await status.getAttribute('data-snapshots'))

    // もう一度画面の大きさを変える＝全画面フレーム＝`term.reset()`。
    // **控えて戻していなければ、ここで下端へ飛ぶ**（設計§9）
    await page.setViewportSize({ width: 1100, height: 800 })
    await expect
      .poll(async () => Number(await status.getAttribute('data-snapshots')), {
        message: '画面が作り直されること',
        timeout: 30_000,
      })
      .toBeGreaterThan(before)

    const after = await terminalScroll(page)
    expect(after.baseY - after.viewportY).toBeGreaterThan(0)
  })
})
