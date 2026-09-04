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
 * スマホで端末をタップしたとき、ソフトキーボードを出してよいか
 * （ローカルイシュー「スマホでターミナルビュー内に触れるとキーボードが出てくる」
 * テスト計画フェーズ4）。
 *
 * # 見られるのは属性まで
 *
 * **「キーボードが実際に出るか」は確かめられない。** 出すかどうかを決めているのは
 * ブラウザで、ここで走る chromium にソフトキーボードは無い。見るのは
 * `.xterm-helper-textarea` の `inputmode` が正しく当たっているかまでで、
 * その先は実機で見る。
 *
 * # なぜファイルを分けるのか
 *
 * `hasTouch` は `test.use` の単位で効き、**`describe` の中でも効く**（`terminal.spec.ts`
 * が2箇所でそうしている）。**だから分けなくても書けた**——分けたのは、この工事の
 * 担保を1箇所に集めて読めるようにするためで、道具の制約ではない。
 *
 * ただし `terminal.spec.ts` には**PC 側（タッチ無し）の担保**が要り、そちらは
 * ファイル既定の土台でなければ書けない。**逆側は必ずあちらに残る。**
 *
 * # 土台は擬似 claude の `/model` の確認画面
 *
 * `dpad.spec.ts` と同じものを使う。**擬似 claude は入力欄の枠（罫線）を描かない**ので、
 * 通常の画面は「選択待ちに見えない」経路で打てる側に倒れる——実物の枠を見分ける側
 * （罫線に挟まれた字下げ0の `❯`）は、実物のゴールデン15枚を相手に `keys.test.ts` が
 * 見ている。
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
    // **握らせない。** `touchMove` を挟むと「なぞり」と判定され、焦点が渡らない
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

/** セッションを起こし、端末を開いて会話を1往復させる。 */
async function openTerminal(page: Page) {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  // 会話が進んでいないと `/model` の確認画面は出ない（本物と同じ）
  await typeLine(page, 'こんにちは')
  await expectTerminalToContain(page, '[fake-claude] received: こんにちは')
}

test('選択待ちの画面をタップしても、キーボードを出さない', async ({ page }) => {
  // **これが要件そのもの。** 選びたいものも押したいものも、キーボードで隠れてはいけない
  await openTerminal(page)
  await typeLine(page, '/model haiku')
  await expectTerminalToContain(page, 'Esc to cancel')

  await tapTerminal(page)

  await expect.poll(() => inputMode(page)).toBe('none')
})

test('打てる画面をタップしたら、キーボードを塞がない', async ({ page }) => {
  // 否定側と対で置く。**常に `none` を当てる実装でも、上の1本だけなら通る**
  await openTerminal(page)

  await tapTerminal(page)

  await expect.poll(() => inputMode(page)).toBe('text')
})
