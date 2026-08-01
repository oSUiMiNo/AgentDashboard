import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * compose で立てた相手を、テストの中から止めたり起こしたりする（セルフホスト化設計§12）。
 *
 * # なぜテストの中から壊すのか
 *
 * 障害マトリクス（§12）の各行は「**壊れたときにどう見えるか**」を決めたもので、
 * 壊さずに確かめる方法が無い。片系ダウンも DB 断もエージェント断も、正常に動いている
 * 相手からは一度も引き出せない。
 *
 * # 立ち上げは script、壊すのはここ
 *
 * 起動の順序（トークンを発行してから繋ぐ）はテストでは表現できないので
 * `scripts/e2e-compose` が受け持つ。あちらが置いた控え（`env.json`）を読んで、
 * ここでは止める・起こすだけを行う。
 */

/**
 * 立ち上げ側が控えを置く場所。
 *
 * **`test-results/` の下ではない。** Playwright は走る前にあそこを丸ごと消すので、
 * `scripts/e2e-compose` が置いた控えが実行の直前に消える。
 */
const STATE = path.resolve(import.meta.dirname, '../.e2e-compose')

interface ComposeEnv {
  repoRoot: string
  composeFile: string
  project: string
  agentBin: string
  fakeClaude: string
  agentConfig: string
  agentUrl: string
  token: string
}

function env(): ComposeEnv {
  return JSON.parse(
    fs.readFileSync(path.join(STATE, 'env.json'), 'utf8'),
  ) as ComposeEnv
}

function compose(...args: string[]): void {
  const { composeFile, project } = env()
  execFileSync(
    'docker',
    ['compose', '-p', project, '-f', composeFile, ...args],
    { stdio: 'ignore' },
  )
}

/** compose のサービスを1つ止める。 */
export function stopService(name: string): void {
  compose('stop', name)
}

/** 止めたサービスを起こし直し、healthcheck が通るまで待つ。 */
export function startService(name: string): void {
  compose('up', '-d', '--wait', name)
}

/** エージェント（ホストで動いている PC 側）を落とす。 */
export function killAgent(): void {
  const pid = Number(fs.readFileSync(path.join(STATE, 'agent.pid'), 'utf8'))
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 既に死んでいるなら目的は達している
  }
}

/**
 * エージェントを起こし直す。
 *
 * **同じトークンで繋ぎ直す。** 新しく発行すると別の PC として登録され、
 * 「切れた PC が戻ってきた」ではなく「2台目が来た」になってしまう。
 */
export function startAgent(): void {
  const config = env()
  const child = spawn(config.agentBin, ['--config', config.agentConfig], {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      AGENTDASHBOARD_CLAUDE_BIN: config.fakeClaude,
      AGENTDASHBOARD_PAIRING_TOKEN: config.token,
      AGENTDASHBOARD_SERVER_URL: config.agentUrl,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  fs.writeFileSync(path.join(STATE, 'agent.pid'), String(child.pid))
}
