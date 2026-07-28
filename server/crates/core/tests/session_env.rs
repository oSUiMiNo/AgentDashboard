//! 環境変数のサニタイズと `--session-id` 採番の検証
//! （テスト計画フェーズ2「環境サニタイズ」「`--session-id` 採番」）。
//!
//! 親側で組み立てた値を見るのではなく、**実際に起動された子プロセスに聞く**。
//! 途中で環境が混ざる経路があっても見落とさないようにするため、擬似 claude の `dump`
//! 命令で子プロセス自身の argv と environ を報告させて検証する。
//!
//! このファイルのテストはプロセスの環境変数を書き換える。テストごとにプロセスを分ける
//! `cargo nextest` を前提としており、他のテストと同じ実行ファイルに同居させないために
//! ファイルを分けている。

mod common;

use agentdashboard_core::session::lifecycle;
use testkit::fake_claude;

/// `dump` の出力から、指定した行頭を持つ行の中身を集める。
fn collect(dump: &str, prefix: &str) -> Vec<String> {
    dump.lines()
        .filter_map(|line| line.trim_end_matches('\r').strip_prefix(prefix))
        .map(|value| value.to_string())
        .collect()
}

#[tokio::test]
async fn 子プロセスの環境に_claude_系が1つも継承されない() {
    // 実機で継承事故を確認した変数を、あえて親に立ててから起動する
    unsafe {
        std::env::set_var("CLAUDE_CODE_SESSION_ID", "継承されてはいけない値");
        std::env::set_var("CLAUDECODE", "1");
        std::env::set_var("ANTHROPIC_API_KEY", "秘密");
    }

    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    common::send_line(&session, "dump");
    watcher.wait_for(fake_claude::DUMP_END_MARKER).await;

    let env = collect(watcher.seen(), fake_claude::ENV_PREFIX);
    assert!(!env.is_empty(), "環境変数が1つも報告されていない");

    let names: Vec<&str> = env
        .iter()
        .map(|entry| entry.split_once('=').map(|(name, _)| name).unwrap_or(entry))
        .collect();

    assert!(
        !names.iter().any(|name| name.starts_with("CLAUDE")),
        "CLAUDE 系が子へ渡っている: {names:?}"
    );
    assert!(
        !names.contains(&"ANTHROPIC_API_KEY"),
        "許可リスト外が子へ渡っている: {names:?}"
    );
    for name in &names {
        assert!(
            *name == "TERM" || lifecycle::is_allowed_env(name),
            "許可リストに無い変数が渡っている: {name}"
        );
    }
    assert!(
        env.iter()
            .any(|entry| entry == &format!("TERM={}", lifecycle::TERM_VALUE)),
        "TERM が固定値になっていない: {env:?}"
    );

    session.kill();
}

#[tokio::test]
async fn 採番した_session_id_が起動引数として子へ渡る() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    common::send_line(&session, "dump");
    watcher.wait_for(fake_claude::DUMP_END_MARKER).await;

    let argv = collect(watcher.seen(), fake_claude::ARGV_PREFIX);
    let expected = session
        .meta()
        .claude_session_id
        .expect("起動時にセッションIDを採番していること")
        .to_string();

    let position = argv
        .iter()
        .position(|arg| arg == "--session-id")
        .unwrap_or_else(|| panic!("--session-id が渡っていない: {argv:?}"));
    assert_eq!(
        argv.get(position + 1).map(String::as_str),
        Some(expected.as_str()),
        "採番した UUID がそのまま渡ること: {argv:?}"
    );

    session.kill();
}
