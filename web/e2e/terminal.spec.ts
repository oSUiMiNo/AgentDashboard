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
  takeSentFrames,
  terminalScroll,
  terminalText,
  typeLine,
  watchPrevented,
  watchSentFrames,
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

  // **ダッシュボードから終了させたカードは、そのまま一覧から消えて一覧へ移る**
  // （帯の設計§5）。以前は `ended` として残り「終了」と出ていたが、**終了と削除を
  // 1つのボタンへ結合した**ので、押すと `Kill` → `ended` を待つ → `Archive` と進む。
  //
  // **消えたことはサーバに聞く。** 画面の小窓を数えると「まだ描かれていない」と
  // 「もう無い」を読み違える
  const cardId = await page
    .getByTestId('session-view')
    .getAttribute('data-card-id')
  await page.getByTestId('close-card').click()

  await expect(page).toHaveURL('/')
  await expect
    .poll(
      async () => {
        const origin = new URL(page.url()).origin
        const response = await page.request.get(`${origin}/api/sessions`)
        const sessions = (await response.json()) as { card_id: string }[]
        return sessions.some((session) => session.card_id === cardId)
      },
      { message: 'サーバ側からもカードが消えること', timeout: 20_000 },
    )
    .toBe(false)
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

/**
 * 格子は入れ物から決めない（テスト計画フェーズ3・設計§2・§4-1・§6-1）。
 *
 * # なぜ実物のブラウザでしか確かめられないのか
 *
 * 単体（jsdom）はレイアウトを持たないので、**入れ物の大きさが変わるという出来事
 * そのものを作れない**。「変えても動かない」は、変えられる場所でしか言えない。
 *
 * # 何が要件の中心か
 *
 * 「PC とスマホで同時に開いても、互いの表示を引っ張らない」。端末の大きさは
 * **最後に届いた指示が勝つ**（初期実装§10）ので、どのブラウザも同じ値を送るように
 * すれば規則を変えずに引っ張り合いだけが消える。**2枚のページで再現できる。**
 */
test.describe('端末の格子', () => {
  /** いま端末が何桁×何行か（画面ではなく端末そのものに聞く）。 */
  async function 桁行(page: Page) {
    return page.evaluate(() => {
      const box = document.querySelector('[data-testid="terminal"]') as
        | (HTMLElement & { __terminal?: { cols: number; rows: number } })
        | null
      const term = box?.__terminal
      return { cols: term?.cols ?? -1, rows: term?.rows ?? -1 }
    })
  }

  test('入れ物の大きさを変えても、桁行が動かない', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    expect(await 桁行(page)).toEqual({ cols: 120, rows: 40 })

    for (const size of [
      { width: 390, height: 780 },
      { width: 1600, height: 1000 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(size)
      // 変わるとしたら変えた直後なので、少し置いてから聞く
      await page.waitForTimeout(300)
      expect(await 桁行(page), `${size.width}x${size.height} で動かないこと`).toEqual({
        cols: 120,
        rows: 40,
      })
    }
  })

  test('入れ物の大きさを変えても、リサイズを頼まない', async ({ page }) => {
    // **画面を見ても分からない**ので、線の上で数える。頼んでいれば、その値が
    // そのまま相手の PTY を作り替える
    await watchSentFrames(page)
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    await takeSentFrames(page)

    await page.setViewportSize({ width: 390, height: 780 })
    await page.waitForTimeout(300)
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.waitForTimeout(300)

    // **否定だけでは、線が丸ごと死んでいても通る。** 同じ観測の中で「送れば増える」
    // ことを見せて初めて、0 に意味が出る（ガイドライン「『流れていないこと』を確かめる
    // 検査は、空振りしていないかまで見る」）
    await page.getByTestId('terminal').click()
    await page.keyboard.type('x')

    const sent = await takeSentFrames(page)
    expect(sent.resize, 'リサイズを1回も頼んでいないこと').toBe(0)
    expect(sent.keys.length, '同じ線でキーは届いていること（0 が空振りでない裏取り）')
      .toBeGreaterThan(0)
  })

  test('2枚のページで開いても、互いの桁行を引っ張らない', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    const cardId = await tile.getAttribute('data-card-id')
    // **`null` のまま URL へ入れない。** 属性名が変わると `/s/null` を開くことになり、
    // 症状は「見つかりませんの画面でタブが押せない」——原因を名指ししない失敗になる
    expect(cardId, '小窓が data-card-id を持っていること').not.toBeNull()
    await openSession(page, tile)

    // もう1枚（別の端末の代わり）。**同じカードを同時に見ている状態**を作る
    const other = await page.context().newPage()
    await other.goto(`/s/${cardId}`)
    await other.getByTestId('view-tab-terminal').click()
    await expect(other.getByTestId('session-view')).toHaveAttribute(
      'data-view',
      'terminal',
    )

    try {
      // 片方だけをスマホの幅にする。**以前はこれで、もう片方の表示まで作り替わっていた**
      await other.setViewportSize({ width: 390, height: 780 })
      await other.waitForTimeout(300)

      expect(await 桁行(page), '見ていないほうが引っ張られないこと').toEqual({
        cols: 120,
        rows: 40,
      })
      expect(await 桁行(other), '狭いほうも同じ格子であること').toEqual({
        cols: 120,
        rows: 40,
      })
    } finally {
      await other.close()
    }
  })

  test('狭い入れ物では横へスクロールでき、下端が揃う', async ({ page }) => {
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)

    await page.setViewportSize({ width: 390, height: 780 })
    await page.waitForTimeout(300)

    const 窓 = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="terminal"]') as HTMLElement
      const grid = box.querySelector('.xterm') as HTMLElement
      const boxRect = box.getBoundingClientRect()
      const gridRect = grid.getBoundingClientRect()
      return {
        横へはみ出す: box.scrollWidth > box.clientWidth,
        // 入れ物には余白（`p-2`）があるので、ぴったり 0 にはならない
        下端の差: Math.round(boxRect.bottom - gridRect.bottom),
        縦にはみ出す: gridRect.height > box.clientHeight,
        上端の差: Math.round(gridRect.top - boxRect.top),
        // **横スクロールバーは、環境によって場所を取る。** 重ねて出る（オーバーレイの）
        // 環境では 0、取る環境では十数 px。ここを見込まないと、**同じ実装なのに
        // 環境で合否が変わる**検査になる
        バーの厚み: box.offsetHeight - box.clientHeight,
      }
    })

    expect(窓.横へはみ出す, '横へはみ出したぶんはスクロールで読めること').toBe(true)
    // 許容は「入れ物の余白（`p-2` ＝ 8px）＋ 実際に場所を取っているバーの厚み」。
    // 数字を直に書くと、バーが場所を取る環境で落ちる
    expect(窓.下端の差, '格子が下端へ貼り付いていること').toBeLessThanOrEqual(
      8 + 窓.バーの厚み,
    )
    if (窓.縦にはみ出す) {
      // 貼り付けた結果、切り落とされるのは**常に上側**になる
      expect(窓.上端の差, '切り落とされるのは上側であること').toBeLessThan(0)
    }
  })

})

