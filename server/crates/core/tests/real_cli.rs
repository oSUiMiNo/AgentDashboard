//! 本物の Claude Code を相手にする統合テスト（テスト計画フェーズ4）。
//!
//! 擬似 claude では確かめられない**継ぎ目**を検証する。すなわち「注入した settings を
//! 本物の CLI が本当に読み、期待どおりのタイミングでフックを起動し、期待どおりの
//! フィールドを持った JSON を渡してくるか」。ここが崩れると、ダッシュボードの状態表示は
//! 丸ごと嘘になる。
//!
//! # 実行方法
//!
//! ```text
//! make test-cli
//! ```
//!
//! `#[ignore]` を付けてあるので `make test` では走らない。**本物の claude が起動し、
//! アカウントのクォータを消費する**ため、明示的に叩いたときだけ実行する。cargo は
//! コンテナ、claude と認証情報はホストにあるので、`scripts/test-cli` が
//! 「コンテナでビルド → ホストで実行」に分けている。
//!
//! # 環境に左右されないための2つの工夫
//!
//! - **権限モードを固定する**。利用者のグローバル設定（`permissions.defaultMode`）が
//!   何であっても権限確認が必ず出るよう、`--permission-mode manual` を足す小さな
//!   ラッパースクリプトを CLI として起動する。製品コードには手を入れない
//! - **フォルダ信頼の確認に答える**。使い捨てディレクトリで起動すると TUI が信頼を
//!   尋ねてくるので、出てきたら Enter で確定する

mod common;

use agentdashboard_core::{
    config::Config,
    session::{Session, hooks_settings, input, lifecycle},
};
use protocol::SessionStatus;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use testkit::MockHookServer;
use tokio::time::Instant;

/// 本物の CLI は考える時間があるので、擬似 claude より長く待つ。
const CLI_TIMEOUT: Duration = Duration::from_secs(180);

/// 使い捨ての作業ディレクトリ。テストが終わったら丸ごと消す。
struct WorkDir(PathBuf);

impl WorkDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir()
            .join("agentdashboard-real-cli")
            .join(format!("{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&path).expect("作業ディレクトリを作れること");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn as_str(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 権限確認が必ず出るようにした claude を起動するラッパー。
///
/// 利用者のグローバル設定は `permissions.defaultMode` を持ちうる。テストが環境の設定に
/// 左右されないよう、ここで明示的に `manual` を与える。製品側の起動コマンドには
/// 手を入れずに済ませるための工夫で、`AGENTDASHBOARD_CLAUDE_BIN` と同じ差し替えの
/// 仕組みに乗っている。
fn claude_wrapper(dir: &WorkDir, extra: &[&str]) -> PathBuf {
    let path = dir.path().join("claude-wrapper.sh");
    let args = extra.join(" ");
    std::fs::write(&path, format!("#!/bin/sh\nexec claude {args} \"$@\"\n"))
        .expect("ラッパーを書き出せること");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("実行権限を付けられること");
    }
    path
}

/// 使い捨てディレクトリで出るフォルダ信頼の確認に答える。
///
/// 出ない環境（既に信頼済み）もあるので、少し待って出てこなければそのまま進む。
async fn accept_trust_prompt_if_any(session: &Session, watcher: &mut common::Watcher) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        watcher.drain_quiet_for(Duration::from_millis(500)).await;
        let seen = watcher.seen().to_lowercase();
        if seen.contains("trust") || seen.contains("do you trust") {
            session.write_input(b"\r").expect("端末へ書き込めること");
            // 確定したあと画面が描き直されるので、落ち着くまで待つ
            watcher.drain_quiet_for(Duration::from_secs(2)).await;
            return;
        }
    }
}

