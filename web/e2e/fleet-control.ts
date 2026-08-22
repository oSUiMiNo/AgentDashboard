import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * 3台つないだうちの**特定の1台**を、テストの中から落としたり起こしたりする
 * （セルフホスト化設計§26 読み替え3）。
 *
 * # なぜテストの中から落とすのか
 *
 * 確かめたいのは「1台落としても他の2台が無傷であること」で、これは
 * **正常に動いている相手からは一度も引き出せない**。落として初めて、印が
 * 付く相手が1台に限られていることが見える。
 *
 * # 立ち上げは script、落とすのはここ
 *
 * 起動の順序（トークンを台数ぶん発行してから繋ぐ）はテストでは表現できないので
 * `scripts/e2e-fleet` が受け持つ。あちらが置いた控え（`env.json` と pid）を読んで、
 * ここでは落とす・起こすだけを行う。
 */

/** 立ち上げ側が控えを置く場所。`scripts/e2e-fleet` と揃えてある。 */
const STATE = path.resolve(import.meta.dirname, '../.e2e-state/fleet')

interface FleetEnv {
  repoRoot: string
  agentBin: string
  fakeClaude: string
  agentConfig: string
  stateDir: string
  agentCount: number
  tokens: string[]
}

function env(): FleetEnv {
  return JSON.parse(
    fs.readFileSync(path.join(STATE, 'env.json'), 'utf8'),
  ) as FleetEnv
}

/** 何台つないである構成か。 */
export function agentCount(): number {
  return env().agentCount
}

/** `検証PC-2` のような、その台の名前。**画面のバッジと選択肢に出る名前**。 */
export function agentName(index: number): string {
  return `検証PC-${index}`
}

function pidFile(index: number): string {
  return path.join(STATE, `agent-${index}.pid`)
}

/** 指定した1台だけを落とす。 */
export function killAgent(index: number): void {
  const pid = Number(fs.readFileSync(pidFile(index), 'utf8'))
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 既に死んでいるなら目的は達している
  }
}

/**
 * 落とした1台を起こし直す。
 *
 * **同じトークンで繋ぎ直す。** 新しく発行すると別の PC として登録され、
 * 「切れた PC が戻ってきた」ではなく「4台目が来た」になってしまう。
 */
export function startAgent(index: number): void {
  const config = env()
  const child = spawn(config.agentBin, ['--config', config.agentConfig], {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      AGENTDASHBOARD_CLAUDE_BIN: config.fakeClaude,
      AGENTDASHBOARD_PAIRING_TOKEN: config.tokens[index - 1],
      AGENTDASHBOARD_AGENT_NAME: agentName(index),
      AGENTDASHBOARD_STATE_DIR: path.join(config.stateDir, `agent-${index}`),
      AGENTDASHBOARD_CLAUDE_SETTINGS_PATH: path.join(
        config.stateDir,
        `agent-${index}`,
        'claude-settings.json',
      ),
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  fs.writeFileSync(pidFile(index), String(child.pid))
}

/**
 * その台が繋がっている／いないと**サーバが言う**まで待つ。
 *
 * 画面のバッジではなくサーバに聞くのは、「まだ描かれていない」と「もう居ない」を
 * 読み違えないため（`helpers.ts` の `archiveAll` と同じ理由）。
 */
export async function waitForAgent(page: Page, index: number, connected: boolean) {
  const name = agentName(index)
  await expect(async () => {
    const response = await page.request.get('/api/settings')
    const view = (await response.json()) as {
      agents: { name: string; connected: boolean }[]
    }
    const target = view.agents.find((agent) => agent.name === name)
    expect(target?.connected).toBe(connected)
  }).toPass({
    timeout: 60_000,
  })
}

/**
 * その台のカードを**抜け殻にする**（接続断のカードを復旧ボタンで戻す テスト計画フェーズ5）。
 *
 * # 何が起きるか
 *
 * 落とすと擬似ターミナルごと claude が死ぬ。起こし直した PC は**1本も抱えていない**ので、
 * サーバは接続時に全カードを一旦「繋がっていない」へ倒し（`gateway.rs` の
 * `set_agent_live(agent_id, false)`）、**報告し直されなかったカードは倒れたまま残る**。
 *
 * この「**PC は居るのに、そのカードだけ接続断**」が復旧の本命の相手である（復旧設計§3-1）。
 * 落としっぱなしにすると「PC が繋がっていません」で断られる側しか作れない。
 *
 * # `remote`（1台構成）では作れない
 *
 * 唯一の PC を落とすと頼む相手が居なくなる。3台つないだこの土台でだけ、
 * **1台だけを抜け殻にして、残り2台は無傷**という配置が作れる。
 *
 * 切れたことを見届けてから起こすのも要点で、待たずに起こすと**サーバがまだ前の接続を
 * 握っている**（同じ PC として名乗るので登録は通るが、指示が死んだほうへ渡って消える）。
 */
export async function orphanAgent(page: Page, index: number) {
  killAgent(index)
  await waitForAgent(page, index, false)
  startAgent(index)
  await waitForAgent(page, index, true)
}
