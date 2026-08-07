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
      testIgnore: /(remote|account|compose|fleet|versions)\.spec\.ts/,
    },
    {
      // 版の切替が**使える**構成（CICD設計§14）。既定の土台は版の機能ごと塞いで
      // あるので、そちらでは「出ないこと」しか確かめられない。
      //
      // **土台を分けるのは、画面の前提が変わるため**——1つの土台で切り替えると、
      // 版と無関係な全テストが版のカードを抱えて走ることになる（PJTガイドライン）。
      name: 'chromium-versions',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4178' },
      testMatch: /versions\.spec\.ts/,
    },
    {
      // 別の PC のセッションを、実物のブラウザで見る（セルフホスト化設計§7）。
      // **ローカルモードでは画面配信の経路を1バイトも通らない**ので、
      // 「セッションホストが作った画面が xterm.js で再現される」はここでしか確かめられない
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
    command: `rm -f .e2e-state/state/dashboard.db* .e2e-state/state/offsets.json && ${serverBinary} --config e2e/config.toml`,
    env: {
      // 本物の claude ではなく擬似 claude を起動させる
      AGENTDASHBOARD_CLAUDE_BIN: fakeClaude,
      // 版の切替を無害にしておく（CICD設計§4・§6）。**ホストで走るのはここだけ**なので、
      // 塞がないと (1) 開発者の実環境のポインタを読んで別の版が起動し (2) 起こすたびに
      // 実行ファイル3本ぶん（数十MB）を test-results へ控えにいく
      AGENTDASHBOARD_VERSION_HANDED_OVER: '1',
      AGENTDASHBOARD_VERSION_SUPPORTED: '0',
      RUST_LOG: 'info',
    },
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
    },
    {
      // 版の切替が使える構成（CICD設計§14）。設定はローカルと同じものを使い、
      // ぶつかるところだけ環境変数で上書きする（全キーが `AGENTDASHBOARD_<キー>`
      // で上書きできる。設計§14-1）
      command: `rm -rf .e2e-state/versions-state && ${serverBinary} --config e2e/config.toml`,
      env: {
        AGENTDASHBOARD_CLAUDE_BIN: fakeClaude,
        AGENTDASHBOARD_PORT: '4178',
        AGENTDASHBOARD_STATE_DIR: '.e2e-state/versions-state',
        // **利用者のグローバル設定の差し替え先も分ける。** 既定の土台と同じ場所を
        // 指すと、注入と回復が2つのサーバで取り合いになる（モードやモデルの
        // テストが理由の分からない形で落ちる）
        AGENTDASHBOARD_CLAUDE_SETTINGS_PATH:
          '.e2e-state/versions-state/claude-settings.json',
        // **乗り換えだけは塞ぐ。** 画面から選べる状態にはするが、実際に乗り換えると
        // E2E のサーバが別の実行ファイルへ化けてしまう
        AGENTDASHBOARD_VERSION_HANDED_OVER: '1',
        AGENTDASHBOARD_VERSION_SUPPORTED: '1',
        // **初回退避の元を空にする。** 塞がないと、起こすたびに実行ファイル3本ぶん
        // （数十MB）を控えにいく
        AGENTDASHBOARD_VERSION_SOURCE_DIR: '.e2e-state/versions-state/none',
        RUST_LOG: 'info',
      },
      url: 'http://127.0.0.1:4178',
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      // セルフホスト構成（サーバ＋セッションホスト）。**順序を持った起動**なので、
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
      // **終わるときに猶予を渡す。** 既定では process group ごと強制終了されるため、
      // スクリプトの後片付けが走らない。テストが起こし直した PC は**別の group に
      // 居る**（`fleet-control.ts` が切り離して起こす）ので、group を殺しても
      // 生き残り、1回の実行ごとに2つずつ溜まっていく（実際に8つ溜めた）。
      //
      // 溜まったぶんは死んだサーバへ延々と繋ぎ直そうとし続ける。**画面には何も
      // 出ない**ので、`ps` を見るまで気づけない
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
})
