import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { agentName, killAgent, orphanAgent, startAgent, waitForAgent } from './fleet-control'
import {
  WORK_DIR,
  addProject,
  archiveAll,
  expectTerminalToContain,
  fireHook,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
} from './helpers'

/**
 * 抜け殻のカードを、復旧ボタンで元のセッションへ戻す（接続断のカードを復旧ボタンで戻す
 * 設計§9・§12）。
 *
 * # 名前を `restore.spec.ts` と分けてある
 *
 * あちらは**ブラウザのリロード復元**（画面の状態が読み込み直しで消えないこと）で、
 * こちらは**死んだ claude を起こし直す**話である。同じ「復元」でも指しているものが違う。
 *
 * # なぜ3台の土台（`fleet`）なのか
 *
 * 確かめたい状態は「**PC は居るのに、そのカードだけ接続断**」である。1台構成
 * （`scripts/e2e-remote`）でこれを作ろうとすると、唯一の PC を落とすことになり
 * **頼む相手が居なくなる**——「この PC が繋がっていません」で断られる側しか作れない。
 *
 * 3台なら1台だけを抜け殻にできて、しかも**残り2台が無傷であること**まで同時に見える
 * （`orphanAgent`）。
 *
 * # 揺れないための足場は、待ち時間ではなく席と印
 *
 * 「順番待ちが見える」も「二度目が断られる」も、**セッションホストが持つ席
 * （`REVIVE_PARALLEL` = 2）と印**で決まる。席は最初のフックが届くまで返らず、擬似 claude は
 * 自分からフックを撃たないので、**3枚並べれば1枚は確実に待つ**。実行環境の速さに
 * 左右されない。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** 小窓から `card_id` を読む。**並び順で拾わない**——抜け殻になると並びが動く。 */
async function cardIdOf(tile: Locator): Promise<string> {
  const cardId = await tile.getAttribute('data-card-id')
  if (!cardId) {
    throw new Error('小窓から card_id を読めません')
  }
  return cardId
}

/** その `card_id` の小窓。 */
function tileOf(page: Page, cardId: string): Locator {
  return page.locator(`[data-testid="session-tile"][data-card-id="${cardId}"]`)
}

/**
 * その小窓の復旧ボタン。
 *
 * **小窓の中には居ない。** 小窓そのものがボタンなので中に別のボタンを置けず、器へ
 * **絶対配置の兄弟**として重ねてある（設計§9-1）。したがって
 * `tileOf(...).getByTestId('revive-button')` は**何も見つけずに 0 件で通る**——
 * 実際にそう書いて、5本が「消えていること」を確かめたつもりで空振りした。
 *
 * **かつては隣接兄弟（`+`）で書いていたが、カードが4層になって隣ではなくなった**
 * （カード設計§7）。いまは器（`tile-shell`）から辿る——器は小窓と同じ `card_id` を
 * 名乗るので、間に何が挟まっても対応が崩れない。
 */
function reviveButtonOf(page: Page, cardId: string): Locator {
  return page.locator(
    `[data-testid="tile-shell"][data-card-id="${cardId}"] [data-testid="revive-button"]`,
  )
}

/** 渡したカードのうち、いま「復旧中…」を出しているものだけ。 */
async function revivingIds(page: Page, ids: string[]): Promise<string[]> {
  const found: string[] = []
  for (const cardId of ids) {
    const button = reviveButtonOf(page, cardId)
    if ((await button.count()) > 0 && (await button.innerText()).includes('復旧中')) {
      found.push(cardId)
    }
  }
  return found
}

/** 指定した台で1枚起こし、その `card_id` を返す。 */
async function spawnOn(page: Page, index: number): Promise<string> {
  return cardIdOf(await spawnSession(page, WORK_DIR, agentName(index)))
}

/**
 * そのカードが**呼び戻し先を持つ**まで待つ（サーバに聞く）。
 *
 * **抜け殻にする前に必ず通す。** 呼び戻し先は CLI が名乗ってから載るので、
 * 名乗る前に落とすと「戻す先が無い」カードになり、**起こし直せる候補に数えられない**
 * ——画面には「起こし直せるカードはありません（0枚）」と出て、待っても変わらない。
 *
 * 単独で走らせると擬似 claude が速いので素通りするが、**前のテストが同じ台を
 * 落として起こし直した直後**は間に合わないことがある（実際に踏んだ）。
 */
