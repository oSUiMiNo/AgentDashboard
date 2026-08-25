import { expect, test, type Page } from '@playwright/test'
import { archiveAll, fireHook, openDashboard, openSession, spawnSession } from './helpers'

/**
 * 画面を回遊する効果線（カード設計§9-7）。
 *
 * # ここでしか確かめられないこと
 *
 * 単体（`web/src/roam.test.ts`）が言えるのは「そう書いてある」ことまでで、
 * jsdom は CSS を適用しないので**打ち消しが実際に効くか**は1つも見ていない。
 * さらに**跳ねの折り返しで本当に鳴るか**は、CSS アニメーションが実際に回る場所でしか
 * 確かめられない——単体では素のイベントを手で投げているので、**周期が繋がっている
 * ことの証拠にはならない**。
 *
 * # `fixed` であることは、解決後の値で見る
 *
 * 層がスクロールする入れ物の内側へ落ちると、線は**カードの切る枠にも一覧の入れ物にも
 * 切られる**。一覧を動かして座標を比べる形も試したが、**壊し方を当てても落ちなかった**
 * ——祖先に位置指定が1つも無いので `absolute` でも基準が変わらず、見分けが付かない。
 * 詳しくは当のテストの中に書いてある。
 */

/** 跳ねの周期。1周ぶん待てば、折り返しが必ず1回は来る */
const 跳ねの周期 = 4_800

test.afterEach(async ({ page }) => {
  // **設定を先に戻す。** 静けさはサーバ側に残るので、戻し忘れると後続の無関係な
  // テストが静止のまま走る（`tile.spec.ts` と同じ作法）
  await page.request.put('/api/settings', { data: { motion_quiet: 'lively' } })
  await archiveAll(page)
})

/** 権限確認待ちのカードを1枚作って、一覧へ戻る */
async function 待つカードを作る(page: Page): Promise<void> {
  const tile = await spawnSession(page)
  await openSession(page, tile)
  await fireHook(page, 'Notification', '{"notification_type":"permission_prompt"}')
  await page.goto('/')
  await expect(page.getByTestId('tile-shell').first()).toHaveAttribute(
    'data-motion',
    'shake',
  )
}

/**
 * 静けさの段を変える。
 *
 * **アプリの中のリンクで移る（`page.goto` を使わない）。** `goto` は読み込み直しに
 * なるので、**飛んでいる線の在庫が消える**——それだと切り替えた直後の見え方を
 * 1つも確かめられない（CSS の打ち消しを丸ごと消しても通る空振りになる）。
 * 利用者が実際に押すのもこのリンクである。
 */
async function 静けさ(page: Page, 段: string): Promise<void> {
  await page.getByTestId('settings-link').click()
  await page.getByTestId('motion-quiet-select').selectOption(段)
  await expect(page.getByTestId('motion-quiet-select')).toHaveValue(段)
  await page.goBack()
  await expect(page.getByTestId('tile-grid')).toBeVisible()
}

test('跳ねるたびに線が飛び、しばらく画面に居る', async ({ page }) => {
  test.slow()
  await openDashboard(page)
  await 待つカードを作る(page)

  // **周期の末尾で鳴る**ので、1周ぶん待つ。手で投げるのではなく、CSS の時計が
  // 一巡したことを合図にしている＝周期が繋がっていることの証拠になる
  await expect(page.getByTestId('roam-line').first()).toBeVisible({
    timeout: 跳ねの周期 * 2,
  })

  // **控えめな量**（利用者の指定）。1回の跳ねで2〜3本しか出ない
  const 本数 = await page.getByTestId('roam-line').count()
  expect(本数).toBeGreaterThanOrEqual(2)
  expect(本数).toBeLessThanOrEqual(10)
})

