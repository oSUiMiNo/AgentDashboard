import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  holdTouch,
  keyPayload,
  openDashboard,
  openSession,
  scrollTerminalToBottom,
  showTranscript,
  spawnSession,
  swipeTerminal,
  takeSentFrames,
  terminalScroll,
  typeLine,
  watchSentFrames,
} from './helpers'

/**
 * 十字ボタン（ローカルイシュー「スマホで方向キーが要る場面に十字ボタンを出す」
 * テスト計画フェーズ5「ローカル経路」）。
 *
 * # なぜファイル単位で `hasTouch` を立てるのか
 *
 * 十字が出る条件は `(pointer: coarse) and (hover: none)` で、**`hasTouch: true` が
 * その両方を立てる**（フェーズ1 の実測。`isMobile` ではない）。`test.use` は
 * **ファイル単位で効く**ので、ここを丸ごとスマホの土台にしてある。
 *
 * 逆側（PC では出ないこと）は `terminal.spec.ts` が見る——**同じファイルの中では
 * 入力方式を切り替えられない**ため。
 *
 * # 土台は擬似 claude の `/model` の確認画面
 *
 * 既存の選択ダイアログ4本と同じものを使う。本物と同じ形（字下げ1の `❯ 1. …` と
 * `Esc to cancel`）を描き、方向キーで選択が動き、CR で確定する。
 * 責任受諾の画面を使わないのは、**あちらの既定が `No, exit`** で、確定させると
 * 擬似 claude ごと終わってしまうため。
 *
 * # 画面では分からないものは、線の上で見る
 *
 * 「`PtyInput` を通っていること」「連射が何発か」「Esc の2発が別フレームで空いて
 * いること」は、**描かれているかを見ても分からない**。[`watchSentFrames`] で
 * ブラウザが送ったフレームそのものを読む。
 */

test.use({ hasTouch: true })

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** 選択ダイアログが出ているところまで進める。 */
async function openDialog(page: Page) {
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // 会話が進んでいないと確認画面は出ない（本物と同じ）
  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
  await typeLine(page, '/model haiku')
  await expectTerminalToContain(page, 'Esc to cancel')
  await expect(page.getByTestId('dpad')).toBeVisible()
}

test('選択ダイアログが出ると十字が現れる', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  await openDialog(page)

  // 支援技術へも伝わっていること（先に置いてある領域の中身が変わる）
  await expect(page.getByTestId('dpad-live')).toHaveText('方向キーを表示しました')
  // 入力欄は**消えずに畳まれる**（設計§11）
  await expect(page.getByTestId('composer-input')).toHaveAttribute(
    'data-collapsed',
    'true',
  )
})

test('構造化ビューを見ていても十字は出る', async ({ page }) => {
  // 設計§6「タブによらず出す」。権限確認は構造化ビューを見ている最中に来るので、
  // ターミナルのタブに限ると**いちばん要る場面で出ない**
  await watchSentFrames(page)
  await openDashboard(page)
  await openDialog(page)

  await showTranscript(page)
  await expect(page.getByTestId('dpad')).toBeVisible()
})

test('上下で選択が動く', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  await openDialog(page)

  // 既定は「Yes, switch」。1つ下げると「No, go back」になる。
  // **矢印が効かないと選択が動かない**ので、結果が変わることが符号の証拠にもなる
  await page.getByTestId('dpad-下').click()
  await expectTerminalToContain(page, '❯ 2. No, go back')

  await page.getByTestId('dpad-決定').click()
  await expectTerminalToContain(page, '[fake-claude] model-set: （取りやめ）')
})

test('中央で確定できる', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  await openDialog(page)

  await page.getByTestId('dpad-決定').click()

  // **切り替わった値まで見る。** 接頭辞だけだと「取りやめ」にも一致してしまい、
  // 確定でも取り消しでも緑になる
  await expectTerminalToContain(page, '[fake-claude] model-set: haiku')
})