async function waitForResumeTarget(page: Page, cardId: string) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/sessions')
        const list = (await response.json()) as {
          card_id: string
          claude_session_id: string | null
        }[]
        return list.find((card) => card.card_id === cardId)?.claude_session_id ?? null
      },
      { timeout: 60_000 },
    )
    .not.toBeNull()
}

interface Queued {
  /** 席が空くのを待っている1枚。 */
  pending: string
  /** 席を取って起き上がった2枚。 */
  started: string[]
}

/**
 * 3枚を抜け殻にして「全て復旧」を押し、**1枚を順番待ちにする**。
 *
 * 席は2つなので、3枚目は必ず待つ。しかも先に起きた2枚は**フックが1件も来ない**ので
 * `Starting` のまま席を握り続ける（天井は60秒）。**この間だけ、待っている側の
 * 「復旧中…」と、二度目の頼みへの断りを落ち着いて観測できる。**
 */
async function queueOne(page: Page, index: number): Promise<Queued> {
  const ids: string[] = []
  for (let count = 0; count < 3; count += 1) {
    ids.push(await spawnOn(page, index))
  }
  await orphanAgent(page, index)
  await expect(page.getByTestId('revive-breakdown')).toContainText('接続断 3枚', {
    timeout: 60_000,
  })

  await page.getByTestId('revive-all').click()

  // 押した直後は3枚とも「復旧中…」で、席を取った2枚が `live` になってボタンごと
  // 消えると1枚だけが残る。**0 でも 3 でもなく 1 に落ち着くのを待つ**ので、
  // 押す前の状態で素通りすることはない
  await expect
    .poll(async () => (await revivingIds(page, ids)).length, { timeout: 60_000 })
    .toBe(1)
  const [pending] = await revivingIds(page, ids)
  return { pending, started: ids.filter((id) => id !== pending) }
}

/**
 * 起き上がった1枚にフックを撃って**席を1つ返させる**。
 *
 * 席が返る条件は「カードが `Starting` を抜けること」＝最初のフックが届くこと
 * （設計§8-5）。後片付けのためだけの手順ではない——**待っていた1枚が本当に
 * 起き上がる**ところまで見て、初めて「順番待ち」だったと言える。
 */
async function drainOneSeat(page: Page, startedId: string) {
  await openSession(page, tileOf(page, startedId))
  await fireHook(page, 'SessionStart')
  await openDashboard(page)
}

test('起こし直した PC のカードは、接続断のまま残る', async ({ page }) => {
  // **以降の全部がこの1本に乗っている。** ここが成り立たないと、押す相手そのものが
  // 作れず、後続は「何も確かめていない」まま緑になる
  await openDashboard(page)
  const target = await spawnOn(page, 2)
  // **巻き添えは「他の2台とも」で見る。** 1台だけ見ると、隣の1台にしか波及しない
  // 壊れ方を見逃す
  const bystanders = [await spawnOn(page, 1), await spawnOn(page, 3)]

  await orphanAgent(page, 2)

  // PC は繋がっている（`orphanAgent` が見届けている）のに、そのカードは倒れたまま。
  // サーバは接続時に全カードを一旦倒し、**報告し直されたものだけ**を戻すので、
  // 起こし直した PC が1本も抱えていないこの状態が、そのまま復旧の相手になる
  await expect(tileOf(page, target).getByTestId('disconnected-badge')).toBeVisible({
    timeout: 60_000,
  })
  await expect(reviveButtonOf(page, target)).toHaveAttribute('data-state', 'ready')

  // **落とした1台に引きずられて全部が接続断になる**のがいちばんありがちな壊れ方
  for (const bystander of bystanders) {
    await expect(tileOf(page, bystander).getByTestId('disconnected-badge')).toHaveCount(0)
    await expect(reviveButtonOf(page, bystander)).toHaveCount(0)
  }
})

