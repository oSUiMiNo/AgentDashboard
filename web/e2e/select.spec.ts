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

/** `.xterm-rows`（DOM レンダラが文字を並べる入れ物）の中身と指定を読む。 */
async function rowsInfo(page: Page) {
  return page.evaluate(() => {
    const rows = document.querySelector('[data-testid="terminal"] .xterm-rows')
    if (!(rows instanceof HTMLElement)) {
      return { ある: false, 文字: '', userSelect: '' }
    }
    return {
      ある: true,
      文字: rows.textContent ?? '',
      userSelect: getComputedStyle(rows).userSelect,
    }
  })
}

test('触る端末では、DOM レンダラで描く', async ({ page }) => {
  // **これが土台。** WebGL は文字を canvas へ絵として描くので、DOM に1文字も残らない
  await openTerminal(page)

  await expect(page.getByTestId('terminal-status')).toHaveAttribute(
    'data-renderer',
    'dom',
  )
})

test('端末の文字が、本物の DOM に並んでいる', async ({ page }) => {
  // **ここは実物のブラウザでしか見られない。** jsdom は差し込んだ値を返すだけで、
  // 「レンダラが本当に要素を作ったか」は答えない
  await openTerminal(page)

  const rows = await rowsInfo(page)

  expect(rows.ある).toBe(true)
  expect(rows.文字).toContain('[fake-claude] received: こんにちは')
})

test('その文字は、ブラウザが選べる指定になっている', async ({ page }) => {
  // xterm の既定は `user-select: none`。**要素があっても、解かなければ選べない**
  await openTerminal(page)

  const rows = await rowsInfo(page)

  expect(rows.userSelect).toBe('text')
})

test('実際に範囲を選ぶと、その文字が取り出せる', async ({ page }) => {
  // **指定を読むだけでは足りない。** 上の2本は「要素がある」「指定が付いている」しか
  // 言っておらず、**選ぶと空が返る**形（親で解いて子で塞ぐ等）を捕まえられない
  await openTerminal(page)

  const 選べた = await page.evaluate(() => {
    const rows = document.querySelector('[data-testid="terminal"] .xterm-rows')
    if (!rows) {
      return ''
    }
    const 範囲 = document.createRange()
    範囲.selectNodeContents(rows)
    const 選択 = document.getSelection()
    選択?.removeAllRanges()
    選択?.addRange(範囲)
    return 選択?.toString() ?? ''
  })

  expect(選べた).toContain('[fake-claude] received: こんにちは')
})

/** 端末の行をまるごと選ぶ。 */
async function 選ばせる(page: Page) {
  await page.evaluate(() => {
    const rows = document.querySelector('[data-testid="terminal"] .xterm-rows')
    if (!rows) {
      throw new Error('行が見つかりません')
    }
    const 範囲 = document.createRange()
    範囲.selectNodeContents(rows)
    const 選択 = document.getSelection()
    選択?.removeAllRanges()
    選択?.addRange(範囲)
  })
}

/** いま選ばれている文字。 */
function 選ばれている(page: Page) {
  return page.evaluate(() => document.getSelection()?.toString() ?? '')
}

test('触っている間に選ばれたら、その選択は残る', async ({ page }) => {
  // **長押しで選んだ指は、離すときにタップとしても届く。** そのまま焦点を外しに
  // いくと、選んだそばから消える——利用者から見れば「選べない」と同じ
  await openTerminal(page)
  const 点 = await textRowPoint(page)

  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [点] })
    // **指を置いたあとに選ばれる**のが長押しの形
    await 選ばせる(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }

  expect(await 選ばれている(page)).toContain('[fake-claude] received: こんにちは')
})

test('選ばれたまま触ったら、選択はしまわれる', async ({ page }) => {
  // **これが無いと端末が固まる。** 選択をしまうのは普通ブラウザの仕事だが、その
  // きっかけ（タップ）をこちらが毎回止めているので、**誰もしまえなくなる**——
  // 遷移を1本足したときに、既存の遷移と繋がってできた道
  await openTerminal(page)
  await 選ばせる(page)
  expect(await 選ばれている(page)).not.toBe('')

  await press(page, await textRowPoint(page), 50)

  expect(await 選ばれている(page)).toBe('')
})

test('何も選んでいなければ、これまでどおり焦点は外れる', async ({ page }) => {
  // **常に「選択中」と答える実装でも、上の1本は通る。** 前のイシューで直した
  // 「枠の外をタップしたら抜ける」が丸ごと死ぬので、否定側を対で置く
  await openTerminal(page)
  await page.getByTestId('composer-input').click()
  await page.evaluate(() => document.getSelection()?.removeAllRanges())

  await press(page, await textRowPoint(page), 50)

  await expect.poll(() => inputMode(page)).toBe('none')
})

test('長押ししても、別の画面へは移らない', async ({ page }) => {
  // **2度作って2度捨てた道の見張り。** 1度目は帯を塗り、2度目は面へ飛ばした。
  // どちらも実機で却下されている——**その場で選べること**が要件である
  await openTerminal(page)

  await press(page, await textRowPoint(page))

  await expect(page.getByTestId('terminal')).toBeVisible()
  expect(await page.getByTestId('terminal-text-sheet').count()).toBe(0)
})

test('入力欄の行をタップすれば、これまでどおりキーボードが開く', async ({ page }) => {
  // 選べるようにした副作用で打てなくなっていないこと。**打つ道のほうが要る**
  await openTerminal(page)
  await page.getByTestId('composer-input').click()

  await press(page, await inputRowPoint(page), 50)

  await expect.poll(() => inputMode(page)).toBe('text')
})
