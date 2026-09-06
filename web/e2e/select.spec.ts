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
 * 長押しで、端末の文字を「普段どおり」選ぶ
 * （イシュー「スマホでターミナルの文字をコピーできない」テスト計画フェーズ5）。
 *
 * # スマホの実寸で走らせる
 *
 * **既定の `Desktop Chrome`（1280×720）では、この工事が直した壊れ方が原理的に出ない。**
 * 前の版のコピーボタンは端末の右上に固定されており、広い窓では確かに見えていた——
 * `toBeVisible()` も通っていた。**Playwright の「見えている」は窓の中に居ることを
 * 要求しない**ので、狭い画面で外へ出ていても緑になる。
 *
 * 実測はこうだった。390×844 では的は x=309・y=166 に出て覆われてもいない。だが
 * **端末は 120 桁で、一文字が 6px にしかならない**（格子 720px を 366px の窓で覗く）。
 * 読むには拡大が要り、**3倍に拡大すると見える範囲は 130×281 まで狭まって的は外へ出る**。
 *
 * **だからここは狭い窓で走らせる。** 広い窓で測ると、利用者が踏んだ道を1歩も歩かない。
 *
 * # ここでしか見られないもの
 *
 * **文字が本当に DOM に在るか。** jsdom は差し込んだ値を返すだけなので、実物の
 * ブラウザで `user-select` の計算値まで見て初めて「選べる形で出ている」と言える。
 *
 * # 見られないもの
 *
 * **選択ハンドルとコピーのメニューそのもの。** あれを出すのは OS で、ここで走る
 * chromium には無い。**その先は実機で見る**（テスト計画フェーズ6）。
 *
 * **写せたかどうか。** ここは `localhost` ＝安全なオリジンなので、実機（素の HTTP）
 * とは通る枝が違う（`lib/clipboard.ts`）。
 *
 * # なぜファイルを分けるのか
 *
 * `keyboard.spec.ts` は**前のイシューの約束**（枠のタップで開く／枠の外で抜ける／
 * 引き戻されない）を持っている。**あちらが1本も落ちないことが、この工事の合格条件**
 * なので、混ぜずに残す。
 */

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** 長押しと呼べる時間（ms）。実装（`LONG_PRESS_MS`）より余裕を持たせる。 */
const PRESS_MS = 800

/** その1点を、指を動かさずに押し続けてから離す。 */
async function press(page: Page, point: { x: number; y: number }, ms = PRESS_MS) {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    })
    // **`touchMove` を挟まない。** 挟むと「なぞり」と判定され、計時が止まる
    await page.waitForTimeout(ms)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }
}

/**
 * 画面が動かなくなるまで待つ。
 *
 * 擬似 claude は返事のあとにも状態行を書くので、**座標を測った直後に画面が流れる**。
 * 流れると、押した行と測った行が別物になる（実測で2本落とした）。
 */
async function settle(page: Page) {
  let last = ''
  for (let i = 0; i < 25; i += 1) {
    const now = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="terminal"]') as
        | (HTMLDivElement & { __terminal?: Terminal })
        | null
      const buffer = box?.__terminal?.buffer.active
      return `${buffer?.baseY ?? -1}/${buffer?.length ?? -1}/${buffer?.cursorY ?? -1}`
    })
    if (now === last) {
      return
    }
    last = now
    await page.waitForTimeout(200)
  }
}

/**
 * **中身のある行**の座標。
 *
 * 端末の真ん中を押してはいけない。格子は 40 行あるのに擬似 claude が書くのは数行
 * なので、**真ん中はたいてい空行**である（実測で1本落とした）。
 *
 * **どの行に中身があるかは端末に聞く。** 判定を写して組み立てると、実装と同じ
 * 思い込みを共有したまま緑になる。
 */
async function textRowPoint(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="terminal"]') as
      | (HTMLDivElement & { __terminal?: Terminal })
      | null
    const term = box?.__terminal
    const screen = box?.querySelector('.xterm-screen')
    if (!box || !term || !(screen instanceof HTMLElement)) {
      throw new Error('端末が見つかりません')
    }
    const buffer = term.buffer.active
    const cursor = buffer.cursorY + buffer.baseY - buffer.viewportY
    let row = -1
    for (let y = 0; y < term.rows; y += 1) {
      const text = buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? ''
      if (text.trim() !== '' && y !== cursor) {
        row = y
        break
      }
    }
    if (row < 0) {
      throw new Error('中身のある行が見つかりません')
    }
    const rect = screen.getBoundingClientRect()
    const cell = screen.clientHeight / term.rows
    const outer = box.getBoundingClientRect()
    return { x: outer.x + outer.width / 4, y: rect.top + (row + 0.5) * cell }
  })
}