test('小窓の復旧ボタンを押すと、そのカードが戻る', async ({ page }) => {
  await openDashboard(page)
  const cardId = await spawnOn(page, 2)
  await orphanAgent(page, 2)

  const tile = tileOf(page, cardId)
  await expect(reviveButtonOf(page, cardId)).toBeEnabled({ timeout: 60_000 })
  await reviveButtonOf(page, cardId).click()

  // 戻ると `live` になるので、接続断のバッジも復旧ボタンも消える
  await expect(tile.getByTestId('disconnected-badge')).toHaveCount(0, { timeout: 60_000 })
  await expect(reviveButtonOf(page, cardId)).toHaveCount(0)
  // **小窓がまだそこに在ること**まで見る。器（小窓そのものがボタン）へクリックが
  // 伝わっていると専用画面へ移ってしまい、上の2行は「消えた」ではなく
  // 「画面ごと無い」で通ってしまう
  await expect(tile).toBeVisible()

  // 抜け殻でなくなっていること——指示が本当に届く
  await openSession(page, tile)
  await typeLine(page, '起こし直したあとの指示')
  await expectTerminalToContain(page, '[fake-claude] received: 起こし直したあとの指示')
})

test('セッション専用画面からも押せる', async ({ page }) => {
  await openDashboard(page)
  const cardId = await spawnOn(page, 2)
  await orphanAgent(page, 2)

  await page.goto(`/s/${cardId}`)
  /*
    **押しても消えない**（帯設計§15-1）。スリープと復旧は1つの電源ボタンに畳まれた
    ので、起きたあとは**同じボタンが点灯へ変わる**——`toHaveCount(0)` で見ていた
    ころの「消えたら成功」は、もう成立しない。
  */
  const button = page.getByTestId('power-card')
  await expect(button).toHaveAttribute('data-power', 'off')
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await button.click()

  await expect(button).toHaveAttribute('data-power', 'on', { timeout: 60_000 })
  await expect(button).toHaveAttribute('data-action', 'sleep')
  await expect(page.getByTestId('session-view')).toBeVisible()
})

test('横並び（PJT 専用画面）からも押せる', async ({ page }) => {
  // 十字ボタンを横並びで出さなかった前例には引きずられない（設計§9-2）。あれは
  // **宛先が1つに定まらない**ためで、復旧はカードごとに一意である
  await openDashboard(page)
  const cardId = await spawnOn(page, 2)
  // 既にある枠を指すと同じ枠が返る（`addProject`）
  const group = await addProject(page, WORK_DIR, agentName(2))
  const host = await group.getAttribute('data-host')
  const project = await group.getAttribute('data-project')

  await orphanAgent(page, 2)

  await page.goto(`/p/${encodeURIComponent(host ?? '')}/${encodeURIComponent(project ?? '')}`)
  const button = page.getByTestId('power-card')
  await expect(button).toHaveAttribute('data-power', 'off')
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await button.click()

  // 横並びでも、押したあとは同じボタンが点灯へ変わる（帯設計§15-1）
  await expect(button).toHaveAttribute('data-power', 'on', { timeout: 60_000 })
  // 横並びの画面に居たまま戻ること。**移ってしまうと上の1行は「消えた」ではなく
  // 「画面ごと無い」で通る**
  await expect(page.getByTestId('session-view')).toBeVisible()
  await expect(page.getByTestId('session-view')).toHaveAttribute(
    'data-card-id',
    cardId,
  )
})

test('全て復旧を押すと、抜け殻がまとめて戻る', async ({ page }) => {
  await openDashboard(page)
  const first = await spawnOn(page, 2)
  const second = await spawnOn(page, 2)

  await orphanAgent(page, 2)

  // 押す前に内訳が出ていること。**「全て」の中身が分からないと押せない**（要件）
  await expect(page.getByTestId('revive-breakdown')).toContainText(
    '接続断 2枚／終了 0枚',
    { timeout: 60_000 },
  )
  await page.getByTestId('revive-all').click()

  for (const cardId of [first, second]) {
    await expect(tileOf(page, cardId).getByTestId('disconnected-badge')).toHaveCount(0, {
      timeout: 60_000,
    })
  }
  // 戻りきったら対象は0枚。**0枚なら0枚と言う**——沈黙させない
  await expect(page.getByTestId('revive-breakdown')).toContainText('0枚')
  await expect(page.getByTestId('revive-all')).toBeDisabled()
})

