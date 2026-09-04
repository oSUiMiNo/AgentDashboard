import { expect, test, type Page } from '@playwright/test'

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
 * テスト計画フェーズ4）。
 *
 * # 端末をタップしても、何も起きない
 *
 * **焦点も渡さない**（設計§12-2）。渡すとカーソルが出て、「打つ場所が光っているのに
 * 打てない」という見え方になる。打つ道は**「キーボード」ボタン1つ**に絞ってある。
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

/** 端末の真ん中を、なぞらずにタップする。 */
async function tapTerminal(page: Page) {
  const box = await page.getByTestId('terminal').boundingBox()
  if (!box) {
    throw new Error('端末の位置が取れません')
  }
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
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

test('端末をタップしても、キーボードは塞がれたまま', async ({ page }) => {
  // **これが要件そのもの。** ログを読んでいるだけのときに出てはいけない
  await openTerminal(page)

  await tapTerminal(page)

  await expect.poll(() => inputMode(page)).toBe('none')
})

test('端末をタップしても、焦点は渡らない', async ({ page }) => {
  // 焦点を渡すとカーソルが出る。**「打つ場所が光っているのに打てない」**は、
  // 壊れていると読まれる（利用者の観測・2026-09-04）
  await openTerminal(page)
  // まず入力欄から焦点を外しておく（打ち終わった直後は端末に焦点がある）
  await page.getByTestId('composer-input').click()

  await tapTerminal(page)

  expect(await terminalFocused(page)).toBe(false)
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