/**
 * **いま入力欄になっている行**の座標。
 *
 * 擬似 claude は罫線の枠を描かないので、入力欄は**カーソルの居る行**になる
 * （キーボード設計§13-2 の落とし先）。`keyboard.spec.ts` と同じ引き方をする。
 */
async function inputRowPoint(page: Page) {
  return page.evaluate(() => {
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
}

/** いま端末の隠しテキストエリアに当たっている入力方式。 */
function inputMode(page: Page) {
  return page
    .getByTestId('terminal')
    .locator('.xterm-helper-textarea')
    .getAttribute('inputmode')
}

/** セッションを起こし、端末を開いて会話を1往復させる。 */
async function openTerminal(page: Page) {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
  await settle(page)
}

test('長押ししたら、文字の面が出る', async ({ page }) => {
  // **これが要件そのもの。** 長押しで何も起きないのが出発点だった
  await openTerminal(page)
  await expect(page.getByTestId('terminal-text-sheet')).toBeHidden()

  await press(page, await textRowPoint(page))

  await expect(page.getByTestId('terminal-text-sheet')).toBeVisible()
})

test('面の中身は、ブラウザが選べる本物の文字になっている', async ({ page }) => {
  // **端末の上ではこれが成立しない**（canvas に絵として描くので DOM に文字が無い）。
  // 面へ出して初めて、OS の選択ハンドルとコピーのメニューが出る先ができる
  await openTerminal(page)

  await press(page, await textRowPoint(page))

  const 本文 = page.getByTestId('terminal-text-body')
  await expect(本文).toContainText('[fake-claude] received: こんにちは')
  // **計算値で見る。** クラス名の一致では、綴り違いも打ち消しも捕まえられない
  const 選べるか = await 本文.evaluate((el) => getComputedStyle(el).userSelect)
  expect(選べるか).toBe('text')
})

test('狭い画面でも、面の操作が見えている範囲に入る', async ({ page }) => {
  // **前の版が落ちたのはここ。** 端末の右上に固定した的は、広い窓では見えていたが
  // 実機では届かなかった（読むには拡大が要り、拡大すると窓の外へ出る）。
  // 面を画面いっぱいに出す形に変えた担保がこれで、**隅へ戻す壊し方はここで落ちる**
  await openTerminal(page)

  await press(page, await textRowPoint(page))

  const 窓 = page.viewportSize()
  if (!窓) {
    throw new Error('窓の大きさが取れません')
  }
  for (const 名 of ['terminal-text-close', 'terminal-text-copy']) {
    const box = await page.getByTestId(名).boundingBox()
    if (!box) {
      throw new Error(`${名} の位置が取れません`)
    }
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(窓.width)
    expect(box.y + box.height).toBeLessThanOrEqual(窓.height)
  }
})

test('短くタップしただけでは、面は出ない', async ({ page }) => {
  // 否定側と対で置く。**常に出す実装でも、上の3本だけなら通る**
  await openTerminal(page)

  await press(page, await textRowPoint(page), 50)

  await expect(page.getByTestId('terminal-text-sheet')).toBeHidden()
})

test('閉じたら、面は消える', async ({ page }) => {
  // **閉じられない面は、読む以外に何もできない画面になる**
  await openTerminal(page)
  await press(page, await textRowPoint(page))
  await expect(page.getByTestId('terminal-text-sheet')).toBeVisible()

  await page.getByTestId('terminal-text-close').click()

  await expect(page.getByTestId('terminal-text-sheet')).toBeHidden()
})

test('入力欄の行は、長押ししても面が出ず、キーボードが開く', async ({ page }) => {
  // **前のイシューの約束1が、長押しの経路でも守られること。** 計時を先に始めて
  // 後から場所を見る形に壊すと、ここでだけ落ちる
  await openTerminal(page)

  await press(page, await inputRowPoint(page))

  await expect(page.getByTestId('terminal-text-sheet')).toBeHidden()
  await expect.poll(() => inputMode(page)).toBe('text')
})
