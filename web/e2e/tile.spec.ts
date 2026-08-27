import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  archiveAll,
  expectTerminalToContain,
  fireHook,
  openDashboard,
  openSession,
  showTerminal,
  spawnSession,
  writeTranscript,
} from './helpers'

/**
 * 一覧のカードの見た目と動き（カード設計§7〜§11、テスト計画フェーズ5）。
 *
 * # ここでしか確かめられないこと
 *
 * フェーズ4 のテストは jsdom で走るので、**CSS を1行も適用していない**。
 * `web/src/tile.test.ts` が言えるのは「そう書いてある」ことまでで、
 * **カスケードが実際にどう解決されるか**は誰も見ていなかった（カード設計§16 の16）。
 *
 * したがってこのファイルは、属性（`data-motion` / `data-quiet`）だけでなく
 * **本物のブラウザが解決した `animation-name`** を読む。属性を見るだけなら jsdom で
 * 足りるので、それでは E2E を足した意味が無い。
 *
 * とくに設計§9-5-4 が「最重要」と書いた穴——**鎮まりの `:hover` が詳細度を上げると、
 * 静けさと OS 設定の打ち消しに勝ってしまう**——は、実際のカスケードでしか裏が取れない。
 *
 * # 停滞（`spin-slow`）はここでは作らない
 *
 * 停滞の閾値は**サーバ全体の設定**（`stalled_threshold_secs`）で、E2E は
 * **1台のサーバを全テストで共有している**。縮めると無関係なテストのカードまで停滞に
 * なるので、停滞の見え方は web 単体（フェーズ4）で押さえてある。
 */

/** `fixtures/v2.1.220/basic-tools/session.jsonl` の8行目に書かれている題。 */
const TITLE = 'TODOを完了に変更し作業内容をまとめる'

test.afterEach(async ({ page }) => {
  // **設定を先に戻す。** 静けさはサーバ側（アカウントの設定）に残るので、
  // 戻し忘れると**後続の無関係なテストが静止のまま走る**。画面から戻すより
  // REST のほうが堅い（後片付けの途中で失敗しても、ここだけは必ず通る）
  await page.request.put('/api/settings', { data: { motion_quiet: 'lively' } })
  await archiveAll(page)
})

/** 小窓から `card_id` を読む。**並び順で拾わない**——状態が変わると並びが動く。 */
async function cardIdOf(tile: Locator): Promise<string> {
  const cardId = await tile.getAttribute('data-card-id')
  if (!cardId) {
    throw new Error('小窓から card_id を読めません')
  }
  return cardId
}

/**
 * 器（`tile-shell`）。
 *
 * **動きの印（`data-motion` / `data-quiet`）はここにしか無い。** 小窓（`session-tile`）を
 * 掴んだままだと取れない。
 */
function shellOf(page: Page, cardId: string): Locator {
  return page.locator(`[data-testid="tile-shell"][data-card-id="${cardId}"]`)
}

/**
 * 小窓（`tile-body`）。
 *
 * **状態の印（`data-status`）と、行の中身はこちらにしか無い。** `data-card-id` は器と
 * 小窓の**両方**が名乗るので、`[data-card-id]` 単独で書くと2件当たる。
 */
function tileOf(page: Page, cardId: string): Locator {
  return page.locator(`[data-testid="session-tile"][data-card-id="${cardId}"]`)
}

/** ブラウザが解決した動きの値。**属性ではなく、実際に効いているもの**を読む。 */
interface Resolved {
  /** 揺れ。`tile-shake` / `tile-shake-calm` / `none` */
  frame: string
  /** 呼吸。`tile-breathe` / `none` */
  ring: string
  /** 回転。**弧は疑似要素側にある**ので `::after` を読まないと1つも確かめられない */
  arc: string
  /** 弧が出ているか。止めるときは弧だけを消すので、濃さも一緒に見る（§9-1-1） */
  arcOpacity: string
}

