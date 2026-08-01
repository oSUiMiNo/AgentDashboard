import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * E2E は **ビルドした core サーバ本体**に繋いで動かす。
 *
 * 静的なビルド成果物だけを見ても「本物のサーバと繋がるか」は分からず、フェーズ1の要である
 * WebSocket・PTY・フロー制御が丸ごと検証対象から外れてしまうため。単一バイナリが web を
 * 配信できていることの確認も、この構成なら同時に取れる。
 *
 * 相手にする CLI は擬似 claude（`fake-claude`）。本物を使うと認証と課金が絡み、出力も
 * 毎回変わってテストにならない。実 CLI との結合はテスト計画フェーズ4（計画フェーズ2）が担う。
 *
 * バイナリは `make e2e` が事前にビルドする（web → core の順。core は web/dist を
 * コンパイル時に取り込むため、この順序を崩すと古い画面が配信される）。
 */

const repoRoot = path.resolve(import.meta.dirname, '..')
const serverBinary = path.join(repoRoot, 'server/target/debug/agentdashboard')
const fakeClaude = path.join(repoRoot, 'server/target/debug/fake-claude')

// ブラウザは chromium のみ。個人用ローカルツールなのでクロスブラウザ検証は要件に無く、
// ブラウザバイナリのダウンロード量を抑える判断（テスト計画フェーズ1）。
export default defineConfig({
  testDir: './e2e',
  // 利用者のグローバル設定にあたるファイルを先に置く。これが無いとサーバ側の
  // 注入（設計§6 の主の仕掛け）が一度も動かず、モデルのテストが空振りする
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  // core サーバは全テストで1つを共有する。並列に走らせると、別のテストが起動した
  // セッションが一覧に混ざるだけでなく、同じ端末へキー入力が交互に届いて壊れる
  // （実際に「hook SessionStart」と「こんにちは」が1本の端末で混線した）。
  // ファイルをまたいだ並列も止めるため、ワーカーは1本に固定する
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // セルフホスト構成のぶんは別のサーバ（4174）、2台構成のぶんは compose（4175）、
      // PC 3台のぶんはさらに別のサーバ（4177）
      testIgnore: /(remote|account|compose|fleet)\.spec\.ts/,
    },
    {
      // 別の PC のセッションを、実物のブラウザで見る（セルフホスト化設計§7）。
      // **ローカルモードでは画面配信の経路を1バイトも通らない**ので、
      // 「エージェントが作った画面が xterm.js で再現される」はここでしか確かめられない
      name: 'chromium-remote',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4174' },
      // 入口の鍵とアカウント画面も、**この構成にしか存在しない**（ローカルは鍵が無く、
      // 繋いでくる PC も居ない）
      testMatch: /(remote|account)\.spec\.ts/,
    },
    {
      // インスタンスを2台並べた構成（セルフホスト化設計§9）。**ブラウザが繋がった側に
      // PC が居ない**という配置は、2台立てて初めて作れる。
      //
      // 立ち上げは compose で、しかも順序を持つので `scripts/e2e-compose` が面倒を見る。
      // **この project は `make e2e` では走らない**——docker が要るので既定に含めない
      // （設計§15-3）
      // **`make e2e` では走らない。** project を名指ししてあるのは、docker が
      // 要るものを既定に混ぜないため（設計§15-3）——混ぜると、docker の無い環境で
      // `make ci` の隣が必ず落ちる
      name: 'chromium-compose',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4175' },
      testMatch: /compose\.spec\.ts/,
    },
    {
      // PC を3台つないだ構成（セルフホスト化設計§26 読み替え3）。**PC が2台以上に
      // なると起動フォームに「起動する PC」の選択が現れる**ので、1台構成の画面とは
      // 前提が違う。混線しないことは、この配置でしか確かめられない
      name: 'chromium-fleet',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4177' },
      testMatch: /fleet\.spec\.ts/,
    },
  ],
  // compose の検証（`make e2e-compose`）では**1つも起こさない**。
  //
  // Playwright は project を選んでも `webServer` を全部起こすので、そのままだと
  // ローカルモードとセルフホスト構成のサーバまで立ち上がる。要らないだけでなく、
  // 同じ擬似 claude とポートを取り合って落ちる原因になる。
  webServer: process.env.AGENTDASHBOARD_E2E_COMPOSE ? [] : [
    {
    // 記録の DB（設計§3-2）を**起動の直前に**消す。
    //
    // DB が真実になったので、サーバは起動時に前回のカードを一覧へ復元する（PTY は
    // 道連れで死んでいるが記録は残る、という新しい約束）。実運用ではそれが正しいが、
    // E2E は「まだ何も起動していない」から始まる前提なので、前回の残骸が混ざると
    // ほぼ全部のテストが落ちる。
    //
    // **`globalSetup` では消せない。** Playwright は webServer を先に起動するので、
    // そこで消すと**開いたままのファイルを消す**ことになり、SQLite が
    // 「attempt to write a readonly database」（DBMOVED）を返し続ける。
    // 消す側と開く側の順序は、同じコマンド行に並べて初めて保証できる。
    command: `rm -f test-results/state/dashboard.db* && ${serverBinary} --config e2e/config.toml`,
    env: {
      // 本物の claude ではなく擬似 claude を起動させる
      AGENTDASHBOARD_CLAUDE_BIN: fakeClaude,
      RUST_LOG: 'info',
    },
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
    },
    {
      // セルフホスト構成（サーバ＋エージェント）。**順序を持った起動**なので、
      // トークンの発行から後始末まで1本のスクリプトに寄せてある
      command: `${repoRoot}/scripts/e2e-remote`,
      cwd: repoRoot,
      env: { RUST_LOG: 'info' },
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      // PC を3台つないだ構成。**docker が要らない**ので既定に含めてある
      // （compose 系と違うのはここ）。トークンを台数ぶん発行してから繋ぐという
      // 順序を持つので、こちらも1本のスクリプトに寄せてある
      command: `${repoRoot}/scripts/e2e-fleet`,
      cwd: repoRoot,
      env: { RUST_LOG: 'info' },
      url: 'http://127.0.0.1:4177',
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
  ],
})
