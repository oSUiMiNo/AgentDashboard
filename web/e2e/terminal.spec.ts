import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  WORK_DIR,
  addProject,
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  scrollTerminalToBottom,
  spawnSession,
  swipeTerminal,
  takePrevented,
  terminalScroll,
  terminalText,
  typeLine,
  watchPrevented,
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

/**
 * 十字ボタンの逆側（ローカルイシュー「スマホで方向キーが要る場面に十字ボタンを出す」
 * テスト計画フェーズ5）。**出ることは `dpad.spec.ts` が見る。**
 *
 * ここに置いてあるのは、**同じファイルの中では入力方式を切り替えられない**ため。
 * `test.use({ hasTouch: true })` はファイル（か describe）の単位でしか効かないので、
 * 「粗いポインタでは出る」と「そうでなければ出ない」は別の土台で見るしかない。
 *
 * 出ないことには2つの意味がある。**画面に出ない**ことと、**端末が画面を組み立てない**
 * こと——後者が効かないと、PC でもフレームごとに解析が走る（設計§4）。
 */
test('粗いポインタでなければ、選択ダイアログでも十字は出ない', async ({ page }) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
  await typeLine(page, '/model haiku')
  await expectTerminalToContain(page, 'Esc to cancel')

  // ダイアログは出ている。**それでも十字は出ない**
  await expect(page.getByTestId('dpad')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveAttribute(
    'data-collapsed',
    'false',
  )
  // Esc ボタンは入力方式によらず常に出る（設計§6）。構造化ビューを見ている間は
  // 端末にフォーカスが無く、**PC でも物理の Esc が届かない**ため
  await expect(page.getByTestId('esc-key')).toBeVisible()
})

/**
 * タッチで遡る（テスト計画フェーズ4「ローカル経路」）。
 *
 * ここで xterm に入るのは**擬似ターミナルの生バイトそのまま**。サーバが作った画面が
 * 入るリモート経路は `remote.spec.ts` が見る——入るものが違うので、片方だけでは
 * 片方が分からない。
 */
test.describe('タッチで遡る', () => {
  // 既定の土台はタッチ無効（`devices['Desktop Chrome']`）。**この describe の中だけ**で
  // 有効にする。ファイル全体へ掛けると、タッチと無関係な既存テストの前提まで変わる
  test.use({ hasTouch: true })

  /** 遡れるだけの行を吐かせて、下端に居る状態で返す。 */
  async function floodedSession(page: Page) {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)
    // 1行62バイトなので、10万バイトで約1600行。なぞるのは1回240px＝十数行なので
    // 十分に足りる。**必要以上に吐かせない**——E2E は1台のサーバを共有しており、
    // ここで作った負荷は次に走るテストが被る
    await typeLine(page, 'flood 100000')
    await expectTerminalToContain(page, '[fake-claude] flood-end')
    await scrollTerminalToBottom(page)
    const at = await terminalScroll(page)
    expect(at.viewportY).toBe(at.baseY)
    return at
  }

  test('なぞると端末の中を遡れる', async ({ page }) => {
    const before = await floodedSession(page)

    // ゆっくりなぞる（1回ごとに間を空けると勢いが乗らない）ので、動くのは指のぶんだけ
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })

    const after = await terminalScroll(page)
    expect(after.viewportY).toBeLessThan(before.viewportY)
  })

  test('1回目に指がブレても遡れる', async ({ page }) => {
    // **実機だけが死んでいた道（フェーズ7）。** 指は真っ直ぐ動き出さないので、1回目は
    // 「横へ2px・縦へ1px」のような値になる。そこで向きを確定させると、決定は指が離れる
    // まで戻らないので**そのなぞりは二度と握れない**。
    //
    // 既定の `swipeTerminal` は1歩目が 30px あるため、この道を一度も通らなかった。
    // **合成タッチで通ることと、指で動くことは別**である
    const before = await floodedSession(page)

    // **ブレは touch slop より大きく取る。** ブラウザは指が一定距離動くまで `touchmove`
    // をページへ配らない。実測では **2px と 12px は1つも届かず、30px で届いた**ので、
    // 小さいブレでは**この道を一度も通せない**（通したつもりで何も確かめないテストになる）。
    //
    // 30px の斜めを1歩目にすると、届く1歩目が「横が勝つ」形になる。壊した状態で走らせると
    // **2歩目から `cancelable` が落ち**、そのなぞりが丸ごと死ぬことまで実測してある
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120, jitter: 30 })

    const after = await terminalScroll(page)
    expect(after.viewportY).toBeLessThan(before.viewportY)
  })

  test('なぞっている間は入力が送られない', async ({ page }) => {
    await floodedSession(page)
    await typeLine(page, 'こんにちは')
    await expectTerminalToContain(page, '[fake-claude] received: こんにちは')

    const countReceived = async () =>
      (await terminalText(page)).split('[fake-claude] received:').length
    const before = await countReceived()

    await scrollTerminalToBottom(page)
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })

    // なぞりが入力に化けていないこと。**化けると受け取りが1本増える**
    expect(await countReceived()).toBe(before)
    // 範囲選択にもなっていないこと
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
  })

  test('行けない向きへのなぞりは、ブラウザへ渡す', async ({ page }) => {
    // 端まで来たらページ側のスクロールへ渡す（設計§7）。いまのセッション専用画面は
    // 外枠が `h-svh` で縦に伸びないので、渡した先が動く場面は無い——**渡していること
    // 自体**を、`preventDefault()` を呼んでいないことで見る
    await floodedSession(page)
    await watchPrevented(page)

    // 下端に居るので、未来（上へなぞる）へは行けない
    await swipeTerminal(page, { dy: -240, steps: 8, gapMs: 120 })
    const released = await takePrevented(page)
    expect(released.length).toBeGreaterThan(0)
    expect(released).not.toContain(true)

    // 過去へは行けるので、そちらは握る（**否定側と対で肯定側も見る**）。
    //
    // **1回でも取りこぼしていないことまで見る。** `touch-action` を指定していないと、
    // 1回目に握っても3回目から `cancelable` が落ちて握れなくなる（フェーズ1 の実測）。
    // 「1回でも握った」で通してしまうと、その壊れ方を見逃す
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })
    const grabbed = await takePrevented(page)
    expect(grabbed.length).toBeGreaterThan(2)
    expect(grabbed).not.toContain(false)
  })

  test('フリックすると、ゆっくりなぞるより深く遡る', async ({ page }) => {
    const bottom = await floodedSession(page)

    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })
    const dragged = bottom.viewportY - (await terminalScroll(page)).viewportY
    expect(dragged).toBeGreaterThan(0)

    await scrollTerminalToBottom(page)
    // 間を空けずに動かすと勢いが乗り、指を離したあとも滑り続ける
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 0 })
    await expect
      .poll(
        async () => bottom.viewportY - (await terminalScroll(page)).viewportY,
        { message: '慣性で、なぞったぶんより深く遡ること' },
      )
      .toBeGreaterThan(dragged)
  })

  test('遡ったあと、何か打つと下端へ戻る', async ({ page }) => {
    // xterm の `scrollOnUserInput`（既定で真）を動かしていないことの担保。
    // ここが効いていれば「遡ったきり戻れない」状態は作られない
    await floodedSession(page)
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })
    const scrolled = await terminalScroll(page)
    expect(scrolled.viewportY).toBeLessThan(scrolled.baseY)

    await page.getByTestId('terminal').click()
    await page.keyboard.type('x')

    await expect
      .poll(async () => {
        const at = await terminalScroll(page)
        return at.baseY - at.viewportY
      })
      .toBe(0)
  })
})
