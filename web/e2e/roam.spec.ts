import { expect, test, type Page } from '@playwright/test'
import { archiveAll, fireHook, openDashboard, openSession, spawnSession } from './helpers'
import {
  ROAM_CURL_DELAY_MS,
  ROAM_CURL_MS,
  ROAM_FLIP_MS,
  ROAM_MAX,
} from '../src/stores/roam'
import { ROAM_BOX_H, ROAM_INK_PX } from '../src/lib/roam'

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
 * # 層の居場所は、振る舞いで見る
 *
 * **フェーズ9 で層が「場」（`data-roam-field`）の内側へ移った**（設計§9-7-5）。線が
 * 中身と一緒にスクロールしないと、枠をなぞる経路が枠から外れて意味が消えるためである。
 *
 * 以前ここには `getComputedStyle(層).position` を読むテストが置いてあった。**一覧を
 * 動かして座標を比べる形は、壊し方を当てても落ちなかったから**である——当時は祖先に
 * 位置指定が1つも無く、`absolute` でも基準が初期包含ブロックのままで見分けが付かなかった。
 *
 * **場が入ったことで、その穴が塞がった。** いまは「スクロールすると層も動く」「層の
 * 矩形＝場の矩形」がどちらも**壊せば落ちる**ので、位置の種別を直接読む必要が無くなった
 * ——`relative` が場から外れれば、層は初期包含ブロックへ落ちて矩形が食い違う。
 */

/** 跳ねの周期。1周ぶん待てば、**折り返しは**必ず1回は来る */
const 跳ねの周期 = 4_800

/**
 * 「線が1本出るまで」の上限（2026-08-28）。
 *
 * 跳ねの折り返しは合図のままだが、`stores/roam.ts` の `scheduleRoam` が
 * **籤で半分見送り（`ROAM_SKIP`）、残りも 1.2〜3.6秒 遅らせて**撃つ。
 *
 * **平均で待ってはいけない。** 「跳ね2回ぶん＋遅れ」は**平均**であって上限ではない
 * ——籤の外れが重なると足りず、**落ちるのではなく揺れる**（2026-08-28 に実際に
 * 2本落ちた）。跳ね12回ぶん見ても1度も撃たない確率は `0.5^12 ＝ 0.02%` である。
 *
 * **happy path では待たない**（`toBeVisible` は出た瞬間に返る）ので、長くしても遅くならない。
 */
const 発火の上限 = 跳ねの周期 * 12 + 3_600

/**
 * 「止まっていること」を確かめる待ち。**こちらは必ず待ち切る**ので、上限とは分ける。
 *
 * **門が壊れていたら、この間にほぼ確実に出る**——跳ね8回ぶん見送り続ける確率は
 * `0.5^8 ＝ 0.4%`。短くすると、**壊れているのに「たまたま出なかった」で緑になる**。
 */
const 止まりの確認 = 跳ねの周期 * 8 + 3_600

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
    timeout: 発火の上限,
  })

  // **控えめな量**（利用者の指定）。1回の跳ねで3本しか出ない
  const 本数 = await page.getByTestId('roam-line').count()
  expect(本数).toBeGreaterThanOrEqual(3)
  expect(本数).toBeLessThanOrEqual(ROAM_MAX)

  // **線の中には紙片が1枚だけ入る**（設計§9-7-2）。外は「道と向き」、内は
  // 「紙のたわみ」で、内側が無いと尺取り虫もひらひらも1つも動かない
  expect(await page.getByTestId('roam-paper').count()).toBe(本数)
})

/**
 * 紙片の `clip-path` を、**時計を止めて狙った時刻で**読む。
 *
 * **`currentTime` は遅れを含む**ので、4本ぜんぶへ同じ値を入れれば「生まれてから
 * t ミリ秒後の姿」になる。
 */