/**
 * 窓を**指で触る**（コードレビュー対応2）。
 *
 * 既定の土台はタッチ無効（`devices['Desktop Chrome']`）なので、**この describe の中だけ**で
 * 有効にする。ファイル全体へ掛けると、タッチと無関係な既存テストの前提まで変わる。
 *
 * ここを分けてあるのは、**`touch-action: pan-x` の効き目がタッチの有無で変わる**ためである。
 * 入れ物が本当に横スクロールするようになったので、ブラウザへ譲った横パンが遡りと
 * 取り合いうる——**タッチが無効な土台で試すと、その取り合いごと起きない**。
 */
test.describe('端末の窓を指で触る', () => {
  test.use({ hasTouch: true })

  test('狭い画面で斜めになぞっても、遡れて窓は動かない', async ({ page }) => {
    // **`touch-action: pan-x` は、横へ本当にスクロールするようになって初めて効く。**
    // 斜めの1歩目をブラウザが「横パン」と読むと、以後の `touchmove` が `cancelable` を
    // 失って遡りが死ぬ——という筋がある（コードレビュー対応2）。
    //
    // **空いていたのはこの組み合わせだけ**である。`jitter` つきの検査は広い画面
    // （横スクロールが出ない）で、狭い画面の検査は真っ直ぐなぞっていた。
    //
    // 合成タッチでは再現しないことを実測で確かめてあるが、**合成と指は別**
    // （十字ボタン フェーズ7）。ここは実機で見るための材料である。
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)
    await page.setViewportSize({ width: 390, height: 780 })
    await typeLine(page, 'flood 200000')
    await expectTerminalToContain(page, '[fake-claude] flood-end')
    await scrollTerminalToBottom(page)

    const 窓 = () =>
      page.evaluate(() => {
        const box = document.querySelector('[data-testid="terminal"]') as HTMLElement
        return { scrollLeft: box.scrollLeft, はみ出す: box.scrollWidth > box.clientWidth }
      })
    const 前 = await 窓()
    expect(前.はみ出す, '横スクロールが出ている状態で試すこと').toBe(true)
    const bottom = await terminalScroll(page)

    // **1歩目を横へ大きくブレさせる。** 真っ直ぐな合成なぞりでは作れない状況
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120, jitter: 30 })

    const after = await terminalScroll(page)
    expect(after.viewportY, '斜めでも遡れること').toBeLessThan(bottom.viewportY)
    const 後 = await 窓()
    expect(後.scrollLeft, '横へ持っていかれていないこと').toBe(前.scrollLeft)
  })

  test('横へはみ出していても、なぞって遡れる', async ({ page }) => {
    // 横の払いはブラウザ（窓のスクロール）へ、縦は端末の遡りへ。**分担は
    // `touch-action: pan-x` が最初から持っている**ので、窓にしても変わらない
    await openDashboard(page)
    const tile = await spawnSession(page)
    await openSession(page, tile)
    await page.setViewportSize({ width: 390, height: 780 })
    await typeLine(page, 'flood 200000')
    await expectTerminalToContain(page, '[fake-claude] flood-end')
    await scrollTerminalToBottom(page)

    const bottom = await terminalScroll(page)
    await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })

    const after = await terminalScroll(page)
    expect(after.viewportY).toBeLessThan(bottom.viewportY)
  })
})