test('席が空くまで、順番待ちのカードは復旧中のまま', async ({ page }) => {
  test.slow()
  await openDashboard(page)
  const { pending, started } = await queueOne(page, 2)

  // 待っている1枚は、まだ抜け殻のまま——**サーバから届く値は1バイトも変わらない**
  // ので、ブラウザの印だけがこの区間を埋めている（設計§9-4）
  await expect(tileOf(page, pending).getByTestId('disconnected-badge')).toBeVisible()
  await expect(reviveButtonOf(page, pending)).toBeDisabled()

  // 席が返れば、待っていた1枚がそのまま起き上がる
  await drainOneSeat(page, started[0])
  await expect(tileOf(page, pending).getByTestId('disconnected-badge')).toHaveCount(0, {
    timeout: 60_000,
  })
})

test('順番待ちのカードへもう一度頼むと、そのカードに断りが出る', async ({ page }) => {
  test.slow()
  await openDashboard(page)
  const { pending, started } = await queueOne(page, 2)

  // 対象は待っている1枚だけになっている（起き上がった2枚は `live`）
  await expect(page.getByTestId('revive-breakdown')).toContainText('接続断 1枚／終了 0枚')
  await page.getByTestId('revive-all').click()

  // **待ち行列に並ばせない**（設計§8-1）。同じカードが2つ並ぶと、席が空いたときに
  // 両方とも通る。断りは画面全体の帯ではなく**そのカード**に出る（§9-5）
  await expect(tileOf(page, pending).getByTestId('card-error')).toHaveText(
    'このカードは復旧中です',
    { timeout: 60_000 },
  )
  // 巻き添えが無いこと。帯へ出していると、どのカードの話か分からなくなる
  await expect(tileOf(page, started[0]).getByTestId('card-error')).toHaveCount(0)

  // 断られただけで、最初の頼みは生きている——席が返れば起き上がる
  await drainOneSeat(page, started[0])
  await expect(tileOf(page, pending).getByTestId('disconnected-badge')).toHaveCount(0, {
    timeout: 60_000,
  })
})

test('PC が繋がっていないカードでは押せず、理由が出る', async ({ page }) => {
  // **壊す系はいちばん後ろに置く。** 共有の土台なので、戻し損ねると後続が全部かぶる
  await openDashboard(page)
  const cardId = await spawnOn(page, 3)

  try {
    killAgent(3)
    await waitForAgent(page, 3, false)
    // **繋がっている PC の一覧は、画面に入った時点でしか取り直さない。** 落ちたことを
    // 画面へ反映させるには読み込み直しが要る（読み込み直さなければボタンは押せるままで、
    // 押すとサーバが断る——設計§3-3 が「ずれても危険側には倒れない」と言っている側）
    await openDashboard(page)

    const button = reviveButtonOf(page, cardId)
    await expect(button).toBeVisible({ timeout: 60_000 })
    // **出さないのではなく、出したうえで押せなくする**（設計§3-2）。出さないと
    // 「なぜこのカードにだけ無いのか」を利用者が推測することになる
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('data-state', 'pc-offline')
    await expect(button).toHaveAttribute('title', 'この PC が繋がっていません')
  } finally {
    startAgent(3)
    await waitForAgent(page, 3, true)
  }
})

/**
 * メモリの歯止め（起こし直し設計§18-5）。
 *
 * # 「足りない」を決定的に作る
 *
 * `fits_now = (空き − 余白) ÷ 見積もり` なので、**余白を桁外れに大きくすると、
 * どの機械でも `0` になる**。空きの実測値に頼ると、走らせる機械によって
 * 出たり出なかったりする検査になってしまう。
 *
 * 上書きは**その1台だけ**へ入れる（`orphanAgent` の第3引数）。全台へ入れると、
 * 上に並んでいる復旧のテストが**全部床で断られる**。
 *
 * **壊す系なので、いちばん後ろに置く。** 戻すのは `finally` で。
 */
