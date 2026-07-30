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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
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
})