test('十字のキーは PtyInput を通り、入力欄の経路を通らない', async ({ page }) => {
  // **入力欄の経路（`SendInput`）は本文から ESC を落とす。** そちらへ通すと、
  // 矢印も Esc も黙って消える（設計§14）
  await watchSentFrames(page)
  await openDashboard(page)
  await openDialog(page)

  await takeSentFrames(page)
  await page.getByTestId('dpad-下').click()
  // 擬似 claude が描き直すところまで待つ。**届いたことを確かめてから線を読む**
  await expectTerminalToContain(page, '❯ 2. No, go back')

  const sent = await takeSentFrames(page)
  expect(sent.sendInput, '入力欄の経路は1度も通らないこと').toBe(0)
  expect(sent.keys.length, 'PtyInput のフレームが出ていること').toBeGreaterThan(0)
  // 下矢印は `ESC [ B`。**符号そのもの**を見る
  expect(keyPayload(sent.keys[0])).toEqual([0x1b, 0x5b, 0x42])
})

/**
 * ダイアログが閉じると十字は消え、入力欄が戻ること。
 *
 * **選び直してから確定する。** そちらが普段の使い方であり、しかも**壊れていた側**でも
 * ある——擬似 claude がダイアログを描き直さずに書き足していた頃は、前の1枚が画面に
 * 残って「閉じたのに選択待ちに見える」状態になっていた（判定は残骸を正しく読んでいた）。
 * 確定だけの道は `中央で確定できる` が通っている。
 */
test('ダイアログが閉じると十字は消え、入力欄が戻る', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  await openDialog(page)

  await page.getByTestId('dpad-下').click()
  await expectTerminalToContain(page, '❯ 2. No, go back')

  await page.getByTestId('dpad-決定').click()
  await expectTerminalToContain(page, '[fake-claude] model-set: （取りやめ）')

  await expect(page.getByTestId('dpad')).toHaveCount(0)
  await expect(page.getByTestId('dpad-live')).toHaveText('')
  await expect(page.getByTestId('composer-input')).toHaveAttribute(
    'data-collapsed',
    'false',
  )
})

/**
 * 出荷済みの誤爆の回帰（調査レポート §10-3）。
 *
 * 打ちかけの `❯ 1. 手順を書く` は、**画面の字面としては選択肢とまったく同じ形**に
 * なる。違うのは位置だけで、本物の選択肢は字下げされ、入力行は字下げ0で始まる。
 * 直す前の判定は `trimStart()` してから見ていたので、この2つを区別できなかった。
 */
test('打ちかけの ❯ 1. … では十字が出ない', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  // **送らない。** 打ちかけの状態そのものを作る
  await page.getByTestId('terminal').click()
  await page.keyboard.type('❯ 1. 手順を書く')
  await expectTerminalToContain(page, '❯ 1. 手順を書く')

  await expect(page.getByTestId('dpad')).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveAttribute(
    'data-collapsed',
    'false',
  )
})

test('打ちかけの ❯ 1. … のとき素の Enter は改行のまま', async ({ page }) => {
  // **十字が出ないことと、Enter が改行であることは別の性質。** 片方だけ直っても
  // もう片方は壊れうるので、別々に見る
  await watchSentFrames(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('terminal').click()
  await page.keyboard.type('❯ 1. 手順を書く')
  await page.keyboard.press('Enter')
  await page.keyboard.type('つづき')
  await page.keyboard.press('Control+Enter')

  // Enter が確定になっていたら、1行目だけが先に届いて2行にならない
  await expectTerminalToContain(page, '[fake-claude] received: ❯ 1. 手順を書く\nつづき')
})

test('押しっぱなしで連射され、離すと止まる', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  await openDialog(page)

  await takeSentFrames(page)
  // 初期遅延 400ms・以後 55ms（`lib/repeat.ts`）。700ms 押せば 1発目＋数発が出る
  await holdTouch(page, page.getByTestId('dpad-下'), { holdMs: 700 })

  const during = await takeSentFrames(page)
  expect(during.keys.length, '押しっぱなしで連射されること').toBeGreaterThan(2)
  for (const key of during.keys) {
    expect(keyPayload(key), '送っているのは下矢印だけであること').toEqual([
      0x1b, 0x5b, 0x42,
    ])
  }

  // **離したあとに増えないこと。** 止め損ねると、指を離しても走り続ける
  await page.waitForTimeout(400)
  const after = await takeSentFrames(page)
  expect(after.keys.length, '離したら止まること').toBe(0)
})