test('層は画面に貼りついていて、画面いっぱいを覆う', async ({ page }) => {
  test.slow()
  await openDashboard(page)
  await 待つカードを作る(page)

  /*
    **一覧を動かして位置を比べる形にはできなかった。**

    最初はそう書いたが、`absolute` へ落とす壊し方を当てても**4本とも通ってしまった**。
    層の祖先に位置指定が1つも無いので、`absolute` でも基準が初期の包含ブロックになり、
    しかもスクロールしているのは層の**外側の入れ物**なので、どちらでも動かない。
    **見分けが付いていなかった＝空振りのテスト**だった。

    解決後の値を読む形にする。`fixed` でなくなると、カードの切る枠（`overflow:
    hidden`）にも一覧のスクロールする入れ物にも切られる道が開く——**そこが本題**なので、
    位置の種別そのものを見るのが素直である。
  */
  const 層 = page.getByTestId('roam-layer')
  expect(
    await 層.evaluate((el) => getComputedStyle(el).position),
  ).toBe('fixed')

  // 画面いっぱいであること。狭めると線が縁で消える
  const 箱 = await 層.boundingBox()
  const 窓 = page.viewportSize()
  expect(箱?.width).toBeCloseTo(窓?.width ?? 0, 0)
  expect(箱?.height).toBeCloseTo(窓?.height ?? 0, 0)
})

test('「控えめ」では、カードは跳ね続けるが線は飛ばない', async ({ page }) => {
  test.slow()
  await openDashboard(page)
  await 待つカードを作る(page)
  await expect(page.getByTestId('roam-line').first()).toBeVisible({
    timeout: 跳ねの周期 * 2,
  })

  await 静けさ(page, 'calm')
  await expect(page.getByTestId('roam-layer')).toHaveAttribute('data-quiet', 'calm')

  /*
    **止める道が2枚あるので、2つとも見る。**

    画面を移ると在庫は残ったままなので、切り替えた直後は**前に飛ばした線がまだ居る**。
    その線が止まっていること＝**CSS の打ち消し**が効いている証拠になる。
    （これを見ないと、CSS 側を丸ごと消しても通ってしまう＝空振りになる。実際に
    壊し方を当てて確かめた。）
  */
  const 残り = page.getByTestId('roam-line')
  const 切り替えた時点 = await 残り.count()
  expect(切り替えた時点).toBeGreaterThan(0)
  expect(await 残り.first().evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'none',
  )

  /*
    **本数は「0本」ではなく「増えない」で見る。**

    切り替える前に飛ばした線は**寿命（15秒）まで在庫に残る**のが正しい振る舞いで、
    止めているのは見た目のほうである。最初は0本を期待して書いたが、それは
    `page.goto` で読み込み直していたから通っていただけだった（在庫ごと消えていた）。

    門（JS）が守っているのは**新しく増えないこと**なので、そちらを数える。
  */
  await page.waitForTimeout(跳ねの周期 * 1.5)
  expect(await 残り.count()).toBeLessThanOrEqual(切り替えた時点)

  // **カードのほうは跳ね続ける。** ここが `tile.css` の「控えめ」との違い
  await expect(page.getByTestId('tile-shell').first()).toHaveAttribute(
    'data-motion',
    'shake',
  )
  const 跳ね = await page.evaluate(() => {
    const frame = document.querySelector('.tile-frame')
    return frame === null ? null : getComputedStyle(frame).animationName
  })
  expect(跳ね).toBe('tile-shake')
})

test('OS が「動きを減らす」と言えば、飛んでいる線もその場で止まる', async ({
  page,
}) => {
  test.slow()
  await openDashboard(page)
  await 待つカードを作る(page)

  /*
    **先に飛ばしてから設定を入れる。**

    最初は「設定を入れてから待って、0本であること」を見ていたが、`roam.css` の
    打ち消しを丸ごと消す壊し方を当てても**4本とも通ってしまった**。跳ねが止まると
    折り返しが鳴らないので、**打ち消しが無くても線は出ない**——つまりあの形では
    CSS の側を1行も確かめていなかった。

    飛んでいる最中に切り替えれば、**止めているのが CSS だと分かる**。
  */
  await expect(page.getByTestId('roam-line').first()).toBeVisible({
    timeout: 跳ねの周期 * 2,
  })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    const 飛んでいるか = await page
      .getByTestId('roam-line')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName)
    expect(飛んでいるか).toBe('none')

    // 新しい線も出ない（跳ねが止まるので折り返しが鳴らない）
    const 前 = await page.getByTestId('roam-line').count()
    await page.waitForTimeout(跳ねの周期 * 1.5)
    expect(await page.getByTestId('roam-line').count()).toBeLessThanOrEqual(前)
  } finally {
    // **戻してから終える。** 置いていくと後続が巻き添えになる
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
})
