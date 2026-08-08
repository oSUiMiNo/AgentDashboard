import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { openDashboard } from './helpers'

/**
 * 経路がすべて痕跡を残すことの確認（ログ設計§16-1 の1・§1-1）。
 *
 * `make e2e` は project を選んでも **webServer を全部起こす**ので、1本の spec から
 * ローカルモード・版切替・セルフホスト（1台）・PC 3台の**8か所**が同時に見られる。
 * 経路を増やしたら {@link 経路} へ足す——ここが「増やしたら足す形」の実体。
 *
 * # なぜ「いちばん新しいファイル」だけを見るのか
 *
 * `state/logs/` は E2E のたびに掃除されない。`playwright.config.ts` の掃除は
 * `dashboard.db*` と `offsets.json` の名指しで、ログは残す（設計§20-5。全消しにすると
 * 「開発中に何が起きたかを翌日読む」という目的そのものを掃除の都合で失う）。
 * したがって**過去の実行の行が混ざる**。1起動＝1ファイルなので、いちばん新しい
 * ファイルを見れば今回のぶんに絞れる。
 */

/** `web/` から見た E2E の状態の置き場所。 */
const STATE_ROOT = path.resolve(process.cwd(), '.e2e-state')

/** 見る経路。**増やしたらここへ足す。** */
const 経路 = [
  { 何: 'ローカルモード', 置き場所: 'state', proc: 'dashboard' },
  { 何: 'ブラウザ', 置き場所: 'state', proc: 'browser' },
  { 何: '版切替の構成', 置き場所: 'versions-state', proc: 'dashboard' },
  { 何: 'セルフホストのサーバ', 置き場所: 'remote/server', proc: 'dashboard' },
  { 何: 'セルフホストの PC', 置き場所: 'remote/agent', proc: 'session-host' },
  { 何: '3台構成のサーバ', 置き場所: 'fleet/server', proc: 'dashboard' },
  { 何: '3台構成の PC 1', 置き場所: 'fleet/agent-1', proc: 'session-host' },
  { 何: '3台構成の PC 2', 置き場所: 'fleet/agent-2', proc: 'session-host' },
  { 何: '3台構成の PC 3', 置き場所: 'fleet/agent-3', proc: 'session-host' },
] as const

type 行 = {
  ts: string
  level: string
  target: string
  proc: string
  pid: number
  run_id: string
  msg: string
}

/** 必須の7欄（設計§2-1）。 */
const 必須欄 = ['ts', 'level', 'target', 'proc', 'pid', 'run_id', 'msg'] as const

/**
 * その置き場所の**いちばん新しい**ログファイルを読む。無ければ空。
 *
 * **`proc` で絞れる形にしてある**（設計§24）。同じ `logs/` にブラウザのぶん
 * （`browser-*.jsonl`）が並ぶようになったので、絞らずに「いちばん新しい1本」を
 * 取ると、ブラウザがエラーを出した瞬間から `dashboard-*` を見ているつもりの
 * 検査が別のファイルを読むことになる。
 */
function 直近の行(置き場所: string, proc?: string): 行[] {
  const dir = path.join(STATE_ROOT, 置き場所, 'logs')
  let names: string[]
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      // ファイル名は `<proc>-<pid>.<日付>.jsonl`。**中身ではなく名前で絞る**
      // （`logs.rs::split_stem` と同じ数え方。`session-host` と `browser-anon` は
      // ハイフンを含むので、右から1回で割る）
      .filter((name) => {
        if (proc === undefined) {
          return true
        }
        const stem = name.slice(0, name.indexOf('.'))
        return stem.slice(0, stem.lastIndexOf('-')) === proc
      })
  } catch {
    return []
  }
  const 新しい順 = names
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
  if (新しい順.length === 0) {
    return []
  }
  const text = fs.readFileSync(path.join(dir, 新しい順[0].name), 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as 行]
      } catch {
        // **書きかけの行は飛ばす。** 追記の途中を読むことがある
        return []
      }
    })
}

test('経路ごとに1件以上のログが残る', async ({ page }) => {
  // 先にブラウザで繋ぐ。**サーバ側の経路（`server_core::ws`）はここでしか通らない**
  await openDashboard(page)

  // ブラウザの経路は、エラーが起きないと1行も出ない（設計§12-1）。**わざと起こす。**
  // `console.error` ではなく本物の未捕捉エラーにする——前者は拾わないと決めてある
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('E2E がわざと起こした未捕捉のエラー')
    }, 0)
  })

  for (const { 何, 置き場所, proc } of 経路) {
    // 書き込みは非同期（`tracing-appender`）なので、届くまで少し待つ。
    // ブラウザのぶんは1秒ぶんをまとめてから送るので、そのぶんも待つ
    await expect
      .poll(() => 直近の行(置き場所, proc).length, {
        message: `${何}（${置き場所}）のログが1件も無い`,
        timeout: 15_000,
      })
      .toBeGreaterThan(0)

    const 行たち = 直近の行(置き場所, proc)
    for (const 欄 of 必須欄) {
      expect(行たち.every((行) => 行[欄] !== undefined), `${何}: ${欄} が欠けた行がある`).toBe(true)
    }
    expect(
      [...new Set(行たち.map((行) => 行.proc))],
      `${何}: proc が揃っていない`,
    ).toEqual([proc])
  }
})

test('ローカルモードではサーバと PC が1本のファイルに混ざる', async ({ page }) => {
  // 設計§1-1。**同居しているので分けない**——分けようとすると `target` で振り分ける
  // ことになり、どちらにも属さない第三者クレートの行が行き場を失う
  await openDashboard(page)

  await expect
    .poll(
      () =>
        直近の行('state', 'dashboard').filter((行) => 行.target.startsWith('server_core::'))
          .length,
      {
        message:
          'ローカルモードで server_core:: の行が1件も出ていない（設計§23-6）',
        timeout: 10_000,
      },
    )
    .toBeGreaterThan(0)

  const 行たち = 直近の行('state', 'dashboard')
  expect(
    行たち.some((行) => 行.target.startsWith('session_host_core::')),
    'session_host_core:: の行が無い',
  ).toBe(true)
  // 1本に混ざっているので `proc` は全部 dashboard。**分かれていたら混ざっていない**
  expect([...new Set(行たち.map((行) => 行.proc))]).toEqual(['dashboard'])
})