/**
 * Esc を連打しても巻き戻しのメニューが開かないこと（別イシュー
 * `スマホから作業を停止できない` の完了条件そのもの）。
 *
 * `ESC ESC` が**1つの塊で届くと**巻き戻しが開く（調査レポート §2-2）。橋は
 * カードごとの待ち行列で 30ms 空けるので、塊にならない。
 *
 * **2回の押下を同じ実行の中で起こすのが要点。** Playwright の `click()` を2回
 * 並べると、それだけで実時間が 30ms 以上空いてしまい、**間隔を作っているのが
 * 橋なのかテストなのか区別できなくなる**（＝待ち行列を外しても緑になる）。
 */
test('Esc を連打しても、2発は別のフレームで 30ms 以上空く', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await takeSentFrames(page)
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="esc-key"]')
    if (!button) {
      throw new Error('Esc ボタンが見つかりません')
    }
    // **同じ実行の中で2回。** 待ち行列が無ければ、2発は同じ塊で出て行く
    button.click()
    button.click()
  })

  // 2発目は待ち行列が寝かせてから出るので、少し待ってから読む
  await page.waitForTimeout(200)
  const sent = await takeSentFrames(page)

  expect(sent.keys.length, '2発とも別のフレームで出ること').toBe(2)
  for (const key of sent.keys) {
    expect(keyPayload(key), '送っているのは単独の ESC であること').toEqual([0x1b])
  }
  expect(
    sent.keys[1].at - sent.keys[0].at,
    '塊にならないよう 30ms 空いていること',
  ).toBeGreaterThanOrEqual(30)
})

/**
 * キーを送っても遡り位置が下端へ飛ばないこと。
 *
 * `term.input(…, false)` を選んだ理由がここで担保される。第2引数を `true` にすると
 * xterm が**その場で下端へ飛ばす**ので、選択肢を読むために遡った位置が
 * キーを送るたびに消える——隣のイシューが入れたばかりの仕掛けと正面から衝突する。
 *
 * **Esc ボタンで確かめる。** 十字は画面を見て出入りするので、遡ると（見えている
 * 画面からダイアログが外れて）次の描き直しで消える。Esc は常に出ているうえ、
 * 通る道は十字とまったく同じ（`sendTerminalKey` → `term.input(…, false)`）。
 */
test('キーを送っても遡り位置が下端へ飛ばない', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await typeLine(page, 'flood 100000')
  await expectTerminalToContain(page, '[fake-claude] flood-end')
  await scrollTerminalToBottom(page)
  await swipeTerminal(page, { dy: 240, steps: 8, gapMs: 120 })

  const before = await terminalScroll(page)
  expect(before.viewportY, '遡れていること').toBeLessThan(before.baseY)

  await takeSentFrames(page)
  await page.getByTestId('esc-key').click()
  await expect.poll(async () => (await takeSentFrames(page)).keys.length).toBe(1)

  const after = await terminalScroll(page)
  expect(after.viewportY, 'キーを送っても位置が動かないこと').toBe(before.viewportY)
})

test('書きかけはリロードしても残る', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('composer-input').fill('書きかけの指示')
  await page.reload()
  await expect(page.getByTestId('composer-input')).toHaveValue('書きかけの指示')
})

test('送ったら下書きは消える', async ({ page }) => {
  await watchSentFrames(page)
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)

  await page.getByTestId('composer-input').fill('送る指示')
  await page.getByTestId('composer-input').press('Control+Enter')
  await expectTerminalToContain(page, '[fake-claude] received: 送る指示')

  await page.reload()
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})