async function 形を読む(page: Page, t: number): Promise<string> {
  return page.evaluate((時刻) => {
    const 紙 = document.querySelector('[data-testid="roam-paper"]')
    if (!紙) return ''
    for (const a of 紙.getAnimations()) {
      a.pause()
      a.currentTime = 時刻
    }
    return getComputedStyle(紙).clipPath
  }, t)
}

/** `polygon()` から中心線を取り出し、箱の中心からいちばん離れた量（px）を返す */
function 曲がり(形: string, 箱: number): number {
  const 点 = [...形.matchAll(/(-?[\d.]+)%\s+(-?[\d.]+)%/g)].map((m) => Number(m[2]))
  if (点.length < 4 || 点.length % 2 !== 0) return 0
  let 最大 = 0
  for (let i = 0; i < 点.length / 2; i += 1) {
    const 中 = (点[i] + 点[点.length - 1 - i]) / 2
    最大 = Math.max(最大, (Math.abs(中 - 50) * 箱) / 100)
  }
  return 最大
}

test('形は時間で切り替わり、巻きの窓だけ曲がって、明けたらまたコマ送りへ戻る', async ({
  page,
}) => {
  /*
    **ここでしか確かめられないこと。**

    紙片の `clip-path` は**3枚のアニメーションが後勝ちで争っている**
    ——コマ送り（`roam-flip`・ずっと下に敷く）／巻きの曲げ（`roam-curl`・窓のあいだ
    だけ）／退場（`roam-exit`・最後だけ）。CSS は「効いているうち並びで後のもの」を
    採るので、`animation-fill-mode: none` なら窓が明けた瞬間に下が透ける。

    **単体テスト（`roam.test.ts`）はこれを1ミリも見ていない。** jsdom は CSS を
    適用しないので、字面に「そう書いてある」ことしか言えない。**どちらが勝つかは
    実物の時計でしか分からない**——2026-08-28 に、まさに「規則は書いてあるが、
    どちらが勝つかを見ていなかった」で後戻りを1度踏んでいる。

    **時刻を進めるのではなく、時計を止めて狙った時刻へ置く。** 待つ形にすると
    籤と遅れで揺れるうえ、90秒の寿命ぶん待つことになる。
  */
  test.slow()
  await openDashboard(page)
  await 待つカードを作る(page)
  await expect(page.getByTestId('roam-line').first()).toBeVisible({
    timeout: 発火の上限,
  })

  // ① コマ送りが動いている——同じ1巡の中で、コマが違えば形が違う
  const コマ0 = await 形を読む(page, 0)
  const コマ2 = await 形を読む(page, ROAM_FLIP_MS * 0.5 + 10)
  expect(コマ0).not.toBe('')
  expect(コマ2, 'コマ送りが効いていない（形が時間で変わらない）').not.toBe(コマ0)

  // ② 1巡すると同じコマへ戻る＝`infinite` が生きている
  //    **`animation-iteration-count` が繰り返しで潰れると、ここで止まって落ちる**
  expect(await 形を読む(page, ROAM_FLIP_MS), '1巡しても戻らない').toBe(コマ0)

  // ③ 飛散のあいだは曲がっていない——**幾何的に真っ直ぐな区間なので曲げてはいけない**
  const 飛散の曲がり = 曲がり(await 形を読む(page, ROAM_CURL_DELAY_MS - 50), ROAM_BOX_H)
  expect(飛散の曲がり, '真っ直ぐな飛散の区間で紐が曲がっている').toBeLessThan(ROAM_INK_PX)

  // ④ 巻きの窓の真ん中では、**線自身が曲がっている**（要件2-1）
  const 巻きの曲がり = 曲がり(
    await 形を読む(page, ROAM_CURL_DELAY_MS + ROAM_CURL_MS / 2),
    ROAM_BOX_H,
  )
  expect(巻きの曲がり, '巻きの窓で紐が曲がっていない').toBeGreaterThan(ROAM_INK_PX * 2)

  // ⑤ 窓が明けたら、下に敷いたコマ送りが**また透ける**
  //    **`fill-mode` を `both` にすると曲げが居座り、ここで落ちる**
  const 明けて = ROAM_CURL_DELAY_MS + ROAM_CURL_MS + 100
  expect(曲がり(await 形を読む(page, 明けて), ROAM_BOX_H)).toBeLessThan(ROAM_INK_PX)
  expect(await 形を読む(page, 明けて + ROAM_FLIP_MS), '明けたあとコマ送りが回っていない').toBe(
    await 形を読む(page, 明けて),
  )
  expect(await 形を読む(page, 明けて + ROAM_FLIP_MS * 0.5)).not.toBe(
    await 形を読む(page, 明けて),
  )
})

