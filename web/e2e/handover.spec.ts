/**
 * **押して本当に切り替わる**（`手元の新しい版をGUIだけで効かせる` 設計§7・§9）。
 *
 * # なぜこの土台だけ乗り換えを封じていないのか
 *
 * 他の土台は `AGENTDASHBOARD_VERSION_HANDED_OVER=1` で乗り換えを塞いでいる。塞がないと
 * E2E のサーバが別の実行ファイルへ化けてしまうためだが、**その結果「押して本当に
 * 切り替わる」経路が一度も通っていなかった**。
 *
 * ここでは行き先を**自分の複製**（同じ中身・別の時刻）にしてあるので、化けても同じ
 * ものが同じポートで戻ってくる。時刻だけが違うので「手元が新しい」と判定される——
 * **ソースビルドの機械で `make build` した直後と同じ形**を、実物で作れる。
 *
 * # 何をいちばん確かめたいか
 *
 * **予約を1つも作らずにボタンが出て、押すと本当に入れ替わること。** いまの画面が
 * 役に立っていなかったのは、この1点が成立していなかったためである。
 */

import { expect, test } from '@playwright/test'
import {
  openDashboard,
  spawnSession,
  ダッシュボードのPID,
  プロセス表を読める,
  引き取られていない子,
} from './helpers'

/** この土台の記録の置き場所（`playwright.config.ts` の `AGENTDASHBOARD_STATE_DIR`）。 */
const 記録の置き場所 = '.e2e-state/handover-state'

/** 応答の `started_at` を読む。**入れ替わったかは、これが動いたかで見る。** */
async function startedAt(request: {
  get: (url: string) => Promise<{ json: () => Promise<{ started_at: number }> }>
}): Promise<number> {
  const response = await request.get('/api/versions')
  return (await response.json()).started_at
}

test('予約が1つも無いのに、押すボタンが出る', async ({ page }) => {
  await openDashboard(page)
  await page.goto('/settings')

  // **走っている版が「不明」にならない。** 一覧の行から探していたころは、
  // ソースビルドの機械で必ずここへ落ちていた
  await expect(page.getByTestId('versions-running')).not.toHaveText(/不明/)

  // 予約は無い
  await expect(page.getByTestId('versions-picker')).toHaveValue('')
  await expect(page.getByTestId('versions-reservation')).toHaveCount(0)

  // それでも「ディスクに新しい版があります」と押すボタンが出る
  await expect(page.getByTestId('versions-disk-update')).toBeVisible()
  await expect(page.getByTestId('versions-restart')).toBeVisible()
  // 押す前に、何が失われるかが出る
  await expect(page.getByTestId('versions-stranded')).toBeVisible()
})

test('入れる側が置いた版も一覧に並ぶが、消せない', async ({ page }) => {
  await openDashboard(page)
  await page.goto('/settings')

  const list = page.getByTestId('versions-stored')
  await expect(list).toBeVisible()
  // 保管庫の版だけを出していたころは、ビルドした版がどこにも現れなかった
  await expect(page.getByTestId('versions-installed-mark')).toBeVisible()

  // 走ってきた場所なので消させない。**行そのものは出す**（在ることと消せることは別）
  const installedRow = list.locator('li', {
    has: page.getByTestId('versions-installed-mark'),
  })
  await expect(installedRow.getByRole('button', { name: '消す' })).toHaveCount(0)
})

test('押すと本当に入れ替わり、同じ入口で戻ってくる', async ({ page, request }) => {
  await openDashboard(page)

  // **抱えている子が1本も無いと、この検査は何も見ていない**（ゾンビ設計§5-4）。
  // 入れ替えで道連れになる相手を1本作ってから押す
  const 数えられる = プロセス表を読める()
  if (数えられる) {
    await spawnSession(page)
  }
  const pid = 数えられる ? ダッシュボードのPID(記録の置き場所) : 0
  const 入れ替える前のゾンビ = 数えられる ? 引き取られていない子(pid) : 0

  await page.goto('/settings')

  const before = await startedAt(request)

  await page.getByTestId('versions-restart').click()

  // **`started_at` が動いたかで見る。** 押した直後は古いサーバが応答を返し続けるので、
  // 「繋がるか」で待つと入れ替わる前の値を読んでしまう（実測で踏んだ）
  await expect
    .poll(async () => {
      try {
        return await startedAt(request)
      } catch {
        // 入れ替わっている最中は繋がらない瞬間がある
        return before
      }
    }, { timeout: 60_000, intervals: [500] })
    .not.toBe(before)

  // 同じ入口で戻ってきている
  const response = await request.get('/api/me')
  expect(response.ok()).toBe(true)

  // **ブラウザは自分で繋ぎ直す。** 読み込み直しを促す前に、まず線が戻ることを見る
  // ——戻らないなら「押したら画面が死んだ」と同じ体験になる
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
    { timeout: 30_000 },
  )

  if (!数えられる) {
    return
  }
  // **`exec` なので PID は変わらない。** 変わっていたら入れ替えではなく起こし直しで、
  // 以降の突き合わせは別のプロセスを見ていることになる
  expect(ダッシュボードのPID(記録の置き場所)).toBe(pid)
  // **ここがこのイシューの本丸。** 入れ替えは抱えている子を道連れにするが、
  // 落とす前に引き取っていれば、引き取られていない子は1体も増えない
  await expect
    .poll(() => 引き取られていない子(pid), { timeout: 15_000, intervals: [200] })
    .toBe(入れ替える前のゾンビ)
})
