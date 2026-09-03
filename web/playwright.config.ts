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
    // **`on-first-retry` にしてはいけない。** 上の `retries: 0` と噛み合わず、
    // 再試行が一度も起きないので**原理的に1回も採れない**。落ちた回の証拠が
    // 何も残らないまま「trace の設定はしてある」という見た目だけが残る。
    //
    // 再試行を足して解くほうは採らない。落ちるたびに勝手にやり直す土台は、
    // たまたま通る検査を緑のまま抱え込む（ガイドライン「テストが『たまたま
    // 通っている』ことに気づく」）。**採り方のほうを合わせる。**
    //
    // `retain-on-failure` は毎回録って通った回を捨てるので、置き場所は増えない。
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // セルフホスト構成のぶんは別のサーバ（4174）、2台構成のぶんは compose（4175）、
      // PC 3台のぶんはさらに別のサーバ（4177）
      testIgnore: /(remote|account|compose|fleet|revive|versions|handover)\.spec\.ts/,
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
      // **乗り換えを封じない**唯一の土台（`手元の新しい版をGUIだけで効かせる` 設計§9）。
      //
      // 他の土台は `AGENTDASHBOARD_VERSION_HANDED_OVER=1` で乗り換えを塞いでいる。
      // 塞がないと E2E のサーバが別の実行ファイルへ化けてしまうためだが、その結果
      // **「押して本当に切り替わる」経路が一度も通っていなかった**。
      //
      // ここでは行き先を**自分の複製**にしてある（同じ中身・別の時刻）ので、化けても
      // 同じものが同じポートで戻ってくる。
      name: 'chromium-handover',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4179' },
      testMatch: /handover\.spec\.ts/,
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
      // **起こし直し（`revive.spec.ts`）もここへ載せる。** 確かめたい状態は
      // 「PC は居るのに、そのカードだけ接続断」で、**1台構成では作れない**
      // （唯一の PC を落とすと頼む相手が居なくなる）
      name: 'chromium-fleet',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4177' },
      testMatch: /(fleet|revive)\.spec\.ts/,
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
    // **名指しで掃く。全消しにはしない。**
    //
    // `test-results` の下に居たころは Playwright が走る前に丸ごと消していたが、
    // ログを残すためにあそこの外へ出した（ログ設計§19-8）。そのぶん**誰も消さない
    // 置き場所**になったので、持ち越すと困るものをここに並べる。
    //
    // `logs/` は**残す**——「開発中に何が起きたかを翌日読む」がこのログ整備の目的で、
    // 掃除の都合でそれを失っては本末転倒になる（同§20-5）。
    //
    // `claude-settings.json` も消さない。`globalSetup` が webServer より先に書くので、
    // ここで消すと**書いたそばから消す**ことになり、モデルの検査が空振りする。
    command: `rm -rf .e2e-state/state/dashboard.db* .e2e-state/state/offsets.json .e2e-state/state/selfheal.json .e2e-state/state/version-notice.json .e2e-state/state/model-aliases.json .e2e-state/state/version-current .e2e-state/state/versions && ${serverBinary} --config e2e/config.toml`,
    env: {
      // 本物の claude ではなく擬似 claude を起動させる
      AGENTDASHBOARD_CLAUDE_BIN: fakeClaude,
      // 版の切替を無害にしておく（CICD設計§4・§6）。**ホストで走るのはここだけ**なので、
      // 塞がないと (1) 開発者の実環境のポインタを読んで別の版が起動し (2) 起こすたびに
      // 実行ファイル3本ぶん（数十MB）を test-results へ控えにいく
      AGENTDASHBOARD_VERSION_HANDED_OVER: '1',
      AGENTDASHBOARD_VERSION_SUPPORTED: '0',
      // **履歴の走査元を隔離する**（名前付け設計§13-1）。過去のセッションの実在確認は
      // `<ここ>/.claude/projects` を舐めるので、塞がないと**開発者の本物のホーム**を
      // 見にいく——開発機には 1,119 フォルダ・27,499本の `.jsonl` があり、
      // 遅いうえに機械ごとに結果が変わる。テストは自分でここへ置く
      AGENTDASHBOARD_CLAUDE_HOME: '.e2e-state/claude-home',
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
      // **乗り換えを実際に通す土台**（`手元の新しい版をGUIだけで効かせる` 設計§9）。
      //
      // 行き先を**実行ファイル3本の複製**にする。同じ中身なので化けても同じものが
      // 戻ってくるが、**時刻が違う**ので「手元が新しい」と判定される——ソースビルドの
      // 機械で `make build` した直後と同じ形を、実物で作れる。
      //
      // `AGENTDASHBOARD_VERSION_HANDED_OVER` を**立てない**のがこの土台の全部である。
      command:
        `rm -rf .e2e-state/handover-state && mkdir -p .e2e-state/handover-state/bin` +
        ` && cp ${repoRoot}/server/target/debug/agentdashboard ${repoRoot}/server/target/debug/agentdashboard-agent ${repoRoot}/server/target/debug/transcript-parser .e2e-state/handover-state/bin/` +
        ` && touch .e2e-state/handover-state/bin/*` +
        ` && ${serverBinary} --config e2e/config.toml`,
      env: {
        AGENTDASHBOARD_CLAUDE_BIN: fakeClaude,
        AGENTDASHBOARD_PORT: '4179',
        AGENTDASHBOARD_STATE_DIR: '.e2e-state/handover-state',
        AGENTDASHBOARD_CLAUDE_SETTINGS_PATH:
          '.e2e-state/handover-state/claude-settings.json',
        AGENTDASHBOARD_VERSION_SUPPORTED: '1',
        // **行き先は自分の複製。** ここが `installed` の行として並び、押すとここへ乗る
        AGENTDASHBOARD_VERSION_SOURCE_DIR: '.e2e-state/handover-state/bin',
        RUST_LOG: 'info',
      },
      url: 'http://127.0.0.1:4179',
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
