import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
const STATE = path.resolve(import.meta.dirname, '../test-results/fleet')

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
