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
 * 長押しで選んで、コピーする
 * （ローカルイシュー「スマホでターミナルの文字をコピーできない」テスト計画フェーズ3）。
 *
 * # ここでしか見られないもの
 *
 * **xterm の選択が実際に付くか。** jsdom には canvas も選択の描画も無いので、
 * 単体は `selectLines` を**呼んだこと**までしか見ていない。実物のブラウザなら
 * `getSelection()` が中身を返すところまで確かめられる。
 *
 * **時間の経過も実物である。** 単体は偽のタイマーを進めているので、「押しっぱなしに
 * している間にブラウザが別の解釈をしないか」は分からない。
 *
 * # 見られないもの
 *
 * **写せたかどうか。** ここは `localhost` なので安全なオリジンにあたり、実機
 * （素の HTTP）とは通る枝が違う（`lib/clipboard.ts`）。**実機と同じ枝を踏めない**
 * ので、押した結果は実機で見る。
 *
 * # なぜファイルを分けるのか
 *
 * `keyboard.spec.ts` は**前のイシューの約束**（枠のタップで開く／枠の外で抜ける／
 * 引き戻されない）を持っている。**あちらが1本も落ちないことが、この工事の合格条件**
 * なので、混ぜずに残す。
 */

test.use({ hasTouch: true })

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
 * なので、**真ん中はたいてい空行**である——空行を選んでも `getSelection()` は空を
 * 返すので、「選べていない」と見分けが付かない（実測で1本落とした）。
 *
 * **どの行に中身があるかは端末に聞く。** 入力欄の行は避ける——あそこは選ばない側の
 * 担保が持っている。
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
 * （キーボード設計§13-2 の落とし先）。`keyboard.spec.ts` と同じ引き方をする——
 * **判定を写して組み立てると、実装と同じ思い込みを共有したまま緑になる。**
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

/** いま端末が選んでいる文字。 */
function selection(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="terminal"]') as
      | (HTMLDivElement & { __terminal?: Terminal })
      | null
    return box?.__terminal?.getSelection() ?? ''
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

test('ログのあたりを長押しすると、その行が選ばれる', async ({ page }) => {
  // **これが要件そのもの。** 長押しで文字を選べないのが出発点だった
  await openTerminal(page)

  await press(page, await textRowPoint(page))

  await expect.poll(() => selection(page)).not.toBe('')
})

test('短くタップしただけでは選ばれない', async ({ page }) => {
  // 否定側と対で置く。**常に選ぶ実装でも、上の1本だけなら通る**
  await openTerminal(page)

  await press(page, await textRowPoint(page), 50)

  expect(await selection(page)).toBe('')
})

test('長押ししたら、コピーの的が出る', async ({ page }) => {
  await openTerminal(page)
  await expect(page.getByTestId('terminal-copy')).toBeHidden()

  await press(page, await textRowPoint(page))

  await expect(page.getByTestId('terminal-copy')).toBeVisible()
})

test('選んだあとにタップすると、選択も的も消える', async ({ page }) => {
  // 残り続けると、**次に押したときに古い範囲が混ざる**
  await openTerminal(page)
  await press(page, await textRowPoint(page))
  await expect(page.getByTestId('terminal-copy')).toBeVisible()

  await press(page, await textRowPoint(page), 50)

  await expect.poll(() => selection(page)).toBe('')
  await expect(page.getByTestId('terminal-copy')).toBeHidden()
})

test('入力欄の行は、長押ししても選ばれず、キーボードが開く', async ({ page }) => {
  // **前のイシューの約束1が、長押しの経路でも守られること。** 計時を先に始めて
  // 後から場所を見る形に壊すと、ここでだけ落ちる
  await openTerminal(page)

  await press(page, await inputRowPoint(page))

  expect(await selection(page)).toBe('')
  await expect.poll(() => inputMode(page)).toBe('text')
})