test('入りきらないときはダイアログが出て、押すまで1枚も起きない', async ({ page }) => {
  await openDashboard(page)
  const ids: string[] = []
  for (let count = 0; count < 2; count += 1) {
    ids.push(await spawnOn(page, 2))
  }
  for (const cardId of ids) {
    await waitForResumeTarget(page, cardId)
  }

  try {
    // 余白を桁外れに大きくして、この台だけ「1枚も入らない」にする
    await orphanAgent(page, 2, {
      AGENTDASHBOARD_REVIVE_HEADROOM_MB: '100000000',
    })
    await expect(page.getByTestId('revive-breakdown')).toContainText('接続断 2枚', {
      timeout: 60_000,
    })

    await page.getByTestId('revive-all').click()

    const dialog = page.getByTestId('revive-budget-dialog')
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    // **枚数と、いま入る枚数の両方が出る。** 枚数だけでは資源が読めない
    await expect(page.getByTestId('revive-budget-targets')).toHaveText('2枚')
    await expect(page.getByTestId('revive-budget-fits')).toContainText('0枚')
    // 1枚も入らないので、入るぶんだけは押せない
    await expect(page.getByTestId('revive-budget-fitting')).toBeDisabled()

    // **押すまで何も起きない。** 抜け殻のままであること
    for (const cardId of ids) {
      await expect(tileOf(page, cardId).getByTestId('disconnected-badge')).toBeVisible()
    }

    // やめれば閉じる
    await page.getByTestId('revive-budget-cancel').click()
    await expect(dialog).toBeHidden()
  } finally {
    // **床を元へ戻す。** 共有の土台なので、戻し損ねると後続が全部かぶる
    killAgent(2)
    await waitForAgent(page, 2, false)
    startAgent(2)
    await waitForAgent(page, 2, true)
  }
})

