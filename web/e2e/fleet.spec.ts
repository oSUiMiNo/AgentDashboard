import { expect, test } from '@playwright/test'
import { agentName, killAgent, startAgent } from './fleet-control'
import {
  archiveAll,
  expectTerminalToContain,
  openDashboard,
  openSession,
  spawnSession,
  typeLine,
} from './helpers'

/**
 * PC を3台つないだ通し確認（セルフホスト化設計§8-4・§26 読み替え3）。
 *
 * # 1台構成との違い
 *
 * **どの PC で起こすかを選ぶことになる。**
 *
 * ```text
 *                    ┌── 検証PC-1
 * ブラウザ ── サーバ ─┼── 検証PC-2
 *                    └── 検証PC-3
 * ```
 *
 * 確かめたいのは非機能の「複数 PC 対応」で、中身は**混線しないこと**——
 * 起動先が入れ替わらない、入力が別の PC へ届かない、1台落としても他が無事、である。
 *
 * フェーズ5 で確かめたのは「3台ぶんのカードが同じ一覧に並ぶ」ところまでで、
 * そちらはサーバの内部を見ている。ここはブラウザから実際に操作したときの話で、
 * **画面の前提（起動先の選択）が1台構成と違う**ぶん、あちらでは踏めない道を通る。
 *
 * 立ち上げは `scripts/e2e-fleet` が面倒を見る。ここでは既に3台つながっている前提で、
 * ブラウザから見えるものだけを確かめる。
 */

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

test('起動先を選ぶまで起動できない', async ({ page }) => {
  // **黙って1台目へ送らない**（設計§5-1）。送ってしまうと、意図しない PC で
  // 本物の claude が起動する——利用者から見れば「押したのに違う機械で動いた」に
  // なり、しかも気づくのはずっと後になる
  await openDashboard(page)
  await page.getByTestId('cwd-input').fill('/tmp')

  const button = page.locator('[data-testid="spawn-button"][data-mode=""]')
  await expect(button).toBeDisabled()

  // 選んだ瞬間に押せるようになる
  await page.getByTestId('spawn-target').selectOption({ label: agentName(1) })
  await expect(button).toBeEnabled()
})

test('3台とも一覧で見分けられる', async ({ page }) => {
  // 名前が出ていないと、並んだカードのどれがどの機械のものか分からない。
  // 3台以上を同時に使うときは、これが無いと操作そのものが怖くなる
  await openDashboard(page)

  for (const index of [1, 2, 3]) {
    const tile = await spawnSession(page, '/tmp', agentName(index))
    await expect(tile.getByTestId('agent-badge')).toHaveText(agentName(index))
  }

  await expect(page.getByTestId('session-tile')).toHaveCount(3)
})

test('入力は指定した PC にだけ届く', async ({ page }) => {
  // 混線のいちばん痛い形。**別の機械の claude へ文字が流れる**と、
  // 気づかないまま関係の無いプロジェクトが編集されうる
  await openDashboard(page)
  const first = await spawnSession(page, '/tmp', agentName(1))
  const second = await spawnSession(page, '/tmp', agentName(2))

  await openSession(page, first)
  await typeLine(page, '1号機あて')
  await expectTerminalToContain(page, '[fake-claude] received: 1号機あて')

  await openDashboard(page)
  await openSession(page, second)
  await typeLine(page, '2号機あて')
  await expectTerminalToContain(page, '[fake-claude] received: 2号機あて')

  // **相手の文字が混ざっていないこと**まで見る。届いたことだけを見ると、
  // 両方へ配ってしまう壊れ方を見逃す
  const text = await page.getByTestId('terminal').innerText()
  expect(text).not.toContain('1号機あて')
})

test('1台落としても、印が付くのはその1台だけ', async ({ page }) => {
  // 設計§12 マトリクスのエージェント断を、**3台の中の1台**で見る。
  // 1台構成では「印が付く」ことしか確かめられず、**他が巻き込まれない**ことは
  // この配置でしか見られない
  await openDashboard(page)
  const tiles = []
  for (const index of [1, 2, 3]) {
    tiles.push(await spawnSession(page, '/tmp', agentName(index)))
  }

  killAgent(2)

  await expect(tiles[1].getByTestId('disconnected-badge')).toBeVisible({
    timeout: 60_000,
  })
  // 残りの2台は無傷。**落ちた1台に引きずられて全部が接続断になる**のが
  // いちばんありがちな壊れ方なので、ここを名指しで見る
  await expect(tiles[0].getByTestId('disconnected-badge')).toHaveCount(0)
  await expect(tiles[2].getByTestId('disconnected-badge')).toHaveCount(0)

  startAgent(2)
})

test('落とした PC を起こし直すと、またそこで起こせる', async ({ page }) => {
  // 繋がり直しても**同じ PC として**戻ることを見る（名前が PC の同一性なので、
  // 別物として登録されると4台目が現れる）
  await openDashboard(page)

  killAgent(3)
  // 切れたことを見届けてから起こす。**待たずに起こすと、サーバがまだ前の接続を
  // 握っている**——同じ PC として名乗るので登録は通るが、起動の指示が死んだほうへ
  // 渡って黙って消える（compose の検証で踏んだ）
  await expect(async () => {
    const response = await page.request.get('/api/settings')
    const view = (await response.json()) as {
      agents: { name: string; connected: boolean }[]
    }
    const target = view.agents.find((agent) => agent.name === agentName(3))
    expect(target?.connected).toBe(false)
  }).toPass({ timeout: 60_000 })

  startAgent(3)

  // 繋がるのを待ってから起こす。待たずに押すと候補に出ない
  await expect(async () => {
    const response = await page.request.get('/api/settings')
    const view = (await response.json()) as {
      agents: { name: string; connected: boolean }[]
    }
    expect(view.agents.filter((agent) => agent.connected)).toHaveLength(3)
    // 4台目が増えていないこと（＝別の PC として登録されていない）
    expect(view.agents).toHaveLength(3)
  }).toPass({ timeout: 60_000 })

  await page.reload()
  const tile = await spawnSession(page, '/tmp', agentName(3))
  await expect(tile.getByTestId('agent-badge')).toHaveText(agentName(3))
  await openSession(page, tile)
})

test('アカウント画面に3台が並ぶ', async ({ page }) => {
  // 発行と失効の入口（設計§11-1）。**どの札がどの機械のものか**が分からないと、
  // 失効させる相手を間違える
  await openDashboard(page)
  await page.getByTestId('account-link').click()

  const rows = page.getByTestId('agent-row')
  await expect(rows).toHaveCount(3)
  for (const index of [1, 2, 3]) {
    await expect(rows.filter({ hasText: agentName(index) })).toHaveCount(1)
  }
})