/// セッションが目的の状態になるまで、本物の CLI 向けの長さで待つ。
async fn wait_for_status(session: &Session, expected: SessionStatus) {
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        let status = session.status();
        if status == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に {expected:?} になりませんでした。実際: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// CLI 側のセッションIDが確定するまで待つ。
async fn wait_for_session_id(session: &Session) -> protocol::ClaudeSessionId {
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        if let Some(id) = session.meta().claude_session_id {
            return id;
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に CLI 側のセッションIDが届きませんでした"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

// ---------------------------------------------------------------------------
// 1. ヘッドレス起動でのフック受信と payload の必須フィールド
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn ヘッドレスで起動するとフックが届き必須フィールドが揃う() {
    let dir = WorkDir::new("headless");
    let mock = MockHookServer::start()
        .await
        .expect("受信サーバを起動できること");

    // ダッシュボードが生成するのと同じ形の settings を、受信先だけモックへ向けて書き出す
    let token = hooks_settings::new_token();
    let settings_path = dir.path().join("settings.json");
    let settings = hooks_settings::build_settings(
        &testkit::binary_path("agentdashboard"),
        mock.addr().port(),
        &token,
    );
    std::fs::write(
        &settings_path,
        serde_json::to_vec_pretty(&settings).unwrap(),
    )
    .expect("settings を書き出せること");

    let session_id = protocol::ClaudeSessionId::new();
    let status = tokio::task::spawn_blocking({
        let settings_path = settings_path.clone();
        let cwd = dir.path().to_path_buf();
        move || {
            let mut command = Command::new("claude");
            command
                .arg("--print")
                // 指示は必ずオプションより前に置く。`--allowedTools` は値を複数取れる
                // オプションなので、後ろに置くと指示までツール名として飲み込まれる
                .arg("Bash ツールで `echo agentdashboard` を1度だけ実行し、その出力をそのまま答えて。")
                .arg("--session-id")
                .arg(session_id.to_string())
                .arg("--settings")
                .arg(&settings_path)
                .arg("--allowedTools")
                .arg("Bash")
                .current_dir(&cwd)
                .env_clear();
            for (name, value) in lifecycle::sanitized_env() {
                command.env(name, value);
            }
            command.status().expect("claude を起動できること")
        }
    })
    .await
    .expect("実行できること");
    assert!(status.success(), "claude が異常終了しました: {status}");

    // 非同期フックなので、CLI の終了直後にまだ届いていないことがある
    tokio::time::sleep(Duration::from_secs(2)).await;

    let received = mock.received();
    let events: Vec<&str> = received.iter().map(|hook| hook.event.as_str()).collect();
    // 実際に発火した種別を記録しておく。設計§5 が挙げる9種のうちどれが本当に来るのかは、
    // ここでしか確かめられない（--nocapture で実行するので出力が残る）
    println!("実際に発火したフック: {events:?}");

    for expected in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
    ] {
        assert!(
            events.contains(&expected),
            "{expected} が届いていません。実際: {events:?}"
        );
    }

    // 合言葉は全件で一致していること（受信口の照合が意味を持つ前提）
    assert!(received.iter().all(|hook| hook.token == token));

    // 状態機械が必要とするフィールドが揃っていること
    for hook in &received {
        let payload = &hook.payload;
        assert_eq!(
            payload["session_id"].as_str(),
            Some(session_id.to_string().as_str()),
            "{} の session_id が自己採番の値と一致しない: {payload}",
            hook.event
        );
        assert!(
            payload["transcript_path"].as_str().is_some(),
            "{} に transcript_path がない: {payload}",
            hook.event
        );
        assert_eq!(
            payload["hook_event_name"].as_str(),
            Some(hook.event.as_str()),
            "{} の hook_event_name が一致しない: {payload}",
            hook.event
        );
    }

    let tool_call = received
        .iter()
        .find(|hook| hook.event == "PreToolUse")
        .expect("PreToolUse があること");
    assert!(
        tool_call.payload["tool_name"].as_str().is_some(),
        "PreToolUse に tool_name がない: {}",
        tool_call.payload
    );

    let stop = received
        .iter()
        .find(|hook| hook.event == "Stop")
        .expect("Stop があること");
    assert!(
        stop.payload["last_assistant_message"].as_str().is_some(),
        "Stop に last_assistant_message がない（小窓の要約表示が成立しない）: {}",
        stop.payload
    );

    mock.shutdown().await;
}

// ---------------------------------------------------------------------------
// 2. 対話モードでの権限確認 → 許可 → 復帰
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 権限確認待ちを検知しターミナルで許可すると作業中へ戻る() {
    let dir = WorkDir::new("permission");
    // 利用者のグローバル設定に関わらず必ず確認が出るようにする
    let program = claude_wrapper(&dir, &["--permission-mode", "manual"]);
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;

    let session = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);

    accept_trust_prompt_if_any(&session, &mut watcher).await;
    wait_for_status(&session, SessionStatus::WaitingInput).await;

    // ツールの実行を伴う指示を出す。単一行なので CR で送る（設計§6）
    session
        .write_input("Bash ツールで `echo agentdashboard` を実行して\r".as_bytes())
        .expect("端末へ書き込めること");

    wait_for_status(&session, SessionStatus::WaitingPermission).await;

    // ターミナル側で許可する。許可されたことを伝えるフックは無いので、
    // 次のツール実行（PreToolUse/PostToolUse）で復帰するのが唯一の経路（設計§5）
    watcher.drain_quiet_for(Duration::from_secs(1)).await;
    session.write_input(b"\r").expect("端末へ書き込めること");

    wait_for_status(&session, SessionStatus::Working).await;

    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

// ---------------------------------------------------------------------------
// 3. JSONL の遅れに耐えること
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn トランスクリプト未作成でもフックだけで状態表示が成立する() {
    let dir = WorkDir::new("jsonl-delay");
    let program = claude_wrapper(&dir, &[]);
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;

    let session = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);

    // 起動直後は JSONL の場所すら分かっていない。ここで「ファイルが無い＝異常」と
    // 扱うと、正常な起動を毎回エラーにしてしまう（実機検証で確認済みの挙動）
    assert!(session.transcript_path().is_none());
    assert_eq!(session.status(), SessionStatus::Starting);

    accept_trust_prompt_if_any(&session, &mut watcher).await;

    // フックが届けば、JSONL の有無に関わらず状態は確定する
    wait_for_status(&session, SessionStatus::WaitingInput).await;
    let path = session
        .transcript_path()
        .expect("SessionStart フックが JSONL の場所を運んでくること");
    println!(
        "transcript_path={path} （この時点での存在: {}）",
        Path::new(&path).exists()
    );

    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

// ---------------------------------------------------------------------------
// 4. resume でも CardId は変わらない
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 引き継ぎ起動でもカードのidは変わらずcli側のidが張り替わる() {
    let dir = WorkDir::new("resume");
    let program = claude_wrapper(&dir, &[]);
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;

    // まず1本ふつうに起動して、引き継ぎ元のセッションを作る
    let first = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&first);
    accept_trust_prompt_if_any(&first, &mut watcher).await;
    wait_for_status(&first, SessionStatus::WaitingInput).await;
    let original = wait_for_session_id(&first).await;
    server
        .manager
        .archive(first.card_id)
        .expect("片付けられること");

    // 引き継いで起動する。CLI 側のIDはこちらでは決められないので、カードは
    // 「まだ分からない」状態から始まる
    let resumed = server
        .manager
        .resume(&dir.as_str(), original)
        .expect("引き継いで起動できること");
    let card_id = resumed.card_id;
    assert!(
        resumed.meta().claude_session_id.is_none(),
        "引き継ぎでは自己採番しない"
    );

    let mut watcher = common::Watcher::attach(&resumed);
    accept_trust_prompt_if_any(&resumed, &mut watcher).await;

    let restored = wait_for_session_id(&resumed).await;
    println!("引き継ぎ元={original} 引き継ぎ後={restored}");
    assert_eq!(resumed.card_id, card_id, "CardId は生涯不変であること");
    assert!(
        resumed.transcript_path().is_some(),
        "transcript_path も張り替わること"
    );

    server
        .manager
        .archive(resumed.card_id)
        .expect("片付けられること");
}

// ---------------------------------------------------------------------------
// 5. 終了の検知（2つの経路）
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 終了はフック経路とプロセス終了経路の両方で検知できる() {
    let dir = WorkDir::new("exit");
    let program = claude_wrapper(&dir, &[]);
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;

    // (a) CLI 自身が終了する経路。SessionEnd フックが届くので「終了」と分かる
    let by_command = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&by_command);
    accept_trust_prompt_if_any(&by_command, &mut watcher).await;
    wait_for_status(&by_command, SessionStatus::WaitingInput).await;

    by_command
        .write_input(b"/exit\r")
        .expect("端末へ書き込めること");
    wait_for_status(&by_command, SessionStatus::Ended { ok: true }).await;

    // (b) ダッシュボードから終了させる経路。強制終了なので終了コードは非ゼロだが、
    // 利用者が自分で終わらせたものを「異常終了」と出してはいけない
    let by_dashboard = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&by_dashboard);
    accept_trust_prompt_if_any(&by_dashboard, &mut watcher).await;

    by_dashboard.kill();
    wait_for_status(&by_dashboard, SessionStatus::Ended { ok: true }).await;

    for card in [by_command.card_id, by_dashboard.card_id] {
        server.manager.archive(card).expect("片付けられること");
    }
}