test('層は中身と一緒にスクロールし、場からはみ出さない', async ({ page }) => {
  test.slow()
  await openDashboard(page)
  await 待つカードを作る(page)

  const 層 = page.getByTestId('roam-layer')
  const 場 = page.locator('[data-roam-field]')

  /*
    **層の矩形＝場の矩形。**

    層は `absolute; inset: 0` なので、**基準（`position: relative` の場）が外れると
    初期包含ブロックへ静かに落ちる**——画面と同じ大きさになり、しかも見た目には
    ほとんど気づけない。矩形どうしを比べれば、そこが落ちる。

    **場は「中身の全高」を持つ**ので、可視領域より高いのが正しい（スクロールする
    入れ物の直下へ層を置くと、ここが可視1画面ぶんになって食い違う）。
  */
  const 層の箱 = await 層.boundingBox()
  const 場の箱 = await 場.boundingBox()
  expect(層の箱?.x).toBeCloseTo(場の箱?.x ?? -1, 0)
  expect(層の箱?.y).toBeCloseTo(場の箱?.y ?? -1, 0)
  expect(層の箱?.width).toBeCloseTo(場の箱?.width ?? -1, 0)
  expect(層の箱?.height).toBeCloseTo(場の箱?.height ?? -1, 0)

  /*
    **スクロールすると、層も一緒に動く。**

    `fixed` へ戻すと画面に貼り付いて動かなくなるので、ここが落ちる。**フェーズ9 より
    前はこの形が書けなかった**（祖先に位置指定が無く、`fixed` と `absolute` が同じに
    振る舞っていた）。
  */
  const 器 = page.locator('[data-roam-field]').locator('..')

  /*
    **窓を狭めて、必ずスクロールできる形にする。**

    最初は「動かせなければ飛ばす」と書いたが、**一覧が1画面に収まって毎回
    skip された**——`fixed` へ戻す壊し方を当てても落ちない。**飛ばしたテストは
    何も証明しない**ので、条件のほうを作りにいく。
  */
  const 元の窓 = page.viewportSize()
  await page.setViewportSize({ width: 900, height: 260 })
  try {
    // **動かせる量は決め打てない**（カードの高さも一覧の中身も変わる）。実測して、
    // その量ぶんだけ動かす。最初は 40px を要求したが**余地が 29px しか無くて落ちた**
    const 余地 = await expect
      .poll(async () => 器.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(8)
      .then(() => 器.evaluate((el) => el.scrollHeight - el.clientHeight))
    const 動かす = Math.min(40, 余地)

    const 前 = (await 層.boundingBox())?.y ?? 0
    await 器.evaluate((el, y) => {
      el.scrollTop = y
    }, 動かす)
    const 後 = (await 層.boundingBox())?.y ?? 0
    // **`fixed` へ戻すとここが 0 になる**（画面に貼り付いて動かない）
    expect(前 - 後).toBeCloseTo(動かす, 0)
    await 器.evaluate((el) => {
      el.scrollTop = 0
    })
  } finally {
    // **戻してから終える。** 置いていくと後続が狭い窓で走る
    if (元の窓 !== null) await page.setViewportSize(元の窓)
  }
})

test('飛んでいる線が、スクロールできる範囲を押し広げない', async ({ page }) => {
  test.slow()
  await openDashboard(page)

  const 器 = page.locator('[data-roam-field]').locator('..')
  const 前 = await 器.evaluate((el) => ({
    w: el.scrollWidth,
    h: el.scrollHeight,
  }))

  await 待つカードを作る(page)
  await expect(page.getByTestId('roam-line').first()).toBeVisible({
    timeout: 発火の上限,
  })
  // 何本か溜まるまで待つ。1本だけだと、たまたま内側へ飛んだだけかもしれない。
  // **固定待ちにしない**——籤で撃つので、決め打ちの秒数だと本数が静かにばらつく
  await expect
    .poll(async () => page.getByTestId('roam-line').count(), { timeout: 発火の上限 })
    .toBeGreaterThanOrEqual(4)

  /*
    **`fixed` をやめた副作用を見る。**

    スクロール可能オーバーフロー域には「包含ブロックである子孫の**変形後の
    ボーダーボックス**」が数えられる（CSS Overflow 3 §3.5）。経路が場の外へ出ると、
    **一覧の下に無用の余白が生まれ、横スクロールバーが生える**。

    防いでいるのは経路の側（`lib/roam.ts` の `MARGIN` が回転と拡大を織り込んだ
    半対角ぶん内側へ留める）と、横は `overflow-x-hidden` の二重である。

    **カードが1枚増えたぶんは伸びる**ので、高さは「線のぶんだけ伸びていない」を
    見る形にする——カード1枚（100px ほど）より大きく伸びていたら、線が出ている
  */
  const 後 = await 器.evaluate((el) => ({
    w: el.scrollWidth,
    h: el.scrollHeight,
  }))
  expect(後.w).toBeLessThanOrEqual(前.w)
  expect(後.h - 前.h).toBeLessThan(400)
})

test('「控えめ」では、カードは跳ね続けるが線は飛ばない', async ({ page }) => {
  test.slow()
  await openDashboard(page)
  await 待つカードを作る(page)
  await expect(page.getByTestId('roam-line').first()).toBeVisible({
    timeout: 発火の上限,
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
    **内側も止まっていること。**

    `animation` は継承しないので、外側（`.roam-line`）だけを止めると
    **紙片（`.roam-paper`）は回り続ける**。外が透明なので目には見えないが、規範が
    求めているのは「動きが止まること」であって「見えないこと」ではない。

    しかも**見えないぶん、外側だけを見るテストは通ってしまう**——ここを足さないと
    打ち消しのセレクタから `.roam-paper` を外す壊し方が1本も落とせない。
  */
  expect(
    await page
      .getByTestId('roam-paper')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none')

  /*
    **本数は「0本」ではなく「増えない」で見る。**

    切り替える前に飛ばした線は**寿命（15秒）まで在庫に残る**のが正しい振る舞いで、
    止めているのは見た目のほうである。最初は0本を期待して書いたが、それは
    `page.goto` で読み込み直していたから通っていただけだった（在庫ごと消えていた）。

    門（JS）が守っているのは**新しく増えないこと**なので、そちらを数える。
  */
  await page.waitForTimeout(止まりの確認)
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
    timeout: 発火の上限,
  })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    const 飛んでいるか = await page
      .getByTestId('roam-line')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName)
    expect(飛んでいるか).toBe('none')

    // **内側も止まる**（上と同じ理由。`animation` は継承しない）
    expect(
      await page
        .getByTestId('roam-paper')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none')

    // 新しい線も出ない（跳ねが止まるので折り返しが鳴らない）
    const 前 = await page.getByTestId('roam-line').count()
    await page.waitForTimeout(止まりの確認)
    expect(await page.getByTestId('roam-line').count()).toBeLessThanOrEqual(前)
  } finally {
    // **戻してから終える。** 置いていくと後続が巻き添えになる
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
})
