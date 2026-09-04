import { expect, test, type Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'

import {
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
} from './helpers'

/**
 * スマホでソフトキーボードを出す道
 * （ローカルイシュー「スマホでターミナルビュー内に触れるとキーボードが出てくる」
 * テスト計画フェーズ4・フェーズ8）。
 *
 * # 触った場所で、入り／抜けする（設計§13）
 *
 * ```
 * 入力欄の中   → 入力可能にする（焦点＋キーボード）
 * それ以外     → 入力可能を抜ける（焦点を外す＝カーソルもキーボードも消える）
 * ```
 *
 * **「焦点を一切渡さない」形だった時期がある**（設計§12-2）。渡すとカーソルが出て
 * 「打つ場所が光っているのに打てない」と読まれたためだが、**入力欄そのものを押しても
 * 何も起きない**という別の症状になった（利用者の観測・2026-09-05）。「キーボード」
 * ボタンは、入力欄が見えていない場面の逃げ道として残してある。
 *
 * # 見られるのは属性と焦点まで
 *
 * **「キーボードが実際に出るか」は確かめられない。** 出すかどうかを決めているのは
 * ブラウザで、ここで走る chromium にソフトキーボードは無い。その先は実機で見る。
 *
 * # なぜファイルを分けるのか
 *
 * `hasTouch` は `test.use` の単位で効き、**`describe` の中でも効く**（`terminal.spec.ts`
 * が2箇所でそうしている）。**だから分けなくても書けた**——分けたのは、この工事の
 * 担保を1箇所に集めて読めるようにするためで、道具の制約ではない。
 *
 * ただし `terminal.spec.ts` には**PC 側（タッチ無し）の担保**が要り、そちらは
 * ファイル既定の土台でなければ書けない。**逆側は必ずあちらに残る。**
 */

test.use({ hasTouch: true })

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** その1点を、なぞらずにタップする。 */
async function tap(page: Page, point: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page)
  try {
    // **握らせない。** `touchMove` を挟むと「なぞり」と判定され、経路が変わる
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
  } finally {
    await cdp.detach()
  }
}

/** 端末の真ん中（＝ログのあたり）を、なぞらずにタップする。 */
async function tapTerminal(page: Page) {
  const box = await page.getByTestId('terminal').boundingBox()
  if (!box) {
    throw new Error('端末の位置が取れません')
  }
  await tap(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
}

/**
 * **いま入力欄になっている行**をタップする。
 *
 * 擬似 claude は罫線の枠を描かないので、入力欄は**カーソルの居る行**になる
 * （設計§13-2 の落とし先）。**その行がどこかは端末に聞く**——判定を写して組み立てると、
 * 実装と同じ思い込みを共有したまま緑になる。
 */
async function tapInputRow(page: Page) {
  const point = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="terminal"]') as
      | (HTMLDivElement & { __terminal?: Terminal })
      | null
    const term = box?.__terminal
    const screen = box?.querySelector('.xterm-screen')
    if (!box || !term || !(screen instanceof HTMLElement)) {
      throw new Error('端末が見つかりません')
    }
    const buffer = term.buffer.active
    const row = buffer.cursorY + buffer.baseY - buffer.viewportY
    const rect = screen.getBoundingClientRect()
    const cell = screen.clientHeight / term.rows
    const outer = box.getBoundingClientRect()
    return { x: outer.x + outer.width / 2, y: rect.top + (row + 0.5) * cell }
  })
  await tap(page, point)
}

/** いま端末の隠しテキストエリアに当たっている入力方式。 */
function inputMode(page: Page) {
  return page
    .getByTestId('terminal')
    .locator('.xterm-helper-textarea')
    .getAttribute('inputmode')
}

/** 端末の隠しテキストエリアが、いま焦点を持っているか。 */
function terminalFocused(page: Page) {
  return page.evaluate(() =>
    document.activeElement?.classList.contains('xterm-helper-textarea') === true,
  )
}

/** セッションを起こし、端末を開いて会話を1往復させる。 */
async function openTerminal(page: Page) {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
}

test('ログのあたりをタップしても、キーボードは塞がれたまま', async ({ page }) => {
  // **これが要件そのもの。** ログを読んでいるだけのときに出てはいけない
  await openTerminal(page)

  await tapTerminal(page)

  await expect.poll(() => inputMode(page)).toBe('none')
})

test('ログのあたりをタップしても、焦点は渡らない', async ({ page }) => {
  // 焦点を渡すとカーソルが出る。**「打つ場所が光っているのに打てない」**は、
  // 壊れていると読まれる（利用者の観測・2026-09-04）
  await openTerminal(page)
  // まず入力欄から焦点を外しておく（打ち終わった直後は端末に焦点がある）
  await page.getByTestId('composer-input').click()

  await tapTerminal(page)

  expect(await terminalFocused(page)).toBe(false)
})

test('入力欄の行をタップすると、開いて焦点も来る', async ({ page }) => {
  // **これが問題1の受け皿**（利用者の観測・2026-09-05）。入力欄そのものを押しても
  // 何も起きない形になっていた。上の2本と対で置く——**常に塞ぐ実装でもあちらは通る**
  await openTerminal(page)
  await page.getByTestId('composer-input').click()
  await expect.poll(() => inputMode(page)).toBe('none')

  await tapInputRow(page)

  await expect.poll(() => inputMode(page)).toBe('text')
  expect(await terminalFocused(page)).toBe(true)
})

test('本アプリの入力欄に焦点があっても、端末をタップしたら外れる', async ({ page }) => {
  // **これが問題2の受け皿。** `touchend` で `preventDefault()` を無条件に呼んでいた
  // 頃は、**ブラウザ既定の焦点の移し替えごと止まって**入力欄が焦点を持ったままになり、
  // ブラウザがそれを画面内へ引き戻していた（＝関係ない所を押したのに入力欄へ飛ぶ）
  await openTerminal(page)
  await page.getByTestId('composer-input').click()
  await expect(page.getByTestId('composer-input')).toBeFocused()

  await tapTerminal(page)

  await expect(page.getByTestId('composer-input')).not.toBeFocused()
  // 端末側も掴んでいない＝どこにもカーソルが無い
  expect(await terminalFocused(page)).toBe(false)
  await expect.poll(() => inputMode(page)).toBe('none')
})

test('キーボードを押すと、開いて焦点も来る', async ({ page }) => {
  // 否定側と対で置く。**常に塞ぐ実装でも、上の2本だけなら通る**
  await openTerminal(page)

  await page.getByTestId('keyboard-key').click()

  await expect.poll(() => inputMode(page)).toBe('text')
  expect(await terminalFocused(page)).toBe(true)
})

test('キーボードを閉じると、塞ぎ直される', async ({ page }) => {
  // 戻さないと、次に端末をタップしただけで開いてしまい**元の問題に戻る**
  await openTerminal(page)
  await page.getByTestId('keyboard-key').click()
  await expect.poll(() => inputMode(page)).toBe('text')

  // 端末から焦点を外す＝スマホでキーボードが閉じたときと同じ形
  await page.getByTestId('composer-input').click()

  await expect.poll(() => inputMode(page)).toBe('none')
})