// ---------------------------------------------------------------------------
// 6. Composer からの指示送信（単一行 / 複数行 / スラッシュコマンド）
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 指示送信は複数行もスラッシュコマンドも本物のtuiへ正しく届く() {
    // テスト計画フェーズ4「指示送信」。擬似 claude は TUI ではないので、bracketed paste が
    // 本当に「1つの指示」として解釈されるかは本物でしか確かめられない。包まずに送ると
    // 1行目だけが送信され、残りが次の指示として順に実行される。
    let dir = WorkDir::new("send-input");
    let state_dir = dir.path().join("state");
    let config = Config {
        state_dir: Some(state_dir),
        ..Config::default()
    };
    // 利用者のグローバル設定のフックを外す。入れたままだと、そちらが起動するスキルの
    // 権限確認がこちらの送った文字を吸ってしまう（PJTガイドライン）
    let wrapper = claude_wrapper(&dir, &["--setting-sources", "project,local"]);
    let server = common::TestServer::start_with_parser_and_program(
        config,
        wrapper.to_string_lossy().into_owned(),
    )
    .await;

    let session = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    accept_trust_prompt_if_any(&session, &mut watcher).await;
    wait_for_status(&session, SessionStatus::WaitingInput).await;

    // --- 複数行（bracketed paste で包む経路）--------------------------------
    const FIRST: &str = "アルファ";
    const SECOND: &str = "ブラボー";
    session
        .write_input(&input::encode_input(&format!(
            "次の2語をそのまま順に書き出すだけで答えて。説明は不要。\n{FIRST}\n{SECOND}"
        )))
        .expect("端末へ書き込めること");

    // 履歴に載った「ユーザの発言」が1件で、両方の語を含んでいれば、
    // 2行が1つの指示として届いたことになる
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut prompt = None;
    while Instant::now() < deadline {
        let nodes = session.transcript_snapshot();
        if let Some(text) = nodes.iter().find_map(|node| match &node.node {
            protocol::Node::UserMessage { text } if text.contains(FIRST) => Some(text.clone()),
            _ => None,
        }) {
            prompt = Some(text);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let prompt = prompt.expect("ユーザの発言が構造化ビューに現れること");
    println!("届いた指示: {prompt:?}");
    assert!(
        prompt.contains(SECOND),
        "2行目が同じ指示に含まれていません（bracketed paste で包めていない）: {prompt:?}"
    );

    // --- 単一行のスラッシュコマンド（CR で確定する経路）---------------------
    // `/exit` を選んだのは、成否が状態としてはっきり出るから（追加の課金も無い）
    wait_for_status(&session, SessionStatus::WaitingInput).await;
    session
        .write_input(&input::encode_input("/exit"))
        .expect("端末へ書き込めること");
    wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn サブエージェントの稼働と子ツリーのマウントを検知できる() {
    // テスト計画フェーズ4「サブエージェント」。バッジのカウンタ（フック由来）と
    // 構造化ビューのマウント（JSONL 由来）は別系統なので、両方を1本で通して確かめる。
    let dir = WorkDir::new("subagent");
    let state_dir = dir.path().join("state");
    let config = Config {
        state_dir: Some(state_dir),
        ..Config::default()
    };
    // 権限確認で止まらないよう、編集を許すモードで起動する
    let wrapper = claude_wrapper(&dir, &["--permission-mode", "acceptEdits"]);
    let server = common::TestServer::start_with_parser_and_program(
        config,
        wrapper.to_string_lossy().into_owned(),
    )
    .await;

    std::fs::write(
        dir.path().join("notes.md"),
        "# メモ\n- [ ] TODO: 集計処理のテストを書く\n",
    )
    .expect("題材を置けること");

    let session = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    accept_trust_prompt_if_any(&session, &mut watcher).await;

    // サブエージェントを1つ起動させる
    common::send_line(
        &session,
        "サブエージェントを1つ起動して、このディレクトリの notes.md の中身を報告させてください。",
    );

    // バッジのカウンタはフック（SubagentStart / SubagentStop）由来
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut saw_subagent = false;
    while Instant::now() < deadline {
        if session.meta().subagent_active > 0 {
            saw_subagent = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        saw_subagent,
        "SubagentStart を受け取らず、稼働中のバッジが立ちませんでした"
    );

    // 子ツリーのマウントは JSONL 由来。パーサが subagents/ を見つけて繋ぐ
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut mounted = None;
    while Instant::now() < deadline {
        let nodes = session.transcript_snapshot();
        if let Some(node) = nodes
            .iter()
            .find(|node| matches!(node.node, protocol::Node::Subagent { .. }))
        {
            mounted = Some(node.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let mounted = mounted.expect("サブエージェントのノードが構造化ビューに現れること");

    // 親のツールコールにぶら下がっていること（＝掘っていける形になっていること）
    let parent = mounted.parent.expect("マウント先がある");
    let nodes = session.transcript_snapshot();
    let parent_node = nodes
        .iter()
        .find(|node| node.id == parent)
        .expect("親も届いている");
    assert!(
        matches!(parent_node.node, protocol::Node::ToolCall { .. }),
        "サブエージェントの親がツールコールではありません: {:?}",
        parent_node.node
    );

    session.kill();
    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

// ---------------------------------------------------------------------------
// 8. 自己修復を本物の claude で通す（テスト計画フェーズ7「修復フロー」）
// ---------------------------------------------------------------------------

/// リポジトリのルート（`scripts/cargo` を持つ場所）を、テストバイナリの位置から辿る。
fn repo_root() -> PathBuf {
    let binary = testkit::binary_path("agentdashboard");
    binary
        .ancestors()
        .find(|dir| dir.join("scripts").join("cargo").is_file())
        .map(Path::to_path_buf)
        .expect("リポジトリのルートが見つかること")
}

/// カナリアだけを「わざと非互換なサンプル」に差し替えた本物の口。
///
/// 実物のフォーマット変更を待つわけにいかないので、**新しい形式を模したフィクスチャ**を
/// worktree へ置く。ここから先——ゲート・修復セッション・ビルド・差し替え・コミット——は
/// すべて本物を通す。
struct PlantedCanary {
    inner: agentdashboard_core::selfheal::ops::HostOps,
}

impl agentdashboard_core::selfheal::ops::SelfhealOps for PlantedCanary {
    fn prepare_worktree(&self, branch: &str) -> anyhow::Result<PathBuf> {
        self.inner.prepare_worktree(branch)
    }

    fn run_canary(
        &self,
        _model: &str,
        worktree: &Path,
    ) -> anyhow::Result<agentdashboard_core::selfheal::ops::CanarySample> {
        // 「レコード種別が改名された」という、実際に起こりうる形の非互換。
        // いまのパーサはこれを未知の種別として数えるので、ゲートが落ちる
        let dir = worktree.join("fixtures").join("v9.9.9").join("canary");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(
            dir.join("session.jsonl"),
            concat!(
                r#"{"type":"user-message","uuid":"c1","parentUuid":null,"timestamp":"2026-07-29T00:00:00.000Z","version":"9.9.9","message":{"role":"user","content":"新しい形式のテスト"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"c2","parentUuid":"c1","timestamp":"2026-07-29T00:00:01.000Z","version":"9.9.9","message":{"role":"assistant","content":[{"type":"text","text":"了解しました"}]}}"#,
                "\n",
            ),
        )?;
        Ok(agentdashboard_core::selfheal::ops::CanarySample {
            version: "9.9.9".to_string(),
            dir,
            has_tool_use: true,
            has_subagent: true,
        })
    }

    fn run_gate(&self, worktree: &Path) -> agentdashboard_core::selfheal::ops::GateOutcome {
        self.inner.run_gate(worktree)
    }

    fn build_parser(&self, worktree: &Path) -> anyhow::Result<PathBuf> {
        self.inner.build_parser(worktree)
    }

    fn changed_files(&self, worktree: &Path) -> anyhow::Result<Vec<String>> {
        self.inner.changed_files(worktree)
    }

    fn commit(&self, worktree: &Path, message: &str) -> anyhow::Result<()> {
        self.inner.commit(worktree, message)
    }
}

/// 前回の訓練が残した worktree とブランチを片付ける。
///
/// 本番では前回の修復を積み上げるのが正しい（直した内容を捨てない）が、訓練は毎回
/// **同じ出発点**から始まらないと結果が変わってしまう。
fn reset_maintenance_worktree(repo: &Path) {
    let name = agentdashboard_core::selfheal::MAINTENANCE_NAME;
    let worktree = repo
        .join(agentdashboard_core::selfheal::ops::WORKTREE_DIR)
        .join(name);
    let _ = Command::new("git")
        .args(["worktree", "remove", "--force"])
        .arg(&worktree)
        .current_dir(repo)
        .status();
    let _ = std::fs::remove_dir_all(&worktree);
    let _ = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(repo)
        .status();
    let _ = Command::new("git")
        .args(["branch", "-D", name])
        .current_dir(repo)
        .status();
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 本物のclaudeがパーサを直しゲートを通ってから差し替わる() {
    // テスト計画フェーズ7「修復フロー」を実物で通す。擬似 claude の訓練
    // （tests/selfheal.rs）が確かめるのは順序と受け渡しで、**本当に直せるのか**は
    // ここでしか分からない。課題は「新しい形式に対応しつつ、過去のフィクスチャを
    // 1つも壊さない」という、実際のフォーマット変更と同じ形にしてある。
    let repo = repo_root();
    reset_maintenance_worktree(&repo);

    let dir = WorkDir::new("selfheal");
    let config = Config {
        state_dir: Some(dir.path().join("state")),
        selfheal_repo_dir: Some(repo.clone()),
        // 2回にしてあるのは、**1回目で落ちているフィクスチャを消しにいく**ことが
        // 実際にあるため（それでは対応したことにならないので突き返す）。
        // 突き返したあとにやり直せるだけの余地を残す
        selfheal_retry: 2,
        ..Config::default()
    };
    let ops = std::sync::Arc::new(PlantedCanary {
        inner: agentdashboard_core::selfheal::ops::HostOps::new(repo.clone(), "claude".to_string()),
    });
    let server =
        common::TestServer::start_with_selfheal_and_program(config, ops, "claude".to_string())
            .await;

    // 検知させるための見張り対象。指示は送らないので、ここでは考えさせない
    let watched = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&watched);
    accept_trust_prompt_if_any(&watched, &mut watcher).await;

    let transcript = dir.path().join("session.jsonl");
    let payload = serde_json::json!({
        "session_id": "11111111-2222-3333-4444-555555555555",
        "transcript_path": transcript.to_string_lossy(),
        "hook_event_name": "SessionStart",
    });
    let status = server
        .post_hook(watched.token(), "SessionStart", &payload.to_string())
        .await;
    assert_eq!(status, 204);

    // 知らない版を初めて見た、という状況を作る
    std::fs::write(
        &transcript,
        concat!(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-07-29T00:00:00.000Z","version":"9.9.9","message":{"role":"user","content":"こんにちは"}}"#,
            "\n",
        ),
    )
    .expect("トランスクリプトを書けること");

    // 本物のビルドと本物のセッションが動くので、待ちは分単位で見る
    let deadline = Instant::now() + Duration::from_secs(45 * 60);
    let pointer = dir
        .path()
        .join("state")
        .join(agentdashboard_core::parser::PARSER_POINTER);
    let original = std::fs::read_to_string(&pointer).expect("最初のポインタが書かれている");
    let worktree = repo
        .join(agentdashboard_core::selfheal::ops::WORKTREE_DIR)
        .join(agentdashboard_core::selfheal::MAINTENANCE_NAME);

    loop {
        let now = std::fs::read_to_string(&pointer).unwrap_or_default();
        if !now.is_empty() && now != original {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "45分以内にパーサが差し替わりませんでした。worktree: {}",
            worktree.display()
        );
        tokio::time::sleep(Duration::from_secs(5)).await;
    }

    // 対応表に載っている
    let state =
        agentdashboard_core::selfheal::state::SelfhealState::load(&dir.path().join("state"));
    assert!(
        state.known_versions.contains("9.9.9"),
        "差し替えたのに対応表へ載っていない"
    );

    // 直した結果が worktree にコミットされている（プッシュはしない）
    let log = Command::new("git")
        .args(["log", "--oneline", "-1"])
        .current_dir(&worktree)
        .output()
        .expect("git log を実行できること");
    let log = String::from_utf8_lossy(&log.stdout);
    assert!(
        log.contains("transcript-parser"),
        "修復のコミットが見当たらない: {log}"
    );

    watched.kill();
    server
        .manager
        .archive(watched.meta().card_id)
        .expect("片付けられること");
}
