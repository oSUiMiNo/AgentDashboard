import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  keyPayload,
  openDashboard,
  openSession,
  scrollTerminalToBottom,
  spawnSession,
  swipeTerminal,
  takeSentFrames,
  terminalScroll,
  typeLine,
  watchSentFrames,
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
   * **フェーズ8 で前提が変わった。** それまでは「差分が届いている間は1行も積まれず、
   * 全画面フレームが届いた瞬間だけ一度に入る」だったので、ここでわざと画面の大きさを
   * 変えて全画面フレームを起こしていた。いまは**流れたぶんが差分と一緒に運ばれる**ので、
   * 吐かせるだけで遡れるようになる（設計§13）。
   *
   * 大きさを変える手は**残さない**。あれを挟むと、運ぶ経路が壊れていても通ってしまう。
   */
  async function scrollbackLoaded(page: Page) {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)
    await typeLine(page, 'flood 200000')
    await expectTerminalToContain(page, '[fake-claude] flood-end')

    await expect
      .poll(async () => (await terminalScroll(page)).baseY, {
        message: '流したぶんが遡れるようになること',
        timeout: 30_000,
      })
      .toBeGreaterThan(0)

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

/**
 * 遡る中身が運ばれること（テスト計画フェーズ6・設計§13）。
 *
 * # なぜ別の describe なのか
 *
 * 上の2本は**測る前にわざと全画面フレームを起こしている**（`scrollbackLoaded()`）。
 * 開き直せば遡る中身は一度に入るので、**運ぶ経路が壊れていても通る**。実際それで
 * 実機の症状を1つも捕まえられず、利用者が3本のセッションを並べて比べるまで
 * 原因が分からなかった。
 *
 * こちらは**開いたまま何もしない**。全画面フレームを起こさずに出力だけを流し、
 * そのあと遡れるかを見る。**リサイズを1回でも挟むと、この検査は意味を失う。**
 */
test.describe('遡る中身が運ばれる', () => {
  /** 開いた直後の全画面フレームが落ち着くまで待ち、その枚数を返す。 */
  async function settled(page: Page): Promise<number> {
    const status = page.getByTestId('terminal-status')
    await expect
      .poll(async () => Number(await status.getAttribute('data-snapshots')), {
        message: '開いた直後の全画面フレームが届くこと',
        timeout: 30_000,
      })
      .toBeGreaterThan(0)
    // 続けて届くぶんが落ち着くまで、値が動かなくなるのを待つ
    let last = -1
    await expect
      .poll(
        async () => {
          const now = Number(await status.getAttribute('data-snapshots'))
          const stable = now === last
          last = now
          return stable
        },
        { message: '全画面フレームが落ち着くこと', timeout: 30_000, intervals: [500] },
      )
      .toBe(true)
    return last
  }

  test('開きっぱなしで流れた行を、あとから遡れる', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    const status = page.getByTestId('terminal-status')
    const snapshots = await settled(page)
    const before = await terminalScroll(page)

    // **リサイズしない。** 画面の大きさを変えると全画面フレームが起きて、
    // そのとき遡る中身が一度に入る＝壊れていても通る
    await typeLine(page, 'flood 200000')
    await expectTerminalToContain(page, '[fake-claude] flood-end')

    const after = await terminalScroll(page)
    // 落ちた場から数字が読めるようにしておく。**「遡れない」だけでは、
    // 運ばれていないのか測り方が悪いのかを切り分けられない**
    console.log(
      `[実測] 開いた直後 ${JSON.stringify(before)} → 流したあと ${JSON.stringify(after)}` +
        ` / 全画面フレーム ${snapshots} → ${await status.getAttribute('data-snapshots')}`,
    )

    // 開いた時点では遡る中身が無い＝**増えたぶんは、開きっぱなしの間に運ばれたもの**
    expect(before.baseY, '開いた時点では遡る中身が無いこと').toBe(0)
    expect(after.baseY, '流れた行がスクロールバックへ積まれていること').toBeGreaterThan(0)
  })

  /**
   * 1行ずつ流れる道（設計§13 の主の仕掛け）。
   *
   * 上のテストは一度に大量が流れるので、**見える範囲より多く流れた側**の受け皿
   * （全画面フレームへ倒す）を通る。こちらは**差分に流れたぶんを前置する**という
   * 主の仕掛けそのものを通すので、全画面フレームが**1枚も増えないこと**まで見る。
   */
  test('1行ずつ流れても、そのぶんだけ遡りが増える', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    // 画面を埋めてからでないと、行は流れ始めない（埋まるまでは下へ伸びるだけ）
    await typeLine(page, 'flood 20000')
    await expectTerminalToContain(page, '[fake-claude] flood-end')
    const snapshots = await settled(page)
    const before = await terminalScroll(page)

    // **少しずつ流す。** 一度に画面ぶんより多く流すと、受け皿（全画面へ倒す）の
    // ほうを通ってしまい、主の仕掛けを一度も踏まない
    const status = page.getByTestId('terminal-status')
    const trail: string[] = []
    for (let round = 1; round <= 4; round += 1) {
      await typeLine(page, 'flood 600')
      await expectTerminalToContain(page, '[fake-claude] flood-end')
      const at = await terminalScroll(page)
      trail.push(`${round}:baseY=${at.baseY}/全画面=${await status.getAttribute('data-snapshots')}`)
    }
    console.log(`[実測] ${trail.join(' ')}`)

    const after = await terminalScroll(page)
    console.log(
      `[実測] 刻んで流す前 ${JSON.stringify(before)} → 後 ${JSON.stringify(after)}` +
        ` / 全画面フレーム ${snapshots} → ${await status.getAttribute('data-snapshots')}`,
    )

    // **主の仕掛けを通ったことの証拠。** 全画面フレームで運ばれたのなら、
    // このテストは受け皿のほうを見ていることになる
    expect(
      Number(await status.getAttribute('data-snapshots')),
      '全画面フレームに頼らずに運ばれていること',
    ).toBe(snapshots)
    expect(after.baseY, '刻んで流れたぶんだけ遡りが増えること').toBeGreaterThan(before.baseY)

    // **画面が壊れていないこと。** 前置した改行のぶん画面がずれると、
    // 遡りは増えても読めるものが出なくなる
    await expectTerminalToContain(page, '[fake-claude] flood-end')
  })
})