async function motionOf(page: Page, cardId: string): Promise<Resolved> {
  return page.evaluate((id) => {
    const shell = document.querySelector(
      `[data-testid="tile-shell"][data-card-id="${id}"]`,
    )
    if (shell === null) {
      throw new Error(`器が見つかりません：${id}`)
    }
    const frame = shell.querySelector('.tile-frame')
    const ring = shell.querySelector('.tile-ring')
    if (frame === null || ring === null) {
      throw new Error('切る枠か輪が見つかりません')
    }
    return {
      frame: getComputedStyle(frame).animationName,
      ring: getComputedStyle(ring).animationName,
      arc: getComputedStyle(ring, '::after').animationName,
      arcOpacity: getComputedStyle(ring, '::after').opacity,
    }
  }, cardId)
}

/**
 * 揺れの経過時刻（ミリ秒）。動きが無ければ -1。
 *
 * 名前のほうは [`motionOf`] が返すので、ここは時計だけを読む。
 */
async function shakeClockOf(page: Page, cardId: string): Promise<number> {
  return page.evaluate((id) => {
    const frame = document.querySelector(
      `[data-testid="tile-shell"][data-card-id="${id}"] .tile-frame`,
    )
    if (frame === null) {
      throw new Error(`切る枠が見つかりません：${id}`)
    }
    const animation = frame.getAnimations()[0]
    return animation === undefined ? -1 : Number(animation.currentTime ?? 0)
  }, cardId)
}

/** カードから十分に離れた場所。**器は片側 6px の帯を持つ**（§7-3）ので、端に寄せない。 */
async function moveAway(page: Page) {
  await page.mouse.move(2, 2)
}

