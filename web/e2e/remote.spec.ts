import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  keyPayload,
  openDashboard,
  openSession,
  scrollTerminalToBottom,
  setTerminalView,
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

test('画面の更新間隔に 0.3秒 を選べて、選んだ値が効く', async ({ page }) => {
  // 要件：選択肢は 0.05秒 と 1秒 の間が20倍空いていた。**この欄はリモート構成にしか
  // 無い**（ローカルには画面配信そのものが無い）ので、画面から確かめられるのはここだけ
  await openDashboard(page)
  await page.getByTestId('settings-link').click()

  const select = page.getByTestId('screen-interval-select')
  await expect(select).toHaveValue('20000')

  try {
    await select.selectOption('300')
    // 保存はサーバ往復。**確定を待たずに開き直すと、何を確かめたのか分からなくなる**
    await expect(select).toHaveValue('300')

    await page.reload()
    await expect(page.getByTestId('screen-interval-select')).toHaveValue('300')

    // 選んだ値はセッション画面にも出る。ここの数字が「相手が止まっている」と
    // 「間引かれているだけ」を見分ける唯一の手掛かりになる
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)
    await expect(page.getByTestId('screen-interval')).toContainText(
      '更新間隔 0.3秒',
    )
  } finally {
    // **設定は次のテストへ残る**（E2E は1つのサーバを共有している）。断言が落ちても
    // 戻すために finally へ置く——戻し損ねると、後続が別の周期で走ることになる
    await openDashboard(page)
    await page.getByTestId('settings-link').click()
    await page.getByTestId('screen-interval-select').selectOption('20000')
    await expect(page.getByTestId('screen-interval-select')).toHaveValue('20000')
  }
})

test('端末を閉じても一覧と履歴は動き続ける', async ({ page }) => {
  // 画面の配信を止めても、状態と履歴は別の経路（フック・batch+ack）で流れ続ける。
  // 要件5-5 が名指しで求めている「更新間隔が効くのは画面だけ」の確認にあたる
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 構造化ビューへ戻す＝ターミナルの購読を続けたまま、画面を見ていない状態
  await setTerminalView(page, false)
  await expect(page.getByTestId('session-view')).toHaveAttribute(
    'data-view',
    'transcript',
  )

  // 指示は画面配信と無関係に届く（送信は Ctrl+Enter）
  await page.getByTestId('composer-input').fill('画面を見ていなくても届く')
  await page.keyboard.press('Control+Enter')

  await setTerminalView(page, true)
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

    // **契機は「遡り行数の変更」にした**（設計§7）。
    //
    // 以前は画面の大きさを変えて全画面フレームを起こしていたが、桁行を固定した
    // 工事（`TerminalPane` の `TERMINAL_GRID`）で**ブラウザはリサイズを送らなくなった**
    // ので、あの手はもう効かない。代わりに製品の実経路を使う——設定の変更が
    // `SetIntervals` として PC へ届き、端末を作り直して全画面フレームが飛ぶ。
    //
    // **別のページから変える。** この画面を離れると端末ごと作り直され、遡っていた
    // 位置が消えて、何を確かめたのか分からなくなる。
    //
    // **増やす向きにする。** 減らすと作り直しで遡れる量そのものが縮み、「残っているのに
    // 0」という揺れるテストになる。
    const settings = await page.context().newPage()
    await settings.goto('/settings')
    const input = settings.getByTestId('scrollback-lines-input')
    // **戻す値は画面から読む。** 直に `1000` と書くと、既定が動いた日から嘘になる
    const 元の行数 = await input.inputValue()

    // **`finally` を使わない。** `finally` の中で投げると本体の例外を上書きしてしまい
    // （`no-unsafe-finally`）、本来の失敗が消える。本体の失敗を**投げずに受け止めて**
    // おけば、戻す処理は必ず通り、投げる順番もこちらで決められる
    let 本体の失敗: unknown
    try {
      await input.fill('2000')
      await input.press('Enter')

      await expect
        .poll(async () => Number(await status.getAttribute('data-snapshots')), {
          message: '画面が作り直されること',
          timeout: 30_000,
        })
        .toBeGreaterThan(before)

      // **控えて戻していなければ、ここで下端へ飛んでいる**（設計§9）
      const after = await terminalScroll(page)
      expect(after.baseY - after.viewportY).toBeGreaterThan(0)
    } catch (error) {
      本体の失敗 = error
    }

    // **設定は次の検査へ残る**（E2E は1台のサーバを共有している）。**元の値へ戻し、
    // 戻ったことを断言してから閉じる**——`press` は要求を投げるだけなので、待たずに
    // 閉じると往復ごと中断されうる
    let 戻せなかった: unknown
    try {
      await input.fill(元の行数)
      await input.press('Enter')
      // 保存はサーバ往復。**読み込み直して初めて「効いた」と言える**——入力欄は
      // 打った値をそのまま映すので、画面の値だけでは往復の証拠にならない
      await settings.reload()
      await expect(settings.getByTestId('scrollback-lines-input')).toHaveValue(元の行数)
    } catch (error) {
      戻せなかった = error
    }
    await settings.close()

    // **本来の失敗が先。** 戻し損ねも黙らせない（後続の検査が別の行数で走るため）
    if (本体の失敗 !== undefined) {
      throw 本体の失敗
    }
    if (戻せなかった !== undefined) {
      throw 戻せなかった
    }
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

  test('別の PC の画面でも、出て・動いて・決まって・消える', async ({ page }) => {
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

    // 消える。**矢印を押したあとでも消えること**を見るのが要点——擬似 claude が
    // ダイアログを描き直さずに書き足していた頃は、前の1枚が画面に残って
    // 「閉じたのに選択待ちに見える」状態になっていた
    await expect(page.getByTestId('dpad')).toHaveCount(0)
  })
})