test('それでも全部を選ぶと、PC が床で断って理由がカードに出る', async ({ page }) => {
  // **画面の歯止めを越えても、機械は死なない。** 歯止めは画面と PC の両方にあり、
  // CLI から叩いた場合も PC 側が守る（設計§18-3）
  await openDashboard(page)
  const cardId = await spawnOn(page, 2)
  await waitForResumeTarget(page, cardId)

  try {
    await orphanAgent(page, 2, {
      AGENTDASHBOARD_REVIVE_HEADROOM_MB: '100000000',
    })
    await expect(page.getByTestId('revive-breakdown')).toContainText('接続断 1枚', {
      timeout: 60_000,
    })

    await page.getByTestId('revive-all').click()
    await expect(page.getByTestId('revive-budget-dialog')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('revive-budget-all').click()

    // PC が断り、理由がそのカードへ出る（設計§9-5 の名指しの経路）
    await expect(tileOf(page, cardId)).toContainText('メモリが足りない', {
      timeout: 60_000,
    })
    // 起き上がっていないこと
    await expect(tileOf(page, cardId).getByTestId('disconnected-badge')).toBeVisible()
  } finally {
    killAgent(2)
    await waitForAgent(page, 2, false)
    startAgent(2)
    await waitForAgent(page, 2, true)
  }
})

test('接続断のカードは呼吸せず、輪も札も同じ濃さで座る', async ({ page }) => {
  /*
    フェーズ19（輪も沈める）とフェーズ22（札を輪と同じだけ沈める・呼吸を止める）を、
    1本で見る。**この2つは同じ不変条件の裏表**なので、別々に置くと片方だけ直したときに
    もう片方が空振りする。

    **jsdom では測れない。** 濃さは `--tile-ink` を読む `opacity` で、疑似要素（`::before`）に
    付いているものもある。単体（`tile.test.ts`）が見られるのは「そう書いてある」ことまでで、
    **カスケードがそう解決するか**はここでしか分からない。

    **属性を手で立てない。** `data-connected` の出どころ（サーバの報告）は上のテストが
    見張っているので、ここでは**本物の抜け殻**を相手にする——そうしないと
    「印は付くが沈まない」と「印が付かない」を切り分けられない。

    # 呼吸を止めたのは、周期のどこを見るかで一致が変わったから（設計§27-2）

    §24-3 は「呼吸は『あなたの番』の合図」として残す側に倒していたが、**輪だけが
    0.330〜0.600 を行き来し、札は動かない**ので、**山では一致し、底では 1.8倍ずれる**。
    利用者には「直っていない」と見えた。**抜け殻は答えても先へ進まない**ので、動きで
    急かす意味も無い。
  */
  await openDashboard(page)
  const 沈むはず = await spawnOn(page, 2)
  const 比べる相手 = await spawnOn(page, 1)

  // どちらも入力待ち（＝繋がっていれば呼吸する状態）にする
  for (const cardId of [沈むはず, 比べる相手]) {
    await openSession(page, tileOf(page, cardId))
    await fireHook(page, 'Stop', '{"last_assistant_message":"終わりました"}')
    await page.goto('/')
  }
  await waitForResumeTarget(page, 沈むはず)
  await orphanAgent(page, 2)
  await expect(tileOf(page, 沈むはず).getByTestId('disconnected-badge')).toBeVisible({
    timeout: 60_000,
  })

  /** 1周（2.8秒）ぶんを刻んで、輪と札の濃さの山と底、それに文字色を採る */
  const 採る = async (cardId: string) =>
    page.evaluate(async (id) => {
      const shell = document.querySelector(
        `[data-testid="tile-shell"][data-card-id="${id}"]`,
      )
      const ring = shell?.querySelector('.tile-ring')
      const tag = shell?.querySelector('[data-testid="tile-tag"]')
      const body = shell?.querySelector('[data-testid="session-tile"]')
      if (!ring || !tag || !body) throw new Error(`輪か札が見つかりません：${id}`)

      /*
        **色は自分で解釈しない。** `color-mix` の解決先は `color(srgb …)` で、
        地は `oklch()` である。**文字列から数を拾うと違う色として読む**（ガイドライン）。
        canvas へ描かせて、ブラウザが解決した画素を読む。
      */
      const c = document.createElement('canvas')
      c.width = c.height = 1
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      const 画素 = (色: string, 地?: string, alpha = 1) => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.globalAlpha = 1
        if (地) {
          ctx.fillStyle = 地
          ctx.fillRect(0, 0, 1, 1)
        }
        ctx.globalAlpha = alpha
        ctx.fillStyle = 色
        ctx.fillRect(0, 0, 1, 1)
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }

      const 輪: number[] = []
      // 2.8秒の周期を 3.2秒ぶん、40ms 刻みで。**山を必ず1回は跨ぐ**
      for (let i = 0; i < 80; i += 1) {
        輪.push(Number.parseFloat(getComputedStyle(ring).opacity))
        await new Promise((r) => setTimeout(r, 40))
      }

      const 板 = getComputedStyle(tag, '::before')
      const 地 = getComputedStyle(body).backgroundColor
      const 色 = getComputedStyle(shell!).getPropertyValue('--tile-accent')
      /*
        **濃さは `--tile-ink` から読めない。** カスタムプロパティは
        `calc(var(--tile-dim) * 0.6)` という**書いたままの字面**で返り、数にならない。
        **輪の `opacity` が、その解決済みの値そのもの**（`.tile-ring` が読んでいる）。
      */
      const 濃さ = Math.max(...輪)
      return {
        輪の山: Math.max(...輪),
        輪の底: Math.min(...輪),
        // **板は不透明でなければならない**（フェーズ23。半透明だと裏の名前が透ける）
        板の不透明度: 板.opacity,
        板の色: 画素(板.backgroundColor),
        // 繋がっているときは満輝度、接続断は「輪と同じ濃さで地に混ぜた色」
        満輝度の色: 画素(色),
        沈めた色: 画素(色, 地, 濃さ),
        文字: getComputedStyle(tag).color,
      }
    }, cardId)

  const 接続断 = await 採る(沈むはず)
  const 接続あり = await 採る(比べる相手)

  // **繋がっているほうは呼吸する**（設計そのもの。山は満輝度まで上がる）
  expect(接続あり.輪の山).toBeGreaterThan(0.95)
  expect(接続あり.輪の山).toBeGreaterThan(接続あり.輪の底 * 1.5)

  // **接続断は呼吸しない**（フェーズ22。§24-3 を覆した）。山と底が同じ値になる
  expect(接続断.輪の山).toBeCloseTo(接続断.輪の底, 2)
  // **輪は沈んだまま座る**（入力待ちの濃さ 75% × 0.6 ＝ 0.45）
  expect(接続断.輪の山).toBeCloseTo(0.45, 2)

  /*
    **板は不透明**（フェーズ23。設計§28）。`opacity` で沈めると**裏のセッション名が透ける**
    ——札は3行目の名前の上に重なる作りなので、半透明にした瞬間に文字が板越しに出る。
  */
  expect(接続断.板の不透明度).toBe('1')
  expect(接続あり.板の不透明度).toBe('1')

  /*
    **色は輪と同じ濃さで作る**（フェーズ22。設計§27）。不透明にしても**見える色は変わらない**
    ——`opacity: α` で地の上に置いた色と、α だけ混ぜて塗った色は同じ。
  */
  /*
    **一致は ±1 で見る。** `color-mix` の丸めと canvas の α 合成の丸めは一段違うので、
    **同じ色でも成分が1ずれる**。**厳密一致にすると、正しい実装でも落ちる。**
  */
  const 同じ色 = (a: number[], b: number[], 何: string) => {
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs(a[i] - b[i]), `${何}：rgb(${a}) と rgb(${b})`).toBeLessThanOrEqual(1)
    }
  }
  同じ色(接続断.板の色, 接続断.沈めた色, '接続断の札')
  // **繋がっているほうは満輝度のまま**（§26-6「触らないもの」）
  同じ色(接続あり.板の色, 接続あり.満輝度の色, '接続ありの札')

  /*
    **文字は繋がっているときと同じ黒**（フェーズ24。利用者の指定）。沈めた板の上では
    床を割るが、**状態は枠線・記号・「接続断」バッジ・復旧ボタンが担っている**ので許容する。
  */
  expect(接続断.文字).toBe('rgb(23, 23, 23)')
  expect(接続あり.文字).toBe('rgb(23, 23, 23)')
})