/** カードの中央へマウスを乗せる。 */
async function moveOnto(page: Page, target: Locator) {
  const box = await target.boundingBox()
  if (box === null) {
    throw new Error('カードの位置を測れません')
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

/**
 * もう1枚のページで専用画面を開き、端末を出す。
 *
 * **一覧を開いたページを残したまま、こちらでフックを撃つ**ために要る。`page.goto('/')`
 * で戻る形だとカードが作り直されるので、「変わった瞬間」に出るもの（直前の応答）を
 * 一度も観測できない。
 */
async function openSessionAt(other: Page, cardId: string) {
  await other.goto(`/s/${cardId}`)
  await expect(other.getByTestId('session-view')).toBeVisible()
  await showTerminal(other)
  await expectTerminalToContain(other, '[fake-claude] ready')
}

/**
 * 状態を1つ作ったカードを用意して、その `card_id` を返す。
 *
 * **状態はサーバが持っている**ので、撃ってから一覧へ戻っても残る。「変わった瞬間」を
 * 見たいときだけ [`openSessionAt`] の2ページ構成を使う。
 */
async function spawnWith(
  page: Page,
  event: string,
  extra = '',
): Promise<string> {
  const tile = await spawnSession(page)
  const cardId = await cardIdOf(tile)
  await openSession(page, tile)
  await fireHook(page, event, extra)
  await page.goto('/')
  return cardId
}

test('起こした直後は名前が無く、履歴が届くと題が出て、開き直しても残る', async ({
  page,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await cardIdOf(tile)

  // 名前は最初のターンのあとに付くので、**起こした直後は必ずこの状態を通る**。
  // 行ごと消さないのは、名前が付いた瞬間にカードが伸びて隣まで動くため（§11-1）。
  // **文字は出さない**（2026-08-26）——待つ以外にできることが無い案内は置かない
  const title = tileOf(page, cardId).getByTestId('session-title')
  await expect(title).toHaveAttribute('data-named', 'false')
  expect((await title.textContent())?.replace(/[\s\u00a0]/g, '')).toBe('')

  await openSession(page, tile)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')

  // パーサ → 契約 → PC 側 → 記録 → 配信 → 画面 と縦に通って初めて出る（§1）。
  // 単体テストは各層の中しか見ないので、**繋がっていることはここでしか分からない**
  await page.goto('/')
  const named = tileOf(page, cardId).getByTestId('session-title')
  await expect(named).toHaveText(TITLE, { timeout: 30_000 })
  await expect(named).toHaveAttribute('data-named', 'true')

  // 記録から読めていること。**起こし直しても消えない**の入口にあたる（§6-1）
  await page.reload()
  await expect(tileOf(page, cardId).getByTestId('session-title')).toHaveText(
    TITLE,
  )
})

test('フックで状態が変わると、カードの動きの種別が変わる', async ({
  page,
  context,
}) => {
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await cardIdOf(tile)
  const shell = shellOf(page, cardId)

  // 起動中は動かさない。**終わったカードが並ぶ画面がいちばんうるさくなる**（§9-1）
  await expect(shell).toHaveAttribute('data-motion', 'still')
  expect(await motionOf(page, cardId)).toMatchObject({
    frame: 'none',
    ring: 'none',
    arc: 'none',
  })

  // **一覧を開いたまま**、もう1枚のページから撃つ。状態そのものは戻っても残るが、
  // ここは「属性と実際の動きが一緒に変わる」ことを見るので、載せたまま観測する
  const other = await context.newPage()
  await openSessionAt(other, cardId)

  await fireHook(other, 'UserPromptSubmit')
  await expect(shell).toHaveAttribute('data-motion', 'spin-fast')
  expect(await motionOf(page, cardId)).toMatchObject({
    arc: 'tile-spin',
    arcOpacity: '1',
  })

  await fireHook(other, 'Stop', '{"last_assistant_message":"終わりました"}')
  await expect(shell).toHaveAttribute('data-motion', 'breathe')
  expect(await motionOf(page, cardId)).toMatchObject({ ring: 'tile-breathe' })

  await fireHook(other, 'Notification', '{"notification_type":"permission_prompt"}')
  await expect(shell).toHaveAttribute('data-motion', 'shake')
  expect(await motionOf(page, cardId)).toMatchObject({ frame: 'tile-shake' })

  await other.close()
})

test('マウスを離すと、揺れは頭から再生される', async ({ page }) => {
  // フェーズ1で3つの形を実測して①（`animation-name` の差し替え）を採った。
  // ②（振れ幅だけの差し替え）だと**動きが継続する**ので、離れた直後に揺れが来る
  // ——「次に揺れるまで最大 4.4秒空く」という §9-3 の言い分が成り立たなくなる。
  // **①を採るという判断そのものが、どこにも守られていなかった**（フェーズ1の引き継ぎ）
  await openDashboard(page)
  const cardId = await spawnWith(
    page,
    'Notification',
    '{"notification_type":"permission_prompt"}',
  )
  const shell = shellOf(page, cardId)
  await expect(shell).toHaveAttribute('data-motion', 'shake')

  // 周期（4.8秒）の途中まで進める
  await moveAway(page)
  await page.waitForTimeout(2_000)
  expect(await shakeClockOf(page, cardId)).toBeGreaterThan(1_000)

  // 乗せると鎮まりへ差し替わり、**そこでも頭から始まる**（＝近づいた側も静止から入る）
  await moveOnto(page, shell)
  await page.waitForTimeout(1_200)
  expect(await motionOf(page, cardId)).toMatchObject({
    frame: 'tile-shake-calm',
  })

  // 離した直後。**戻っていなければ 3,200ms 前後、戻っていれば 0 付近**と桁で分かれる
  await moveAway(page)
  expect(await motionOf(page, cardId)).toMatchObject({ frame: 'tile-shake' })
  expect(await shakeClockOf(page, cardId)).toBeLessThan(1_000)
})

test('静けさを選ぶと、選んだ段だけ動きが止まる', async ({ page }) => {
  // 2枚要る。**「控えめ」は作業中の回転だけを止める**ので、1枚だけでは
  // 「全部止まった」と区別が付かない
  test.slow()
  await openDashboard(page)
  const working = await spawnWith(page, 'UserPromptSubmit')
  const asking = await spawnWith(
    page,
    'Notification',
    '{"notification_type":"permission_prompt"}',
  )

  const quiet = async (level: string) => {
    await page.goto('/settings')
    await page.getByTestId('motion-quiet-select').selectOption(level)
    await expect(page.getByTestId('motion-quiet-select')).toHaveValue(level)
    await page.goto('/')
    // 設定はサーバへ聞いてから届くので、器に印が出るまで待つ。
    // **賑やかのときは属性ごと出ない**ので、待ち方も裏返しになる（§9-5-3）
    if (level === 'lively') {
      await expect(shellOf(page, working)).not.toHaveAttribute(
        'data-quiet',
        /.*/,
      )
    } else {
      await expect(shellOf(page, working)).toHaveAttribute('data-quiet', level)
    }
  }

  // 既定は賑やか。**画を変えない**——12枚の輪が回る画面は要望そのもの（§9-6-2）
  expect(await motionOf(page, working)).toMatchObject({ arc: 'tile-spin' })
  expect(await motionOf(page, asking)).toMatchObject({ frame: 'tile-shake' })

  // 控えめ：作業中は**放っておいてよい状態なのにいちばん強い合図を持っている**ので、
  // ここだけを止める。すると「動いている＝見に行く」に戻る（§9-5-2）
  await quiet('calm')
  expect(await motionOf(page, working)).toMatchObject({
    arc: 'none',
    arcOpacity: '0',
  })
  expect(await motionOf(page, asking)).toMatchObject({ frame: 'tile-shake' })

  // 静止：すべて止まる。**色・記号・文字は残る**ので状態は読める（「止めるのではなく弱める」）
  await quiet('still')
  expect(await motionOf(page, working)).toMatchObject({
    frame: 'none',
    ring: 'none',
    arc: 'none',
  })
  expect(await motionOf(page, asking)).toMatchObject({
    frame: 'none',
    ring: 'none',
    arc: 'none',
  })

  // 戻すと動き出す
  await quiet('lively')
  expect(await motionOf(page, working)).toMatchObject({ arc: 'tile-spin' })
  expect(await motionOf(page, asking)).toMatchObject({ frame: 'tile-shake' })
})

test('OS が「動きを減らす」と言っている間は、賑やかでも止まる', async ({
  page,
}) => {
  // **段の選択で覆せないことが、このテストの主題**（§9-5-2）。要件の完了条件が
  // 「『動きを減らす』設定を入れている利用者には、揺れも回転も止まる」と
  // **無条件で**書いてあるので、賑やかを選んでいても止まらなければならない
  await openDashboard(page)
  const cardId = await spawnWith(
    page,
    'Notification',
    '{"notification_type":"permission_prompt"}',
  )
  const shell = shellOf(page, cardId)
  expect(await shell.getAttribute('data-quiet')).toBeNull()
  expect(await motionOf(page, cardId)).toMatchObject({ frame: 'tile-shake' })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await motionOf(page, cardId)).toMatchObject({
    frame: 'none',
    ring: 'none',
    arc: 'none',
  })

  // **穴1（設計§9-5-4）の再発を捕まえる。** 素の `:hover` は詳細度 (0,3,0) になり、
  // 打ち消し (0,2,0) に勝つ——「動きを減らす」と言っているのに、マウスを乗せた
  // 瞬間だけ揺れが走り出す。`:where(:hover)` で包んであれば、ここは動かない
  await moveOnto(page, shell)
  expect(await motionOf(page, cardId)).toMatchObject({ frame: 'none' })
  await moveAway(page)

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await motionOf(page, cardId)).toMatchObject({ frame: 'tile-shake' })
})

test('ハイコントラストの環境では、切る枠が実線へ退避する', async ({ page }) => {
  // あの環境は `background-image` を強制的に消すので、**円環のグラデーションで
  // 描いている輪は薄い全周ごと丸ごと消える**（§8-4）。状態が読めなくなるのは
  // 記号と文字で補うが、**カードの境目まで消えて見える**のはここで防ぐ
  await openDashboard(page)
  const cardId = await spawnWith(page, 'UserPromptSubmit')

  const frameBorder = async () =>
    page.evaluate((id) => {
      const frame = document.querySelector(
        `[data-testid="tile-shell"][data-card-id="${id}"] .tile-frame`,
      )
      if (frame === null) {
        throw new Error(`切る枠が見つかりません：${id}`)
      }
      const style = getComputedStyle(frame)
      return { style: style.borderTopStyle, width: style.borderTopWidth }
    }, cardId)

  // **見分けるのは太さで、種類ではない。** Tailwind の preflight が全要素へ
  // `border-style: solid; border-width: 0` を敷くので、**素の状態でも種類は `solid`** に
  // なっている（最初この行を `style: 'none'` と書いて落ちた）。太さだけが 0 → 1px と動く
  expect(await frameBorder()).toMatchObject({ style: 'solid', width: '0px' })

  await page.emulateMedia({ forcedColors: 'active' })
  expect(await frameBorder()).toMatchObject({ style: 'solid', width: '3px' })

  // **戻してから終える。** 強制配色は同じページに残るので、置いていくと後続が巻き添えになる
  await page.emulateMedia({ forcedColors: 'none' })
  expect(await frameBorder()).toMatchObject({ width: '0px' })
})

test('状態は右下のタグに出て、①行は最終活動と接続断が収まる', async ({
  page,
}) => {
  /*
    フェーズ13。**jsdom では測れない**（レイアウトを持たないので実寸が全部固定値で
    返る）ので、実物のブラウザでしか確かめられない。

    設計§10-1-3 は実測で「①行に接続断は入らない」と決めていた——**使えるのは 212px
    なのに 290px 要る**（記号24＋状態ラベル最大84＋最終活動112＋接続断54）。
    **状態が右下へ抜けて 166px になったこと**を、ここで数字として押さえる。
  */
  await openDashboard(page)
  const cardId = await spawnWith(page, 'UserPromptSubmit')

  const 測る = async () =>
    page.evaluate((id) => {
      const shell = document.querySelector(
        `[data-testid="tile-shell"][data-card-id="${id}"]`,
      )
      if (shell === null) throw new Error(`カードが見つかりません：${id}`)
      const 最終活動 = shell.querySelector('[data-testid="elapsed"]')
      // **作業中はタグを持たない**（走るアニメーションになる）。どちらかは必ず在る
      const タグ =
        shell.querySelector('[data-testid="tile-tag"]') ??
        shell.querySelector('[data-testid="tile-run"]')
      if (最終活動 === null) throw new Error('最終活動が見つかりません')
      const 行 = 最終活動.parentElement as HTMLElement
      return {
        行幅: Math.round(行.getBoundingClientRect().width),
        // ①行の中身が、行の幅を1pxでも超えていないこと
        はみ出し: Math.round(行.scrollWidth - 行.clientWidth),
        タグあり: タグ !== null,
        // タグは中身より下・右にある（右下と言えること）
        タグが右下: (() => {
          if (タグ === null) return null
          const t = タグ.getBoundingClientRect()
          const s = shell.getBoundingClientRect()
          return t.right <= s.right && t.bottom <= s.bottom && t.top > s.top
        })(),
      }
    }, cardId)

  const 実測 = await 測る()
  // **①行は 212px を超えて広がらない**（カードの内容領域 260px から復旧ボタンぶんを引く前）
  expect(実測.行幅).toBeLessThanOrEqual(260)
  // **溢れていない。** 溢れると切る枠に削られ「接続断」が「接」だけになる（フェーズ6）
  expect(実測.はみ出し).toBe(0)
  // 状態は右下に出ている（作業中は走るアニメーション、他はタグ）
  expect(実測.タグあり).toBe(true)
  expect(実測.タグが右下).toBe(true)

  // ①行に状態のラベルが残っていないこと（①行へ戻すとここが落ちる）
  const 行のテキスト = await page.evaluate((id) => {
    const shell = document.querySelector(
      `[data-testid="tile-shell"][data-card-id="${id}"]`,
    )
    const 行 = shell?.querySelector('[data-testid="elapsed"]')?.parentElement
    return 行?.textContent ?? ''
  }, cardId)
  expect(行のテキスト).toContain('最終活動')
  // ①行に状態のラベルが残っていない（戻すとここが落ちる）
  for (const ラベル of ['作業中', '入力待ち', '停滞', '権限確認待ち']) {
    expect(行のテキスト).not.toContain(ラベル)
  }
})

test('応答が変わると1行が出て、しばらくして消える', async ({
  page,
  context,
}) => {
  test.slow()
  await openDashboard(page)
  const tile = await spawnSession(page)
  const cardId = await cardIdOf(tile)

  // **初回マウントでは出さない。** 一覧を開くたびに全カードが4行になってしまう（§11-2）
  await expect(tileOf(page, cardId).getByTestId('session-echo')).toHaveCount(0)

  // 変化を**載っているカードへ届ける**には、一覧を開いたままにするしかない
  const other = await context.newPage()
  await openSessionAt(other, cardId)
  await fireHook(other, 'Stop', '{"last_assistant_message":"テストが通りました"}')

  const echo = tileOf(page, cardId).getByTestId('session-echo')
  await expect(echo).toHaveText('テストが通りました')

  // 12秒で行ごと消え、いちばん下は名前だけの3行へ戻る
  await expect(echo).toHaveCount(0, { timeout: 20_000 })
  await expect(tileOf(page, cardId).getByTestId('session-title')).toBeVisible()

  await other.close()
})
