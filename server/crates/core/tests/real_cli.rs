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
    session::{Session, hooks_settings, lifecycle},
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