test('接続断のカードでも、3行目が狭い画面からはみ出さない', async ({ page }) => {
  /*
    帯の設計§11-7 の実物確認。**3行目がいちばん混むのはこの状態**——終わってはいない
    のでモデルとモードのピッカーが出たまま、そこへ `復旧` が並ぶ。

    ローカルの土台では線を切れないので、**この構成でしか作れない場面**である。
    設計は測った部品の幅（128＋128＋48＋間隔16 ＝ 320px ≤ 351px）から「収まる見込み」
    と書いていたが、**算術は算術**なので、ここで実物に当てる。
  */
  await page.setViewportSize({ width: 375, height: 780 })
  await openDashboard(page)
  const cardId = await spawnOn(page, 2)
  await orphanAgent(page, 2)
  await expect(tileOf(page, cardId).getByTestId('disconnected-badge')).toBeVisible({
    timeout: 60_000,
  })

  await page.goto(`/s/${cardId}`)
  const view = page.getByTestId('session-view')
  /*
    **測る先が操作列へ移った**（帯設計§17-1）。この場面がいちばん混む理由は変わらない
    ——終わってはいないのでピッカーが出たまま、そこへ**操作が4つ並ぶ行**が加わる。

    **帯（`screen-bar`）はもう行を持たない。** サイドバー・PJT 名・✕ が1列に並ぶだけで、
    数える対象はセッションの操作列（`session-ops`）のほうにある。
  */
  await expect(view.getByTestId('model-picker')).toBeVisible()
  await expect(view.getByTestId('permission-mode-picker')).toBeVisible()
  const 電源 = view.getByTestId('power-card')
  await expect(電源).toHaveAttribute('data-power', 'off')

  const 溢れ = await view.getByTestId('session-ops').evaluate((el) => {
    const 行の溢れ = (n: string) => {
      const row = el.querySelector(`[data-row="${n}"]`)
      return row === null ? -1 : row.scrollWidth - row.clientWidth
    }
    return {
      操作の行: 行の溢れ('1'),
      選ぶ行: 行の溢れ('2'),
      ページ:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    }
  })
  expect(溢れ.操作の行, '操作の行が入れ物からはみ出さないこと').toBeLessThanOrEqual(0)
  expect(溢れ.選ぶ行, 'モデルとモードの行がはみ出さないこと').toBeLessThanOrEqual(0)
  expect(溢れ.ページ, 'ページが横へはみ出さないこと').toBeLessThanOrEqual(0)

  // 操作列は2行のまま（電源ボタンが消灯でも増えない）
  await expect(
    view.locator('[data-testid="session-ops"] [data-row]'),
  ).toHaveCount(2)
})
