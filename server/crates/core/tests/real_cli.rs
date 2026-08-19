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

// テスト名は日本語で書く。`statusLine` のように英大文字が混ざると snake_case 判定に
// 引っかかるだけで実害はないため、このファイルに限って許可する
// （`selfheal.rs` / `transcript.rs` / `model.rs` と同じ扱い）
#![allow(non_snake_case)]

mod common;

use agentdashboard_core::client;
use agentdashboard_core::config::Config;
use protocol::SessionStatus;
use session_host_core::session::{Session, hooks_settings, lifecycle};
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
        // **落ちたときは消さない。** ここには段1 で入れたログ（`<state_dir>/logs/*.jsonl`）が
        // 入っており、丸ごと消すと「なぜ落ちたか」を書いた材料ごと失う。実際、実CLI が6本
        // 落ちた回はここで全部消えていて、原因が1つも辿れなかった。
        //
        // `FakeHome`（`dist/tests/common/mod.rs`）は場所を出してから消すが、こちらは
        // **中身を読みに行く**ので残すところまでやる。実CLI は `#[ignore]` で明示的にしか
        // 走らないので、落ちたときだけ /tmp に残るのは許容できる。
        if std::thread::panicking() {
            eprintln!(
                "落ちたので作業ディレクトリを残します（調べるならここ）: {}",
                self.0.display()
            );
            return;
        }
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
    claude_wrapper_at(dir.path(), extra)
}