test('終了を続けて押しても、カードが一覧へ戻らない', async ({ page }) => {
  // **押す機会が増えたぶんの見張り**（帯の設計§5）。以前は「削除」を押したときだけ
  // `Archive` が飛んでいたが、いまは**終了のたびに飛ぶ**。`Kill` と `Archive` を
  // 同時に送ると、飛行中だった報告が後から着地して**外したカードが一覧へ戻る**
  // （未解決の既知の壊れ方）——`ended` を待ってから外すのはそれを避けるため
  await openDashboard(page)
  const first = await spawnSession(page)
  await openSession(page, first)
  await page.getByTestId('close-card').click()
  await expect(page).toHaveURL('/')

  const second = await spawnSession(page)
  await openSession(page, second)
  await page.getByTestId('close-card').click()
  await expect(page).toHaveURL('/')

  // **サーバに聞く。** 画面の小窓を数えると「まだ描かれていない」と「もう無い」を
  // 読み違える。蘇りは遅れて着地するので、少し待ってから数える
  await expect
    .poll(
      async () => {
        const origin = new URL(page.url()).origin
        const response = await page.request.get(`${origin}/api/sessions`)
        return ((await response.json()) as unknown[]).length
      },
      { message: 'カードが1枚も残らないこと', timeout: 20_000 },
    )
    .toBe(0)
})

test('自分から終わったカードは「消息不明」として残り、削除で消せる', async ({
  page,
}) => {
  // **こちらが頼んだ終了は、そもそも画面に残らない**（上のテスト）。したがって
  // `ended` として残るカードは必ず「頼んでいない終わり方をしたもの」になり、
  // そこへ「消息不明」という言い方を当てている（帯の設計§6）。
  //
  // **消す道が残っていることの担保**でもある——放っておくと消息不明のカードが
  // 一覧に溜まり、一覧の小窓には消すボタンが無い（押すと開くだけ）
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 擬似 claude は入力行 `exit` で自分から終わる
  await typeLine(page, 'exit')
  const view = page.getByTestId('session-view')
  await expect(view).toHaveAttribute('data-status', 'ended', {
    timeout: 20_000,
  })
  await expect(view).toContainText('消息不明')

  // **一覧の小窓にも同じ語が出る。** 同じ関数（`statusLabel`）を使っているので
  // 自動で揃うが、**勝手に死んだことに一覧で気づけること**がこの道具の目的そのもの
  const cardId = await view.getAttribute('data-card-id')
  await page.goto('/')
  // **見る相手は `tile-shell`**（外側）。状態の札は右下へ抜けていて、`session-tile`
  // （中のボタン）の中には入っていない——①行は最終活動と接続断で埋まっており、
  // 状態ラベルを入れると 212px に 290px を詰めることになる（`tile.spec.ts` の実測）
  const 小窓 = page.locator(
    `[data-testid="tile-shell"][data-card-id="${cardId}"]`,
  )
  await expect(小窓).toContainText('消息不明')

  // 消せる
  await page.goto(`/s/${cardId}`)
  await expect(page.getByTestId('close-card')).toHaveText('削除')
  await page.getByTestId('close-card').click()
  await expect
    .poll(
      async () => {
        const origin = new URL(page.url()).origin
        const response = await page.request.get(`${origin}/api/sessions`)
        const sessions = (await response.json()) as { card_id: string }[]
        return sessions.some((session) => session.card_id === cardId)
      },
      { message: '消息不明のカードを消せること', timeout: 20_000 },
    )
    .toBe(false)
})
