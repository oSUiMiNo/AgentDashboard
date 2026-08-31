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
  const button = page.getByTestId('revive-button')
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await button.click()

  await expect(button).toHaveCount(0, { timeout: 60_000 })
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
  const button = page.getByTestId('revive-button')
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await button.click()

  await expect(button).toHaveCount(0, { timeout: 60_000 })
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

test('接続断のカードは、呼吸の山でも沈んだままになる', async ({ page }) => {
  /*
    フェーズ19。**jsdom では測れない**——`@keyframes tile-breathe` の濃さは
    `--tile-fade` を掛けた `calc()` で、その解決はカスケードの先にある。
    単体（`tile.test.ts`）が見られるのは「そう書いてある」ことまでで、
    **そう出ているか**を確かめられるのはここだけ。

    **属性を手で立てない。** `data-connected` の出どころ（サーバの報告）は上の
    テストが見張っているので、ここでは**本物の抜け殻**を相手にする——
    そうしないと「印は付くが沈まない」と「印が付かない」を切り分けられない。

    見るのは**山**である。底だけ見ると、呼吸が止まっているだけでも通ってしまう。
  */
  await openDashboard(page)
  const 沈むはず = await spawnOn(page, 2)
  const 比べる相手 = await spawnOn(page, 1)

  // どちらも入力待ち（呼吸）にする。**ターンが終わった印**を撃つ
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

  /** 1周（2.8秒）ぶんを刻んで、輪の濃さの山と底を採る */
  const 山と底 = async (cardId: string) =>
    page.evaluate(async (id) => {
      const ring = document
        .querySelector(`[data-testid="tile-shell"][data-card-id="${id}"]`)
        ?.querySelector('.tile-ring')
      if (!ring) throw new Error(`輪が見つかりません：${id}`)
      const 値 = []
      // 2.8秒の周期を 3.2秒ぶん、40ms 刻みで。**山を必ず1回は跨ぐ**
      for (let i = 0; i < 80; i += 1) {
        値.push(Number.parseFloat(getComputedStyle(ring).opacity))
        await new Promise((r) => setTimeout(r, 40))
      }
      return { 山: Math.max(...値), 底: Math.min(...値) }
    }, cardId)

  const 接続断 = await 山と底(沈むはず)
  const 接続あり = await 山と底(比べる相手)

  // **繋がっているほうは満輝度まで上がる**（呼吸の設計そのもの。フェーズ8 の 45点）
  expect(接続あり.山).toBeGreaterThan(0.95)
  // **接続断は山でも 60% どまり。** ここが 100% まで上がるのが直す前の姿だった
  expect(接続断.山).toBeLessThan(0.7)
  // 山も底も、繋がっているときの 0.6 倍（率を1本にしてあるので比が揃う）
  expect(接続断.山 / 接続あり.山).toBeCloseTo(0.6, 1)
  expect(接続断.底 / 接続あり.底).toBeCloseTo(0.6, 1)
  // **呼吸そのものは残っている**（設計§24-3。止めると終了と同じ静けさになる）
  expect(接続断.山).toBeGreaterThan(接続断.底 * 1.5)
})