/**
 * 十字ボタン（ローカルイシュー「スマホで方向キーが要る場面に十字ボタンを出す」
 * テスト計画フェーズ5「リモート経路」）。
 *
 * # なぜローカルと別に見るのか
 *
 * **スマホが通るのはこちらだけ**である。しかも判定の材料が違う——ローカルの xterm へ
 * 入るのは擬似ターミナルの生バイトだが、こちらへ入るのは**セッションホストの端末
 * エミュレータが作った画面**である。同じ「選択待ち」を、別の字面から導くことになる。
 *
 * キーの向きも1段伸びる。ブラウザ → サーバ → セッションホスト → PTY と渡るので、
 * **`PtyInput` を通っていること**をここで確かめておく価値がある。
 */
test.describe('十字ボタン', () => {
  test.use({ hasTouch: true })

  test('別の PC の画面でも、出て・動いて・キーが PtyInput を通る', async ({ page }) => {
    await watchSentFrames(page)
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    await typeLine(page, 'こんにちは')
    await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
    await typeLine(page, '/model haiku')
    await expectTerminalToContain(page, 'Esc to cancel')

    // 出る
    await expect(page.getByTestId('dpad')).toBeVisible()
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'data-collapsed',
      'true',
    )

    // 動く（既定の「Yes, switch」から1つ下げる）
    await takeSentFrames(page)
    await page.getByTestId('dpad-下').click()
    await expectTerminalToContain(page, '❯ 2. No, go back')

    // **キーは `PtyInput` を通り、入力欄の経路を通らない。** あちらは本文から ESC を
    // 落とすので、通していたら矢印は黙って消える（設計§14）
    const sent = await takeSentFrames(page)
    expect(sent.sendInput, '入力欄の経路は1度も通らないこと').toBe(0)
    expect(keyPayload(sent.keys[0]), '下矢印の符号そのもの').toEqual([0x1b, 0x5b, 0x42])

    // 決まる
    await page.getByTestId('dpad-決定').click()
    await expectTerminalToContain(page, '[fake-claude] model-set: （取りやめ）')
  })

  /**
   * 決まって、消えるところまで。
   *
   * **矢印を押さずに確定する。** 擬似 claude はエコーを残す作りなので、矢印を送ると
   * その符号が `^[[B` という**字**として画面へ出る（tty が制御文字をそう echo する）。
   * すると1行ずれて `clear_dialog` が消し損ね、**前のダイアログが画面に残る**。
   * 判定はその残骸を正しく「選択待ち」と読むので、十字は出たままになる。
   *
   * **製品の問題ではない**——本物の claude は echo を切って自分で描き直すので、この形に
   * ならない。ローカル経路でも同じ残骸が出ることを実測して切り分けてある。
   */
  test('別の PC の画面でも、確定すると十字は消える', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    await typeLine(page, 'こんにちは')
    await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
    await typeLine(page, '/model haiku')
    await expectTerminalToContain(page, 'Esc to cancel')
    await expect(page.getByTestId('dpad')).toBeVisible()

    await page.getByTestId('dpad-決定').click()
    await expectTerminalToContain(page, '[fake-claude] model-set: haiku')

    await expect(page.getByTestId('dpad')).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'data-collapsed',
      'false',
    )
  })
})