/// 置き場所を直に指す版。**乗り換えのテストは作業場所が実行ファイルの隣**
/// （ハードリンクが張れる場所）なので、`WorkDir` を取れない。
fn claude_wrapper_at(dir: &Path, extra: &[&str]) -> PathBuf {
    let path = dir.join("claude-wrapper.sh");
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
        // ここで見たいのはフックが届くことだけ。statusLine とモデルの注入は別のテスト
        &hooks_settings::ModelInjection::default(),
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
// 2-2. CLI の端末系（テスト計画フェーズ5。CLI設計§9）
//
// 擬似 claude は選択ダイアログを出さないので、**キー送出と画面読み取りが本物の TUI と
// 噛み合うこと**はここでしか確かめられない。操作はすべて CLI のクライアント層
// （`client::…`）を通す——コマンドの実体と同じ経路。
// ---------------------------------------------------------------------------

/// CLI の一覧（記録層）でカードが目的の形になるまで待つ。
///
/// 端末系のテストは**CLI から見える形**だけで判定する——セッションの実体
/// （`session.status()`）で見ると、CLI が本当に同じものを見られるかの検証にならない。
async fn wait_via_cli(
    target: &client::Target,
    card: &str,
    what: &str,
    matches: impl Fn(&protocol::SessionMeta) -> bool,
) -> protocol::SessionMeta {
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        let (list, _) = client::sessions(target).await.expect("一覧を引けること");
        if let Some(meta) = list
            .iter()
            .find(|meta| meta.card_id.to_string() == card)
            .filter(|meta| matches(meta))
        {
            return meta.clone();
        }
        if Instant::now() >= deadline {
            // 何が映っていたかを残す——「ならなかった」だけでは、指示が届かなかったのか
            // 答えが違ったのかを後から切り分けられない（実際に切り分けに困った）
            let screen = cli_screen_text(target, &card[..8]).await;
            panic!("{CLI_TIMEOUT:?} 以内に {what} になりませんでした。実際の画面:\n{screen}");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// `session screen` 相当でいまの画面をテキストにする。
async fn cli_screen_text(target: &client::Target, prefix: &str) -> String {
    let shot = client::screen(target, prefix, 120, 40)
        .await
        .expect("画面を受け取れること");
    client::render::render_screen(&shot.payload, shot.rows, shot.cols)
}

/// 指示を送る前に、**画面が落ち着く**（描き直しが止まり、入力欄が出ている）まで待つ。
///
/// `SessionStart` は TUI が貼り付けを受け付けられるようになる**前に**飛ぶ（初期実装§17 の
/// 実測）。状態が入力待ちになった直後に送ると、描画中の TUI が貼り付けの合図をただの
/// 文字として解釈し、**指示が届かないまま静かに終わる**——通しの実行で実際に踏んだ
/// （トランスクリプトが1行も作られていなかった）。同§17 の処方（出力が増えなくなるまで
/// 待つ）の画面版として、同じ画面が2回続くまで待つ。
async fn wait_screen_settled(target: &client::Target, prefix: &str) -> String {
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut previous = String::new();
    loop {
        let text = cli_screen_text(target, prefix).await;
        if !previous.is_empty() && text == previous && text.contains("❯") {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に画面が落ち着きませんでした: {text}"
        );
        previous = text;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn CLIの画面とキーで信頼確認に答え長い単一行がターンを終える() {
    let dir = WorkDir::new("cli-screen-key");
    // モデルは haiku 固定でクォータを抑える。利用者のグローバル設定は外す——
    // フックやスキルが割り込むと、画面の判定とキーの宛先が狂う（PJTガイドライン）
    let program = claude_wrapper(
        &dir,
        &["--model", "haiku", "--setting-sources", "project,local"],
    );
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;
    let target =
        client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を読めること");

    // 起こすのも CLI の経路で（フルのカードIDが返る）
    let spawned = client::spawn(&target, &dir.as_str(), None, None)
        .await
        .expect("CLI から起こせること");
    let card = spawned.human.clone();
    let prefix = &card[..8];

    // テF5-1：信頼の確認が `session screen` で読める（新しいフォルダなので出る。
    // 既に信頼済みの環境では出ないことがあるので、その場合は先へ進む）
    // **照合はダイアログの文言（"do you trust"）で行う。** 裸の "trust" では、起動後の
    // welcome 画面の What's new（"added a workspace trust prompt …"）にも一致してしまい、
    // 分岐が永久に welcome へ届かない（1回目の実行で実際に踏んだ）
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut trust_seen = false;
    loop {
        let text = cli_screen_text(&target, prefix).await.to_lowercase();
        if text.contains("do you trust") {
            trust_seen = true;
            break;
        }
        if text.contains("welcome back") || text.contains("❯") {
            break; // 信頼確認を出さない環境
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に信頼確認も起動後の画面も読めませんでした: {text}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if trust_seen {
        // テF5-2：`session key` で答える。**素直な down→enter は2つ目の選択肢
        // （No, exit）を選んで claude ごと終わる**ので、矢印を往復してから既定へ
        // 戻して確定する——矢印が効くことと確定が効くことの両方を見る形（設計§17）
        client::send_keys(
            &target,
            prefix,
            &["down".to_string(), "up".to_string(), "enter".to_string()],
        )
        .await
        .expect("キーを送れること");

        // テF5-3：答えたあと画面が進む（信頼確認が消える）
        let deadline = Instant::now() + CLI_TIMEOUT;
        loop {
            let text = cli_screen_text(&target, prefix).await.to_lowercase();
            if !text.contains("do you trust") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{CLI_TIMEOUT:?} 以内に信頼確認が消えませんでした: {text}"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    // 起動が完了して入力待ちになる（SessionStart は信頼に答えるまで飛ばない）
    wait_via_cli(&target, &card, "入力待ち", |meta| {
        meta.status == SessionStatus::WaitingInput
    })
    .await;
    // 状態が変わった直後は TUI がまだ描いている。落ち着くまで待ってから送る（§17 の競合）
    wait_screen_settled(&target, prefix).await;

    // テF5-4・5：境目（57〜64バイト）より長い単一行（日本語20文字超）が届き、
    // `--wait` が本物のターンの終わり（Stop フック）で返る（初期実装§18 破綻1 の回帰）
    let instruction = "1 たす 1 の答えを数字だけで教えてください。説明は要りません。";
    assert!(
        instruction.len() > 64,
        "境目より長いこと: {}",
        instruction.len()
    );
    let outcome = client::send_input(&target, prefix, instruction, true, 180)
        .await
        .expect("ターンの終わりまで待てること");
    assert!(
        outcome.human.contains("入力待ち"),
        "ターンが終わって返ること: {}",
        outcome.human
    );

    // 片付けも CLI の経路で
    client::kill(&target, prefix).await.expect("終了できること");
    client::archive(&target, prefix).await.expect("外せること");
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn CLIのキーで権限確認に答えモデル切替が一覧へ映る() {
    let dir = WorkDir::new("cli-permission-model");
    // 確認が必ず出るようにし、モデル切替が利用者の実物の設定へ書き戻さないよう
    // 影のファイルを指す（モデル切替はグローバル既定の回復で settings.json を触る）
    let shadow = dir.path().join("shadow-claude-settings.json");
    std::fs::write(&shadow, "{}").expect("影の設定を書けること");
    let program = claude_wrapper(
        &dir,
        &[
            "--model",
            "haiku",
            "--permission-mode",
            "manual",
            "--setting-sources",
            "project,local",
        ],
    );
    let config = Config {
        claude_settings_path: Some(shadow),
        ..Config::default()
    };
    let server =
        common::TestServer::start_with_program(config, program.to_string_lossy().into_owned())
            .await;
    let target =
        client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を読めること");

    let spawned = client::spawn(&target, &dir.as_str(), None, None)
        .await
        .expect("CLI から起こせること");
    let card = spawned.human.clone();
    let prefix = &card[..8];

    // 信頼確認（出れば）に CLI のキーで答える。照合はダイアログの文言で行う——
    // 裸の "trust" は welcome 画面の What's new にも一致する（テストAの注記と同じ罠）
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        let text = cli_screen_text(&target, prefix).await.to_lowercase();
        if text.contains("do you trust") {
            client::send_keys(&target, prefix, &["enter".to_string()])
                .await
                .expect("キーを送れること");
        } else if text.contains("welcome back") || text.contains("❯") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に起動の画面になりませんでした: {text}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    wait_via_cli(&target, &card, "入力待ち", |meta| {
        meta.status == SessionStatus::WaitingInput
    })
    .await;
    // 状態が変わった直後は TUI がまだ描いている。落ち着くまで待ってから送る（§17 の競合。
    // 通しの実行で1回、送った指示が届かないままトランスクリプトが空という形で実際に踏んだ）
    wait_screen_settled(&target, prefix).await;

    // テF5-7：ツールの実行を伴う指示 → 権限確認待ち → 画面で確認を読み、
    // `session key` の enter で許可 → 作業中へ戻る。
    // **副作用のある操作を頼む**（リモート版と同じ指示）——`echo` のような読み取り専用に
    // 見えるものは、版によっては確認なしで通ってしまい、確かめたい経路を1度も踏まない
    // （echo で実際に踏んだ。ガイドライン§22-3 と同じ罠）
    client::send_input(
        &target,
        prefix,
        "report.txt というファイルを作って、中身は ok の1行にして。",
        false,
        5,
    )
    .await
    .expect("指示を送れること");
    wait_via_cli(&target, &card, "権限確認待ち", |meta| {
        meta.status == SessionStatus::WaitingPermission
    })
    .await;

    let text = cli_screen_text(&target, prefix).await;
    assert!(
        text.contains("report.txt"),
        "何を聞かれているかが画面から読めること: {text}"
    );

    client::send_keys(&target, prefix, &["enter".to_string()])
        .await
        .expect("許可を送れること");
    wait_via_cli(&target, &card, "作業中", |meta| {
        meta.status == SessionStatus::Working
    })
    .await;
    // ターンの終わりまで待ってから次へ（切替の確認画面と混ざらないように）
    wait_via_cli(&target, &card, "入力待ちへ戻る", |meta| {
        meta.status == SessionStatus::WaitingInput
    })
    .await;
    wait_screen_settled(&target, prefix).await;

    // テF5-6：`session model` で切り替えたモデルが `session ls` の表示に反映される
    client::set_model(&target, prefix, "sonnet")
        .await
        .expect("切り替えられること");
    wait_via_cli(&target, &card, "モデルの表示が変わる", |meta| {
        meta.model_label
            .as_deref()
            .is_some_and(|label| label.to_lowercase().contains("sonnet"))
            || meta
                .model
                .as_ref()
                .is_some_and(|model| model.to_string().contains("sonnet"))
    })
    .await;

    client::kill(&target, prefix).await.expect("終了できること");
    client::archive(&target, prefix).await.expect("外せること");
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

/// 会話の入れ替えと本当の終了を、**1セッションで**実物から採る（設計§11 の前提3件）。
///
/// 擬似 claude では「`SessionEnd` が来たらこう振る舞う」までしか固定できない。
/// **本物の CLI が本当に `SessionEnd` を出すのか**、出すなら `reason` に何を入れるのか、
/// そして本当の終了のあとに他のフックが来ないのかは、ここでしか言えない。
///
/// クォータを使うので**起こすのは1本**。`/clear` で会話を入れ替えてから `/exit` で終わらせ、
/// 途中のログを読む。
#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 会話の入れ替えでは終わらず_プロセスの終了で終わる() {
    let dir = WorkDir::new("end-report");
    // **利用者のグローバル設定を持ち込まない**（ガイドラインの原則）。持ち込むと、
    // セッション開始で発火する自動スキルの許可ダイアログがターンを塞ぐ
    let program = claude_wrapper(&dir, &["--setting-sources", "project,local"]);
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();

    let session = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    accept_trust_prompt_if_any(&session, &mut watcher).await;
    wait_for_status(&session, SessionStatus::WaitingInput).await;

    // ── 会話の入れ替え。**カードが終了扱いになってはいけない**（要件の症状そのもの）
    session
        .write_input(b"/clear\r")
        .expect("端末へ書き込めること");

    let 申告 = 申告を待つ(sink, mark, session.card_id, 0).await;
    match &申告 {
        Some((line, _)) => {
            eprintln!(
                "【実測】/clear の SessionEnd: reason={:?}",
                line["reason"].as_str()
            );
            assert!(
                !matches!(session.status(), SessionStatus::Ended { .. }),
                "会話の入れ替えで終了扱いになった: {:?}",
                session.status()
            );
        }
        // **落とさない。** 出ないならそれが実測で、記録すべき事実になる
        None => eprintln!("【実測】/clear では SessionEnd が飛ばなかった"),
    }

    // ── 本当の終了。ここで初めて確定する
    let 申告の数 = 申告の行(sink, mark, session.card_id).len();
    session
        .write_input(b"/exit\r")
        .expect("端末へ書き込めること");

    // 前提3：終わりの申告が `reason` つきで残ること
    let (最後の申告, 申告を見た時刻) = 申告を待つ(sink, mark, session.card_id, 申告の数)
        .await
        .expect("本当の終了の申告が残っていること");
    eprintln!(
        "【実測】/exit の SessionEnd: reason={:?}",
        最後の申告["reason"].as_str()
    );

    wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    // 前提2：申告から確定までの時間差。**猶予（既定120秒）より十分短いこと**。
    // 測っているのは**観測の間隔**なので、巡回の刻み（200ms）ぶんは粗い
    let 経過 = 申告を見た時刻.elapsed().as_millis();
    eprintln!("【実測】申告から確定まで: {経過} ms（観測の刻みは 200ms）");
    assert!(
        経過 < 120_000,
        "申告から確定まで猶予を超えている: {経過} ms"
    );

    // 前提1：本当の終了のあと、申告を取り消すフックが1件も来ないこと。
    // **来ていれば `フックが届いたので` の行が出ており、`hook` 欄にイベント名が載る**
    let 最後の申告のあと = sink
        .matching(mark, "card_id", &session.card_id.to_string())
        .into_iter()
        .skip_while(|line| line["ts"] != 最後の申告["ts"])
        .filter(|line| {
            line["msg"]
                .as_str()
                .is_some_and(|msg| msg.contains("フックが届いたので"))
        })
        .collect::<Vec<_>>();
    assert!(
        最後の申告のあと.is_empty(),
        "本当の終了のあとにフックが届いている（申告が取り消される）: {最後の申告のあと:#?}"
    );

    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

/// 「終了を名乗った」行だけを取り出す。
fn 申告の行(
    sink: &session_host_core::logging::capture::Sink,
    mark: usize,
    card_id: protocol::CardId,
) -> Vec<serde_json::Value> {
    sink.matching(mark, "card_id", &card_id.to_string())
        .into_iter()
        .filter(|line| {
            line["msg"]
                .as_str()
                .is_some_and(|msg| msg.contains("CLI が終了を名乗りました"))
        })
        .collect()
}

/// 申告の行が `これより多く` 出るまで待ち、**見た時刻を添えて**返す。
///
/// 出なければ `None`（**出ないことも実測**なので、待ち切れを失敗にしない）。
/// 時刻をログの `ts` から読まずに手元の時計で持つのは、**依存を1つも増やさない**ため。
/// 測りたいのは猶予（120秒）との桁の違いなので、巡回の刻みぶんの粗さで足りる。
async fn 申告を待つ(
    sink: &session_host_core::logging::capture::Sink,
    mark: usize,
    card_id: protocol::CardId,
    これより多く: usize,
) -> Option<(serde_json::Value, Instant)> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let mut 行 = 申告の行(sink, mark, card_id);
        if 行.len() > これより多く {
            return 行.pop().map(|line| (line, Instant::now()));
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
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
        .send_instruction(&format!(
            "次の2語をそのまま順に書き出すだけで答えて。説明は不要。\n{FIRST}\n{SECOND}"
        ))
        .await
        .expect("端末へ書き込めること");

    // 履歴に載った「ユーザの発言」が1件で、両方の語を含んでいれば、
    // 2行が1つの指示として届いたことになる
    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut prompt = None;
    while Instant::now() < deadline {
        let nodes = server.transcript_of(session.card_id);
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

    // --- 長い単一行 ---------------------------------------------------------
    // フェーズ6の受け入れテストで見つけた破綻の回帰テスト。かつては単一行を包まずに
    // `本文 + CR` で送っていたため、**一定の長さを超えると TUI が貼り付けと判定して
    // 末尾の CR まで飲み込み、確定しなかった**。文字は入力欄に残り、エラーも出ない。
    //
    // 短い単一行では起きないので、ここは**必ず境目より長い**本文で試す（実測した境目は
    // 57〜64 バイトの間）。上の複数行だけを試していると、この経路は一度も踏まれない。
    const LONG_MARK: &str = "チャーリー";
    wait_for_status(&session, SessionStatus::WaitingInput).await;
    let long_line = format!(
        "次の指示は改行をひとつも含まない長い1行です。説明は不要なので、この語だけをそのまま書き出して答えてください: {LONG_MARK}"
    );
    assert!(
        long_line.len() > 64,
        "境目より短い本文では破綻を再現できない: {} バイト",
        long_line.len()
    );
    session
        .send_instruction(&long_line)
        .await
        .expect("端末へ書き込めること");

    let deadline = Instant::now() + CLI_TIMEOUT;
    let mut long_prompt = None;
    while Instant::now() < deadline {
        let nodes = server.transcript_of(session.card_id);
        if let Some(text) = nodes.iter().find_map(|node| match &node.node {
            protocol::Node::UserMessage { text } if text.contains(LONG_MARK) => Some(text.clone()),
            _ => None,
        }) {
            long_prompt = Some(text);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(
        long_prompt.is_some(),
        "長い単一行が確定されませんでした（入力欄に残ったまま送信されていない）"
    );

    // --- 単一行のスラッシュコマンド（短い経路）-----------------------------
    // `/exit` を選んだのは、成否が状態としてはっきり出るから（追加の課金も無い）
    wait_for_status(&session, SessionStatus::WaitingInput).await;
    session
        .send_instruction("/exit")
        .await
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
    // 権限確認で止まらないよう、編集を許すモードで起動する。
    // **利用者のグローバル設定は持ち込まない**——セッション開始の自動スキルが
    // 許可待ちを作ると、acceptEdits はスキル使用を自動許可しないため、
    // サブエージェントが走る前にターンごと塞がる（v2.1.227 の実測で踏んだ。
    // 指示は記録されるのに assistant の応答が1件も無い、という顔で落ちる）
    let wrapper = claude_wrapper(
        &dir,
        &[
            "--permission-mode",
            "acceptEdits",
            "--setting-sources",
            "project,local",
        ],
    );
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
        let nodes = server.transcript_of(session.card_id);
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
    let nodes = server.transcript_of(session.card_id);
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
    inner: session_host_core::selfheal::ops::HostOps,
}

impl session_host_core::selfheal::ops::SelfhealOps for PlantedCanary {
    fn prepare_worktree(&self, branch: &str) -> anyhow::Result<PathBuf> {
        self.inner.prepare_worktree(branch)
    }

    /// **本物へ委ねる。** ここを「常に真」にすると、実CLIの訓練だけが門を素通りし、
    /// 古い土台の上でも通ってしまう（確かめたいのは本物の1周である）
    fn repo_head(&self) -> anyhow::Result<String> {
        self.inner.repo_head()
    }

    fn worktree_contains(&self, worktree: &Path, sha: &str) -> anyhow::Result<bool> {
        self.inner.worktree_contains(worktree, sha)
    }

    fn run_canary(
        &self,
        _model: &str,
        worktree: &Path,
    ) -> anyhow::Result<session_host_core::selfheal::ops::CanarySample> {
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
        Ok(session_host_core::selfheal::ops::CanarySample {
            version: "9.9.9".to_string(),
            dir,
            has_tool_use: true,
            has_subagent: true,
        })
    }

    fn run_gate(&self, worktree: &Path) -> session_host_core::selfheal::ops::GateOutcome {
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

    fn discard_changes(&self, worktree: &Path) -> anyhow::Result<()> {
        self.inner.discard_changes(worktree)
    }
}

/// 前回の訓練が残した worktree とブランチを片付ける。
///
/// 本番では前回の修復を積み上げるのが正しい（直した内容を捨てない）が、訓練は毎回
/// **同じ出発点**から始まらないと結果が変わってしまう。
fn reset_maintenance_worktree(repo: &Path) {
    let name = session_host_core::selfheal::MAINTENANCE_NAME;
    let worktree = repo
        .join(session_host_core::selfheal::ops::WORKTREE_DIR)
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
async fn カナリアが構造の全部入りのサンプルを採れる() {
    // テスト計画フェーズ7「検知（バージョン）」の裏側。擬似 claude はトランスクリプトを
    // 書かないので、**カナリアが本当に使えるサンプルを採れるか**は本物でしか分からない。
    //
    // 「使える」とは、ツールコールとサブエージェントの**両方**が入っていること。
    // ここが欠けたサンプルでゲートを通しても、一番壊れやすい部分を確かめないまま
    // 「対応済み」と記録することになる。
    let repo = repo_root();
    let dir = WorkDir::new("canary");
    // `run_canary` は渡した場所の `fixtures/` 配下へ置くだけなので、使い捨ての
    // ディレクトリを worktree の代わりに渡せばリポジトリを汚さない
    let workspace = dir.path().to_path_buf();

    let ops = session_host_core::selfheal::ops::HostOps::new(repo, "claude".to_string());
    let model = "haiku".to_string();
    let sample = tokio::task::spawn_blocking(move || {
        use session_host_core::selfheal::ops::SelfhealOps as _;
        ops.run_canary(&model, &workspace)
    })
    .await
    .expect("採取スレッドが正常に終わること")
    .expect("カナリアが成功すること");

    let body = std::fs::read_to_string(sample.dir.join("session.jsonl"))
        .expect("採ったサンプルを読めること");
    let types: std::collections::BTreeSet<&str> = body
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|record| {
            record
                .get("type")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .collect::<std::collections::BTreeSet<String>>()
        .iter()
        .map(|name| Box::leak(name.clone().into_boxed_str()) as &str)
        .collect();
    // 何が採れたのかを残す（--nocapture で実行するので出力が記録に残る）
    println!(
        "採取: 版={} 行数={} 種別={:?} ツールコール={} サブエージェント={}",
        sample.version,
        body.lines().count(),
        types,
        sample.has_tool_use,
        sample.has_subagent
    );

    assert!(
        !sample.is_thin(),
        "既定のモデルでは構造の全部入りにならなかった（ツールコール={} / サブエージェント={}）。\
        canary_model の既定を上げることを検討する",
        sample.has_tool_use,
        sample.has_subagent
    );
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
        inner: session_host_core::selfheal::ops::HostOps::new(repo.clone(), "claude".to_string()),
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
        .join(session_host_core::parser::PARSER_POINTER);
    let original = std::fs::read_to_string(&pointer).expect("最初のポインタが書かれている");
    let worktree = repo
        .join(session_host_core::selfheal::ops::WORKTREE_DIR)
        .join(session_host_core::selfheal::MAINTENANCE_NAME);

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
    let state = session_host_core::selfheal::state::SelfhealState::load(&dir.path().join("state"));
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

// ---------------------------------------------------------------------------
// 8. 権限モード（テスト計画フェーズ4）
// ---------------------------------------------------------------------------
//
// 擬似 claude では確かめられない継ぎ目はここでも同じ。「こちらが渡した
// `--permission-mode` を本物の CLI が本当に受け取るか」「本物のフッタから
// 本当にモードを読めるか」「Shift+Tab が本当に効くか」の3つ。
//
// 1セッションに詰め込んであるのは、実 claude は同時1本までという運用の約束
// （PJTガイドライン「実 claude を起動して検証するとき」）に沿うため。

/// フッタが読めるまで待つ。本物の CLI は起動に十数秒かかることがある。
async fn wait_for_mode(session: &Session, expected: &str) -> protocol::PermissionMode {
    let expected = protocol::PermissionMode::new(expected);
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        let current =
            session_host_core::session::permission::parse_footer(&session.scrollback_text());
        if current.as_ref() == Some(&expected) {
            return expected;
        }
        assert!(
            Instant::now() < deadline,
            "{CLI_TIMEOUT:?} 以内に {expected} になりませんでした。実際: {current:?}"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 指定した権限モードで起動しフッタから読み取れる() {
    let dir = WorkDir::new("permission-mode");
    // 利用者のグローバル設定（permissions.defaultMode）に左右されないよう外す
    let program = claude_wrapper(&dir, &["--setting-sources", "project,local"]);
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;

    // 起動フォームの選択肢「編集の承認のみスキップ」で起こす
    let session = server
        .manager
        .spawn_with_mode(
            &dir.as_str(),
            Some(protocol::PermissionMode::new("acceptEdits")),
        )
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    accept_trust_prompt_if_any(&session, &mut watcher).await;

    // 指定したモードで本当に立ち上がったこと（フッタが唯一の証拠）
    wait_for_mode(&session, "acceptEdits").await;

    // 画面からの切替が本物の TUI に効くこと。巡回に入っているモードを選ぶ
    watcher.drain_quiet_for(Duration::from_secs(1)).await;
    let reached = session
        .switch_permission_mode(&protocol::PermissionMode::new("plan"))
        .await
        .expect("巡回に入っているので着けること");
    assert_eq!(reached, protocol::PermissionMode::new("plan"));
    wait_for_mode(&session, "plan").await;

    // 巡回に入らないモードは、黙らずに理由つきで失敗すること
    watcher.drain_quiet_for(Duration::from_secs(1)).await;
    let error = session
        .switch_permission_mode(&protocol::PermissionMode::new("dontAsk"))
        .await
        .expect_err("dontAsk は巡回に入らない（設計§11）");
    assert!(
        error.to_string().contains("切り替えられません"),
        "理由が分かる文になっていない: {error}"
    );

    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 指定なしでは利用者の設定どおりのモードで起動する() {
    let dir = WorkDir::new("permission-mode-default");
    // ラッパーで manual を明示し、「利用者の設定」を再現する。
    // ダッシュボードが勝手に上書きしないことを見るのが目的
    let program = claude_wrapper(
        &dir,
        &[
            "--setting-sources",
            "project,local",
            "--permission-mode",
            "acceptEdits",
        ],
    );
    let server = common::TestServer::start_with_program(
        Config::default(),
        program.to_string_lossy().into_owned(),
    )
    .await;

    let session = server
        .manager
        .spawn_with_mode(&dir.as_str(), None)
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    accept_trust_prompt_if_any(&session, &mut watcher).await;

    // こちらが何も渡していないので、ラッパー側の指定がそのまま効く
    wait_for_mode(&session, "acceptEdits").await;

    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 注入したstatusLineから本物のCLIがモデルを名乗る() {
    // テスト計画フェーズ4。**擬似 claude では確かめられない継ぎ目**がここ——
    // 注入した settings の statusLine を本物の CLI が本当に読み、こちらの
    // model-post を子プロセスとして起こし、期待した形の JSON を渡してくるか。
    //
    // ターンは回さないので**トークンは使わない**（statusLine も /model もローカル実行。
    // 公式ドキュメント明記、設計§11 で実測）。
    let dir = WorkDir::new("model");

    // ダッシュボードが読み書きするグローバル既定は使い捨てのファイルにする。
    // **利用者の本物の設定を対象にしない**ための差し替え（設計§11）。
    // 本物の claude 自身は $HOME を見るので、そちら側の汚れは
    // scripts/test-cli の trap が戻す
    let fake_global = dir.path().join("claude-settings.json");
    std::fs::write(&fake_global, "{\n  \"model\": \"haiku\"\n}\n")
        .expect("擬似のグローバル設定を書けること");

    let config = Config {
        claude_settings_path: Some(fake_global.clone()),
        // 切替の確定が届くまでの時間はこの値で決まる（モデル変更は契機に入っていない）
        status_line_refresh_secs: 1,
        ..Config::default()
    };
    let program = claude_wrapper(&dir, &["--setting-sources", "project,local"]);
    let server =
        common::TestServer::start_with_program(config, program.to_string_lossy().into_owned())
            .await;

    let session = server
        .manager
        .spawn(&dir.as_str())
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    accept_trust_prompt_if_any(&session, &mut watcher).await;

    // 注入した model で始まること（設計§6 の主の仕掛け）。
    // id の形は環境で変わりうるので、系統名だけを見る
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        if let Some(model) = session.meta().model
            && model.as_str().contains("haiku")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "注入した model で始まりませんでした。実際: {:?}",
            session.meta().model
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // 表示名は**版番号入り**で届くこと（設計§12 の要）。
    // ここが `Haiku` のように版番号無しだと、画面に版番号を出せない
    let label = session.meta().model_label.expect("表示名が届いていること");
    assert!(
        label.chars().any(|ch| ch.is_ascii_digit()),
        "表示名に版番号が入っていること。実際: {label}"
    );

    // 画面からの切替が本物の TUI に効くこと
    watcher.drain_quiet_for(Duration::from_secs(1)).await;
    server
        .manager
        .switch_model(&session, &protocol::ModelId::new("sonnet"))
        .await
        .expect("切り替えられること");

    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        if let Some(model) = session.meta().model
            && model.as_str().contains("sonnet")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "切替が効きませんでした。実際: {:?}",
            session.meta().model
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // 別名の解決先を覚えたこと（設計§12）
    let resolved = server
        .manager
        .aliases()
        .resolve(&protocol::ModelId::new("sonnet"));
    assert!(resolved.is_some(), "切替の結果を覚えていること");

    // 擬似のグローバル既定が元へ戻っていること（設計§6 の副の仕掛け）。
    // 本物の claude が書くのは $HOME 側なので、ここは「余計に書かない」ことの確認
    let after = std::fs::read_to_string(&fake_global).expect("読めること");
    assert_eq!(after, "{\n  \"model\": \"haiku\"\n}\n", "実際:\n{after}");

    server
        .manager
        .archive(session.card_id)
        .expect("片付けられること");
}

// ---------------------------------------------------------------------------
// 10. セルフホスト構成（2プロセス）で、本物の TUI をリモートの画面越しに操作する
// ---------------------------------------------------------------------------
//
// テスト計画フェーズ4 の実CLI 3項目と、実機検証#3（入力→画面の往復）の確定測定。
//
// # なぜ2プロセスで、しかも本物の CLI なのか
//
// 擬似 claude には TUI が無い。`/rewind` のメニューも権限確認のダイアログも、
// **画面に描かれて初めて存在する**ので、
//
// ```text
// 本物の TUI → PTY → vt100 → 画面/差分 → A2S → サーバ → 0x03/0x01 → 端末
// ```
//
// この経路を端から端まで通さないと「リモートから操作できる」は確かめられない。
// 費用を抑えるためモデルは haiku に固定する（利用者の判断）。

/// リモート構成の一式（サーバ＋セッションホストを別プロセスで起こす）。
struct RemotePair {
    dir: WorkDir,
    addr: std::net::SocketAddr,
    server: std::process::Child,
    agent: std::process::Child,
    /// 管理者の入館証。
    ///
    /// **セルフホストはログインしないと何も見えない**（セルフホスト化設計§8-6）。
    /// ここが無いまま `/api/settings` を叩くと 401 が返り、「まだ起きていない」と
    /// 「まだ通っていない」が同じ形になる——ガイドライン「起動待ちに鍵の向こうの口を
    /// 使わない」が名指ししている壊れ方で、実際にこの4本が180秒待って落ちていた。
    cookie: Option<String>,
}

impl Drop for RemotePair {
    fn drop(&mut self) {
        let _ = self.agent.kill();
        let _ = self.agent.wait();
        let _ = self.server.kill();
        let _ = self.server.wait();
    }
}

/// 立ち上がらなかったときに、その理由を書いた材料を集める。
///
/// **設計§16-2 の予行である。** 「PC が名乗りませんでした」という症状だけを渡されて
/// コードを読みに行くのではなく、**ログの行から範囲を絞れること**を、テストの失敗
/// メッセージそのもので果たす。ここが空なら、それ自体が「経路が痕跡を残していない」
/// という発見になる。
///
/// 端末層（`*.log`）とファイル層（`<state_dir>/logs/*.jsonl`）の両方を出す。前者は
/// 人が読む形で水位が `info`、後者は JSON で水位が `debug` なので、**同じ事象でも
/// 片方にしか出ないことがある**。
fn 立ち上がりの手がかり(work: &Path) -> String {
    let mut out = String::new();
    for (label, path) in [
        ("サーバの端末出力", work.join("server.log")),
        ("セッションホストの端末出力", work.join("agent.log")),
    ] {
        out.push_str(&format!(
            "\n===== {label}（{}）=====\n{}",
            path.display(),
            末尾を読む(&path)
        ));
    }
    for (label, logs) in [
        ("サーバのログ", work.join("server/logs")),
        ("セッションホストのログ", work.join("agent/logs")),
    ] {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(&logs)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        paths.sort();
        let mut body = String::new();
        for path in &paths {
            body.push_str(&末尾を読む(path));
        }
        if body.is_empty() {
            // **黙って空を返さない。** ログが1行も無いこと自体が手がかりになる
            body.push_str("（ファイルが1つも無い）\n");
        }
        out.push_str(&format!(
            "\n===== {label}（{}）=====\n{body}",
            logs.display()
        ));
    }
    out
}

/// ファイルの末尾を読む。**無い・空・読めないを区別して言う**——黙って空を返すと、
/// 書けなかったのか読めなかったのかが分からなくなる。
fn 末尾を読む(path: &Path) -> String {
    /// 1ファイルあたりの上限。文字数で切る（バイトで切ると日本語の途中で割れる）
    const TAIL_CHARS: usize = 3_000;

    match std::fs::read_to_string(path) {
        Ok(text) if text.is_empty() => "（空）\n".to_string(),
        Ok(text) => {
            let start = text
                .char_indices()
                .rev()
                .take(TAIL_CHARS)
                .last()
                .map_or(0, |(at, _)| at);
            let mut tail = text[start..].to_string();
            if !tail.ends_with('\n') {
                tail.push('\n');
            }
            tail
        }
        Err(err) => format!("（読めない: {err}）\n"),
    }
}

impl RemotePair {
    /// 本物の claude を相手に、2プロセス構成を起こす。
    async fn start(label: &str, extra: &[&str]) -> Self {
        let dir = WorkDir::new(label);
        std::fs::create_dir_all(dir.path().join("server")).expect("置き場所を作れること");
        std::fs::create_dir_all(dir.path().join("agent")).expect("置き場所を作れること");

        let port = free_port();
        let addr: std::net::SocketAddr = format!("127.0.0.1:{port}")
            .parse()
            .expect("番号を読めること");
        let server_config = dir.path().join("server.toml");
        std::fs::write(
            &server_config,
            format!(
                "port = {port}\nstate_dir = \"{state}\"\ndatabase_url = \"sqlite://{db}\"\n",
                state = dir.path().join("server").display(),
                db = dir.path().join("server/dashboard.db").display(),
            ),
        )
        .expect("サーバの設定を書けること");

        // トークンの発行は DB を直に触るので、待ち受けの前でよい
        let issued = Command::new(testkit::binary_path("agentdashboard"))
            .arg("--config")
            .arg(&server_config)
            .arg("pair-token")
            // **ブラウザで入るアカウントと同じにする。** 違うアカウントのトークンで
            // 繋いだ PC は、そのアカウントでログインしないと見えない（§8-6）
            .arg("--account")
            .arg(REMOTE_ACCOUNT)
            .output()
            .expect("トークンを発行できること");
        let token = String::from_utf8_lossy(&issued.stdout).trim().to_string();
        assert!(token.starts_with("adp_"), "実際: {token}");

        // **出力を捨てない。** 立ち上がらなかったときに理由を書いているのはここで、
        // `Stdio::null()` にしていたせいで「PC が名乗りませんでした」としか言えない状態が
        // 続いていた。標準出力は捨てたままでよい（端末層は stderr。設計§5-1）
        let server = Command::new(testkit::binary_path("agentdashboard"))
            .arg("--config")
            .arg(&server_config)
            .arg("--mode")
            .arg("server")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::from(
                std::fs::File::create(dir.path().join("server.log"))
                    .expect("サーバの出力先を作れること"),
            ))
            .spawn()
            .expect("サーバを起動できること");

        // **モデルは haiku に固定する。** 実CLI のテストはクォータを消費するので、
        // 見たいもの（TUI の描画と操作）に必要な最小の費用で通す
        let mut args: Vec<&str> = vec!["--model", "haiku"];
        args.extend_from_slice(extra);
        let wrapper = claude_wrapper(&dir, &args);

        let agent_config = dir.path().join("agent.toml");
        std::fs::write(
            &agent_config,
            format!(
                "server_url = \"http://127.0.0.1:{port}\"\n\
                 pairing_token = \"{token}\"\n\
                 agent_name = \"実CLI用PC\"\n\
                 state_dir = \"{state}\"\n\
                 claude_settings_path = \"{settings}\"\n\
                 status_line_refresh_secs = 1\n\
                 selfheal_enabled = false\n",
                state = dir.path().join("agent").display(),
                settings = dir.path().join("agent/claude-settings.json").display(),
            ),
        )
        .expect("セッションホストの設定を書けること");

        let agent = Command::new(testkit::binary_path("agentdashboard-agent"))
            .arg("--config")
            .arg(&agent_config)
            .env(lifecycle::CLAUDE_BIN_ENV, &wrapper)
            .env(
                session_host_core::parser::PARSER_BIN_ENV,
                common::parser_program(),
            )
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::from(
                std::fs::File::create(dir.path().join("agent.log"))
                    .expect("セッションホストの出力先を作れること"),
            ))
            .spawn()
            .expect("セッションホストを起動できること");

        let mut pair = Self {
            dir,
            addr,
            server,
            agent,
            cookie: None,
        };

        // **まず鍵の外側で待ち、そのあと管理者を作る。** 待ち合わせに鍵の内側の口を使うと、
        // 「まだ起きていない」と「まだ通っていない」がどちらも空に見えて永久に待つ
        pair.wait_until_listening().await;
        pair.setup_admin().await;

        // 名乗りが済むと、PC の能力（権限モード）が設定に現れる
        let deadline = Instant::now() + CLI_TIMEOUT;
        loop {
            if !pair.available_modes().await.is_empty() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{CLI_TIMEOUT:?} 以内に PC が名乗りませんでした。{}",
                立ち上がりの手がかり(pair.dir.path())
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        pair
    }

    async fn available_modes(&self) -> Vec<String> {
        let Some((_, body)) = self.get("/api/settings").await else {
            return Vec::new();
        };
        let view: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        view["available_modes"]
            .as_array()
            .map(|modes| {
                modes
                    .iter()
                    .filter_map(|mode| mode.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 待ち受けが始まるまで待つ。**鍵の外側の口で見る**（`/api/me` は素通し）。
    async fn wait_until_listening(&self) {
        let deadline = Instant::now() + CLI_TIMEOUT;
        loop {
            if let Some((200, _)) = self.get("/api/me").await {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{CLI_TIMEOUT:?} 以内にサーバが待ち受けませんでした。{}",
                立ち上がりの手がかり(self.dir.path())
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// 最初の管理者を作り、その入館証を持ち回る（`two_process.rs` と同じ形）。
    ///
    /// **アカウント名はトークンを発行したときと同じ [`REMOTE_ACCOUNT`] にする。**
    /// 違うアカウントで入ると、そのトークンで繋いだ PC は**見えているのに見えない**
    /// ——接続もペアリングも成功したまま、こちらの一覧にだけ現れない（§8-6）。
    async fn setup_admin(&mut self) {
        let addr = self.addr;
        let body =
            serde_json::json!({ "name": REMOTE_ACCOUNT, "password": REMOTE_PASSWORD }).to_string();
        let response = tokio::task::spawn_blocking(move || {
            testkit::request(addr, "POST", "/api/setup", Some(&body), None)
        })
        .await
        .expect("スレッドが落ちないこと")
        .expect("セットアップの応答を読めること");
        assert_eq!(response.status, 200, "管理者を作れない: {}", response.body);
        self.cookie = response.cookie;
        assert!(self.cookie.is_some(), "入館証が発行されていない");
    }

    async fn get(&self, path: &str) -> Option<(u16, String)> {
        let (addr, path, cookie) = (self.addr, path.to_string(), self.cookie.clone());
        tokio::task::spawn_blocking(move || {
            testkit::request(addr, "GET", &path, None, cookie.as_deref())
        })
        .await
        .ok()?
        .ok()
        .map(|response| (response.status, response.body))
    }

    /// ブラウザの役で繋ぐ。
    async fn browser(&self) -> Browser {
        browser_at(self.addr, self.cookie.as_deref()).await
    }
}

/// 待ち受けている相手へ、ブラウザの役で繋ぐ。
///
/// **入館証は任意。** ローカルモード（鍵なし）とセルフホスト（鍵あり）の両方から
/// 呼ばれるので、持っていない側に無理やり持たせない。
async fn browser_at(addr: std::net::SocketAddr, cookie: Option<&str>) -> Browser {
    // `/ws` も REST と同じ Cookie で認証する（セルフホスト化設計§8-2）ので、
    // 載せないと upgrade の手前で 401 になる
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(format!("ws://{addr}/ws"))
        .header("Host", addr.to_string())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .header("Cookie", cookie.unwrap_or_default())
        .body(())
        .expect("要求を組み立てられること");
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ブラウザとして繋げること");
    Browser {
        socket,
        mirror: vt100::Parser::new(SCREEN_ROWS, SCREEN_COLS, 1000),
        snapshots: 0,
        card: None,
    }
}

/// 実CLI のリモート検証で使う端末の大きさ。
const SCREEN_COLS: u16 = 120;
const SCREEN_ROWS: u16 = 40;

/// リモート構成で使うアカウント。**トークンの発行とログインで同じものを使う**
/// （`two_process.rs` と同じ理由。§8-6）。
const REMOTE_ACCOUNT: &str = "実CLI";
const REMOTE_PASSWORD: &str = "つよいあいことば";

/// 空いているポートを1つ借りる。
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("空きポートを取れること");
    listener.local_addr().expect("番号を読めること").port()
}

/// ブラウザの役。**xterm.js と同じ意味論で画面を組み立てる**（設計§4-3）。
struct Browser {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mirror: vt100::Parser,
    snapshots: usize,
    /// いま手元に持っているカード。
    ///
    /// **`SessionUpsert` だけを見ていては足りない。** 状態の変化は差分（`Status`）で
    /// 飛んでくるので（設計§4）、本物の画面（`stores/sessions.ts`）と同じように
    /// 両方を当てないと「権限確認待ちになった」を観測できない。
    card: Option<protocol::SessionMeta>,
}

impl Browser {
    async fn send(&mut self, message: &protocol::ws::ClientMessage) {
        use futures_util::SinkExt as _;
        let text = serde_json::to_string(message).expect("組み立てられること");
        self.socket
            .send(tokio_tungstenite::tungstenite::Message::text(text))
            .await
            .expect("送れること");
    }

    /// キー入力（0x02）。**ブラウザの端末が送るのと同じ形**で送る。
    async fn key(&mut self, bytes: &[u8], card_id: protocol::CardId) {
        use futures_util::SinkExt as _;
        let frame = protocol::frame::encode(protocol::frame::FrameKind::PtyInput, card_id, bytes);
        self.socket
            .send(tokio_tungstenite::tungstenite::Message::Binary(
                frame.into(),
            ))
            .await
            .expect("送れること");
    }

    /// 届いたものを1つ処理する。画面なら組み立て、カードの知らせなら返す。
    async fn pump(&mut self, timeout: Duration) -> Option<protocol::ws::ServerMessage> {
        use futures_util::StreamExt as _;
        let next = tokio::time::timeout(timeout, self.socket.next())
            .await
            .ok()?;
        match next {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                let message = serde_json::from_str::<protocol::ws::ServerMessage>(&text).ok()?;
                self.apply(&message);
                Some(message)
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(bytes))) => {
                let frame = protocol::frame::decode(&bytes).expect("フレームを分解できること");
                match frame.kind {
                    // 0x03＝作り直してから書く
                    protocol::frame::FrameKind::PtySnapshot => {
                        self.mirror = vt100::Parser::new(SCREEN_ROWS, SCREEN_COLS, 1000);
                        self.mirror.process(frame.payload);
                        self.snapshots += 1;
                    }
                    // 0x01＝書き足す
                    protocol::frame::FrameKind::PtyOutput => self.mirror.process(frame.payload),
                    other => panic!("ブラウザへ来てはいけない種別です: {other:?}"),
                }
                None
            }
            _ => None,
        }
    }

    /// 届いた知らせを手元のカードへ当てる（本物の画面と同じ扱い）。
    fn apply(&mut self, message: &protocol::ws::ServerMessage) {
        match message {
            protocol::ws::ServerMessage::SessionUpsert { session } => {
                self.card = Some((**session).clone());
            }
            // **状態は差分で飛んでくる。** カード全体を毎回送らないための作りなので、
            // 当てないと「作業中になった」も「権限確認待ちになった」も観測できない
            protocol::ws::ServerMessage::Status {
                card_id,
                status,
                subagent_active,
                last_activity_at,
            } => {
                if let Some(card) = self.card.as_mut()
                    && card.card_id == *card_id
                {
                    card.status = *status;
                    card.subagent_active = *subagent_active;
                    card.last_activity_at = *last_activity_at;
                }
            }
            _ => {}
        }
    }

    fn screen(&self) -> String {
        self.mirror.screen().contents()
    }

    /// 使い捨てディレクトリで出るフォルダ信頼の確認に、**リモートの画面越しに**答える。
    ///
    /// 出るまでに十数秒かかることがあり、出ない環境（既に信頼済み）もある。
    /// 「出たら答える・出なければそのまま進む」の形にしておかないと、環境によって
    /// 落ちたり永遠に待ったりする。
    ///
    /// ここが**画面配信の最初の実証**でもある——答えるには画面が読めていなければならない。
    async fn accept_trust_if_any(&mut self, card_id: protocol::CardId) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            self.pump(Duration::from_millis(500)).await;
            let screen = self.screen().to_lowercase();
            if screen.contains("do you trust") || screen.contains("trust this folder") {
                self.key(b"\r", card_id).await;
                // 確定したあと画面が描き直される。落ち着くまで受け取り続ける
                for _ in 0..10 {
                    self.pump(Duration::from_millis(300)).await;
                }
                return;
            }
            // 確認が出ない環境では、そのまま普通の画面になる
            if screen.contains("welcome") || screen.contains("bypassing permissions") {
                return;
            }
        }
    }

    /// 画面に目印が現れるまで受け取り続ける。
    async fn wait_for_screen(&mut self, marker: &str) {
        let deadline = Instant::now() + CLI_TIMEOUT;
        while !self.screen().contains(marker) {
            assert!(
                Instant::now() < deadline,
                "{CLI_TIMEOUT:?} 以内に画面へ {marker:?} が現れませんでした。実際の画面:\n{}",
                self.screen()
            );
            self.pump(Duration::from_millis(500)).await;
        }
    }

    /// カードが条件を満たすまで受け取り続ける（画面も並行して組み立てる）。
    async fn wait_for_card(
        &mut self,
        what: &str,
        matches: impl Fn(&protocol::SessionMeta) -> bool,
    ) -> protocol::SessionMeta {
        let deadline = Instant::now() + CLI_TIMEOUT;
        loop {
            if let Some(card) = self.card.as_ref().filter(|card| matches(card)) {
                return card.clone();
            }
            assert!(
                Instant::now() < deadline,
                "{CLI_TIMEOUT:?} 以内にカードが {what} になりませんでした（いまの状態: {:?}）。実際の画面:\n{}",
                self.card.as_ref().map(|card| card.status),
                self.screen()
            );
            self.pump(Duration::from_millis(500)).await;
        }
    }
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn リモートの画面越しに権限確認へ答えると作業中へ戻る() {
    // 検収「権限プロンプトにリモートから応答できる」。**画面を読んで、キーを送る**——
    // 途中に生バイトが1バイトも無い経路で、これが成り立つかどうかを見る
    // 利用者のグローバル設定を読み込ませない。`permissions.defaultMode` が `auto` だと
    // **読み取り専用に見えるコマンドは確認なしで通る**ので、確認そのものが出ない
    let pair = RemotePair::start(
        "remote-permission",
        &[
            "--permission-mode",
            "manual",
            "--setting-sources",
            "project,local",
        ],
    )
    .await;
    let mut browser = pair.browser().await;

    browser
        .send(&protocol::ws::ClientMessage::Spawn {
            cwd: pair.dir.as_str(),
            permission_mode: None,
            // 繋がっているのは1台だけなので、宛先は選ばない
            agent_id: None,
        })
        .await;
    let card = browser.wait_for_card("現れる", |_| true).await;
    browser
        .send(&protocol::ws::ClientMessage::SubPty {
            card_id: card.card_id,
            cols: SCREEN_COLS,
            rows: SCREEN_ROWS,
        })
        .await;

    // 使い捨てディレクトリなので、フォルダ信頼の確認が出ることがある
    browser.accept_trust_if_any(card.card_id).await;
    browser
        .wait_for_card("入力待ちになる", |meta| {
            meta.status == SessionStatus::WaitingInput
        })
        .await;

    // **副作用のある操作を頼む。** `echo` のような読み取り専用に見えるものは、
    // 版によっては確認なしで通ってしまい、確かめたい経路を1度も踏まない（実際に踏んだ）
    browser
        .send(&protocol::ws::ClientMessage::SendInput {
            card_id: card.card_id,
            text: "report.txt というファイルを作って、中身は ok の1行にして。".to_string(),
        })
        .await;

    browser
        .wait_for_card("権限確認待ちになる", |meta| {
            meta.status == SessionStatus::WaitingPermission
        })
        .await;

    // **画面に確認が出ていること**をリモート側の再現画面で確かめてから答える。
    // ここが空だと「状態は変わったが画面は届いていない」ことになる
    browser.wait_for_screen("report.txt").await;
    println!("リモートで見えている画面:\n{}", browser.screen());

    browser.key(b"\r", card.card_id).await;
    browser
        .wait_for_card("作業中へ戻る", |meta| {
            meta.status == SessionStatus::Working
        })
        .await;
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn リモートの画面越しに_rewind_のメニューを操作できる() {
    // 検収「ターミナルビュー」。`/rewind` は**メニューを矢印キーで動かす**ので、
    // 画面が届くだけでなく、xterm.js が正しい符号でキーを送れなければ成立しない。
    // 入力モード（カーソルキーの送り方）を画面と一緒に運んでいるのはこのため（§22 読み替え5）
    let pair = RemotePair::start("remote-rewind", &["--setting-sources", "project,local"]).await;
    let mut browser = pair.browser().await;

    browser
        .send(&protocol::ws::ClientMessage::Spawn {
            cwd: pair.dir.as_str(),
            permission_mode: None,
            // 繋がっているのは1台だけなので、宛先は選ばない
            agent_id: None,
        })
        .await;
    let card = browser.wait_for_card("現れる", |_| true).await;
    browser
        .send(&protocol::ws::ClientMessage::SubPty {
            card_id: card.card_id,
            cols: SCREEN_COLS,
            rows: SCREEN_ROWS,
        })
        .await;

    browser.accept_trust_if_any(card.card_id).await;
    browser
        .wait_for_card("入力待ちになる", |meta| {
            meta.status == SessionStatus::WaitingInput
        })
        .await;

    // 戻れる地点を作る（1往復ぶんの会話）
    browser
        .send(&protocol::ws::ClientMessage::SendInput {
            card_id: card.card_id,
            text: "「あお」とだけ答えて。説明は不要。".to_string(),
        })
        .await;
    browser
        .wait_for_card("答え終わる", |meta| {
            meta.status == SessionStatus::WaitingInput && meta.last_assistant_message.is_some()
        })
        .await;

    // メニューを開く
    browser
        .send(&protocol::ws::ClientMessage::SendInput {
            card_id: card.card_id,
            text: "/rewind".to_string(),
        })
        .await;
    browser.wait_for_screen("rewind").await;
    println!("メニューの画面:\n{}", browser.screen());

    // 矢印キーで動かして閉じる。**カーソルキーの符号が違うと何も起きない**ので、
    // 「動いたこと」が符号が合っていることの証拠になる
    let before = browser.screen();
    browser.key(b"\x1b[B", card.card_id).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    while browser.screen() == before && Instant::now() < deadline {
        browser.pump(Duration::from_millis(500)).await;
    }
    assert_ne!(
        browser.screen(),
        before,
        "矢印キーで画面が動きませんでした（カーソルキーの符号が届いていない）"
    );

    // 閉じて元の画面へ戻る
    browser.key(b"\x1b", card.card_id).await;
    browser
        .wait_for_card("入力待ちへ戻る", |meta| {
            meta.status == SessionStatus::WaitingInput
        })
        .await;
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn セッションホスト経由でも注入したstatusLineからモデルが名乗られる() {
    // テスト計画フェーズ4「実CLI statusLine 実測（agent 経由）」。
    // **注入されるコマンドは実行ファイル自身**（§21）なので、セッションホストとして動くと
    // `agentdashboard-agent model-post` が起動する。ローカルモードで通っていても、
    // こちらで転送の口を持っていなければ1つも届かない
    let pair =
        RemotePair::start("remote-statusline", &["--setting-sources", "project,local"]).await;
    let mut browser = pair.browser().await;

    browser
        .send(&protocol::ws::ClientMessage::Spawn {
            cwd: pair.dir.as_str(),
            permission_mode: None,
            // 繋がっているのは1台だけなので、宛先は選ばない
            agent_id: None,
        })
        .await;
    let card = browser.wait_for_card("現れる", |_| true).await;
    browser
        .send(&protocol::ws::ClientMessage::SubPty {
            card_id: card.card_id,
            cols: SCREEN_COLS,
            rows: SCREEN_ROWS,
        })
        .await;
    browser.accept_trust_if_any(card.card_id).await;

    // statusLine → model-post → セッションホスト → A2S → サーバ、と渡ってカードに載る
    let named = browser
        .wait_for_card("モデルを名乗る", |meta| meta.model.is_some())
        .await;
    let model = named.model.expect("モデルが載っていること");
    println!(
        "名乗ったモデル: {} / 表示名: {:?}",
        model.as_str(),
        named.model_label
    );
    assert!(
        model.as_str().contains("haiku"),
        "起動時に指定したモデルで始まっていない: {}",
        model.as_str()
    );
    assert!(
        named
            .model_label
            .as_ref()
            .is_some_and(|label| label.chars().any(|ch| ch.is_ascii_digit())),
        "表示名に版番号が入っていない: {:?}",
        named.model_label
    );
}

#[tokio::test]
#[ignore = "実測（make test-cli）。本物の claude を起動し、アカウントのクォータを消費する"]
async fn 実機検証3_リモート越しの入力から画面までの往復を測る() {
    // 設計§16-1 #3 の確定測定。フェーズ0 では**手元の PTY だけ**で測っていて
    // （最大185ms。§19-4）、リモートの往復は含まれていなかった。ホットウィンドウ
    // （1.5秒・50ms。§7-5）がその条件でも十分かをここで確かめる。
    //
    // **合否ではなく数値を出す**（`make perf` と同じ扱い）。環境の速さに左右される
    // 数字を合否にすると、直すべきものが無いのに落ちるテストになる
    let pair = RemotePair::start("remote-latency", &["--setting-sources", "project,local"]).await;
    let mut browser = pair.browser().await;

    browser
        .send(&protocol::ws::ClientMessage::Spawn {
            cwd: pair.dir.as_str(),
            permission_mode: None,
            // 繋がっているのは1台だけなので、宛先は選ばない
            agent_id: None,
        })
        .await;
    let card = browser.wait_for_card("現れる", |_| true).await;
    browser
        .send(&protocol::ws::ClientMessage::SubPty {
            card_id: card.card_id,
            cols: SCREEN_COLS,
            rows: SCREEN_ROWS,
        })
        .await;
    browser.accept_trust_if_any(card.card_id).await;
    browser
        .wait_for_card("入力待ちになる", |meta| {
            meta.status == SessionStatus::WaitingInput
        })
        .await;

    // 1文字打っては、画面が動くまでの時間を測る。**打つのは入力欄だけを動かす文字**に
    // して、ターンを回さない（＝トークンを使わない）
    let mut delays: Vec<u128> = Vec::new();
    for index in 0..10u8 {
        let before = browser.screen();
        let at = Instant::now();
        browser.key(&[b'a' + index % 26], card.card_id).await;

        let deadline = at + Duration::from_secs(5);
        while browser.screen() == before && Instant::now() < deadline {
            browser.pump(Duration::from_millis(50)).await;
        }
        if browser.screen() != before {
            delays.push(at.elapsed().as_millis());
        }
        // 次の打鍵まで少し空ける（ホットウィンドウの中に居続けないため）
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    assert!(!delays.is_empty(), "画面が一度も動きませんでした");
    delays.sort_unstable();
    let at = |ratio: f64| delays[((delays.len() as f64 - 1.0) * ratio).round() as usize];
    println!(
        "入力→画面の往復（{} 回）: p50 {}ms / p90 {}ms / 最大 {}ms",
        delays.len(),
        at(0.5),
        at(0.9),
        delays[delays.len() - 1]
    );
    println!(
        "ホットウィンドウ（1500ms）に収まった割合: {}/{}",
        delays.iter().filter(|delay| **delay <= 1_500).count(),
        delays.len()
    );
}

// ---------------------------------------------------------------------------
// 12. 乗り換えた先の版で、本物の claude が動き続ける（CICD テスト計画フェーズ4）

/// 保管庫へ控える版の名前。**いまの版と違う名前**にして、乗り換えが起きたことを
/// 名前でも見分けられるようにする。
const STORED_VERSION: &str = "9.9.9";

/// 乗り換えた先の版で待ち受けているダッシュボード。
///
/// **ライブラリとして動かしていては踏めない。** `current_exe()` がテストバイナリを
/// 指してしまい、乗り換えの判定そのものが成立しないので、実行ファイルを子プロセスと
/// して起こす（CICD設計§4）。
struct HandoverDashboard {
    fixture: common::VersionWorkDir,
    /// 乗り換え先の `agentdashboard`（保管庫の中）。
    target: PathBuf,
    addr: std::net::SocketAddr,
    /// セッションを起こす先。
    workspace: WorkDir,
    child: std::process::Child,
    log: PathBuf,
}

impl Drop for HandoverDashboard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl HandoverDashboard {
    async fn start(label: &str) -> Self {
        let fixture = common::VersionWorkDir::beside_binaries(label);
        let target = fixture.link_stored_version(STORED_VERSION);
        fixture.point_at(&target);

        let port = free_port();
        let addr: std::net::SocketAddr = format!("127.0.0.1:{port}")
            .parse()
            .expect("番号を読めること");
        let config = fixture.write_config(
            &format!("sqlite://{}", fixture.path().join("dashboard.db").display()),
            port,
            &format!(
                "claude_settings_path = \"{settings}\"\n\
                 selfheal_enabled = false\n\
                 status_line_refresh_secs = 1\n",
                settings = fixture.path().join("claude-settings.json").display(),
            ),
        );

        // **モデルは haiku に固定する。** 見たいのは乗り換えの継ぎ目であって賢さではない。
        // 権限モードも固定して、利用者のグローバル設定に左右されないようにする
        let wrapper = claude_wrapper_at(
            fixture.path(),
            &["--model", "haiku", "--permission-mode", "manual"],
        );

        let log = fixture.path().join("server.log");
        let child = testkit::binary_command("agentdashboard")
            // 土台は既定で「乗り換え済み」の印を立てる（開発者の実環境を読まないため）。
            // ここは乗り換えそのものを試すので外す
            .env_remove(session_host_core::version::VERSION_HANDOVER_ENV)
            // 保管庫は自分で用意したので、入れる側の3本を控える必要は無い
            .env(session_host_core::version::VERSION_SUPPORTED_ENV, "0")
            .env(lifecycle::CLAUDE_BIN_ENV, &wrapper)
            .env(
                session_host_core::parser::PARSER_BIN_ENV,
                common::parser_program(),
            )
            .arg("--config")
            .arg(&config)
            .stdout(std::process::Stdio::null())
            .stderr(std::fs::File::create(&log).expect("ログを作れること"))
            .spawn()
            .expect("起こせること");

        let dashboard = Self {
            fixture,
            target,
            addr,
            workspace: WorkDir::new(label),
            child,
            log,
        };
        dashboard.wait_until_listening().await;
        dashboard.assert_handed_over();
        dashboard
    }

    fn printed(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    async fn wait_until_listening(&self) {
        let deadline = Instant::now() + CLI_TIMEOUT;
        loop {
            let up = std::net::TcpStream::connect(self.addr).is_ok()
                && !session_host_core::version::attempt_path(&self.fixture.state_dir()).exists();
            if up {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{CLI_TIMEOUT:?} 以内に待ち受けまで届きませんでした:\n{}",
                self.printed()
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// 乗り換えが実際に起きたことを、起動が名乗った実行ファイルで確かめる。
    fn assert_handed_over(&self) {
        let printed = self.printed();
        assert!(
            printed.contains(&self.target.display().to_string()),
            "乗り換えた先の実行ファイルを名乗っていません（乗り換えていない可能性）:\n{printed}"
        );
    }

    /// 保管庫の版フォルダを消す。
    ///
    /// **画面からは消せない**（走っている版は断られる）ので直に消す。Unix では
    /// 起動済みのプロセスは消えたファイルの実体を掴んだまま走り続けるので、ここで
    /// 生死を分けるのは**フックの入口が版に縛られているかどうか**だけになる。
    fn remove_stored_version(&self) {
        let dir = self.target.parent().expect("版フォルダがあること");
        std::fs::remove_dir_all(dir).expect("版フォルダを消せること");
        assert!(!dir.exists(), "消えていない: {}", dir.display());
    }

    async fn browser(&self) -> Browser {
        // こちらはローカルモード（鍵なし）なので入館証は持たない
        browser_at(self.addr, None).await
    }

    /// セッションを1本起こし、入力待ちになるまで見届ける。
    async fn open_session(&self, browser: &mut Browser) -> protocol::SessionMeta {
        browser
            .send(&protocol::ws::ClientMessage::Spawn {
                cwd: self.workspace.as_str(),
                permission_mode: None,
                agent_id: None,
            })
            .await;
        let card = browser.wait_for_card("現れる", |_| true).await;
        // **画面を購読しないとフレームが1つも来ない。** 信頼の確認に答えるのも、
        // 画面が読めていることが前提になる
        browser
            .send(&protocol::ws::ClientMessage::SubPty {
                card_id: card.card_id,
                cols: SCREEN_COLS,
                rows: SCREEN_ROWS,
            })
            .await;
        browser.accept_trust_if_any(card.card_id).await;
        browser
            .wait_for_card("入力待ちになる", |card| {
                card.status == SessionStatus::WaitingInput
            })
            .await
    }
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 乗り換えた先の版で本物のセッションが起こせフックも届く() {
    // テスト計画フェーズ4 の1つ目と2つ目。擬似 claude では「乗り換えた先で本物の
    // TUI が動く」ところが確かめられない
    let dash = HandoverDashboard::start("handover-session").await;
    let mut browser = dash.browser().await;

    let card = dash.open_session(&mut browser).await;

    // 入力待ちに届いた時点で PTY は生きている（画面を読んで信頼の確認に答えている）
    assert!(
        !browser.screen().trim().is_empty(),
        "画面が1文字も描かれていません"
    );
    // **状態が動くのはフックが届いたときだけ**（設計§5）。起こした直後は `Starting` で、
    // `WaitingInput` へ動くのは `SessionStart` を受けたとき——つまり入力待ちに
    // 届いていること自体が、乗り換えた先から注入したフックが戻ってきた証拠になる
    assert!(
        card.hooks_seen,
        "フックを受けた印が立っていません: {card:?}"
    );
    assert_eq!(
        card.status,
        SessionStatus::WaitingInput,
        "SessionStart が届いていません: {card:?}"
    );
    assert!(
        card.last_activity_at > 0,
        "フック由来の時刻が更新されていません: {card:?}"
    );
}

#[tokio::test]
#[ignore = "本物の claude を起動し、アカウントのクォータを消費する（make test-cli）"]
async fn 版を消しても生きているセッションのフックは届き続ける() {
    // **設計§5 の肝。** 乗り換えると `current_exe()` は保管庫を指すので、素直に
    // 焼き込むとフックのコマンド行が版に縛られる。版を消した瞬間にフックが全滅し、
    // しかも `"async": true` なので **claude は止まらない**——止まらないまま状態だけ
    // 更新されなくなり、「作業中のまま固まる」になる。要件が最も恐れている形
    let dash = HandoverDashboard::start("handover-remove").await;
    let mut browser = dash.browser().await;

    let card = dash.open_session(&mut browser).await;
    let before = card.last_activity_at;

    dash.remove_stored_version();

    // 消したあとに1往復させる。**フックでしか動かない値**が進むことを見る
    browser
        .send(&protocol::ws::ClientMessage::SendInput {
            card_id: card.card_id,
            text: "1+1 は？ 数字だけ答えて".to_string(),
        })
        .await;

    let after = browser
        .wait_for_card("版を消したあとにも動く", |card| {
            card.last_activity_at > before
        })
        .await;

    assert!(
        after.hooks_seen,
        "フックの印が落ちています（版と一緒に入口も消えた）: {after:?}"
    );
    assert!(
        after.last_activity_at > before,
        "版を消したあとフックが1件も届いていません（{before} のまま）"
    );
}
