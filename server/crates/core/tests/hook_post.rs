//! `hook-post` サブコマンドの検証（テスト計画フェーズ2「`hook-post` サブコマンド」）。
//!
//! フックから起動される小さな転送役だが、守らないと事故になる約束が2つある。
//!
//! - **stdout に何も書かない** … UserPromptSubmit / SessionStart 系は「終了コード 0 の
//!   ときの stdout を Claude へのコンテキストとして注入する」仕様。ここに何か出すと、
//!   ダッシュボードが利用者の会話へ勝手に文字列を差し込むことになる
//! - **失敗しても終了コード 0** … ダッシュボードが落ちていることが CLI を止めてはならない
//!
//! 実際にビルドされた `agentdashboard` を子プロセスとして起動して確かめる。関数を直接
//! 呼ぶ形だと、この2つ（標準出力と終了コード）がまさに検証できない。

mod common;

use std::{
    io::Write as _,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use testkit::MockHookServer;

fn run_hook_post(url: &str, payload: &str) -> std::process::Output {
    let mut child = Command::new(common::hook_program())
        .arg("hook-post")
        .arg("--url")
        .arg(url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("hook-post を起動できること");

    child
        .stdin
        .take()
        .expect("stdin を掴めること")
        .write_all(payload.as_bytes())
        .expect("payload を渡せること");

    child.wait_with_output().expect("終了を待てること")
}

#[tokio::test]
async fn stdinのjsonがそのまま転送され標準出力には何も出ない() {
    let server = MockHookServer::start()
        .await
        .expect("モックを起動できること");
    let url = server.hook_url("とーくん", "PreToolUse");
    let payload = r#"{"session_id":"11111111-2222-3333-4444-555555555555","tool_name":"Edit"}"#;

    let output = tokio::task::spawn_blocking(move || run_hook_post(&url, payload))
        .await
        .expect("実行できること");

    assert!(output.status.success(), "終了コードが 0 であること");
    assert!(
        output.stdout.is_empty(),
        "標準出力は空でなければならない（Claude へ注入されてしまうため）。実際: {:?}",
        String::from_utf8_lossy(&output.stdout)
    );

    let received = server.received();
    assert_eq!(received.len(), 1, "1件だけ届くこと");
    assert_eq!(received[0].token, "とーくん");
    assert_eq!(received[0].event, "PreToolUse");
    assert_eq!(received[0].payload["tool_name"], "Edit");
    assert_eq!(
        received[0].raw_body, payload,
        "加工せずそのまま渡すこと（未知のフィールドを落とさない）"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn 送り先が居なくても即座に終了コード0で終わる() {
    // 誰も待ち受けていないポートへ送る。ダッシュボードを起動していない状態にあたる
    let url = "http://127.0.0.1:9/hook/とーくん/Stop".to_string();

    let started = Instant::now();
    let output = tokio::task::spawn_blocking(move || run_hook_post(&url, "{}"))
        .await
        .expect("実行できること");

    assert!(
        output.status.success(),
        "届かなくても終了コードは 0（CLI を止めないため）"
    );
    assert!(output.stdout.is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "待たされないこと。実際: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn 壊れたurlでも落ちずに終了コード0で終わる() {
    for url in ["これはURLではない", "https://127.0.0.1:1/hook/t/Stop"] {
        let given = url.to_string();
        let output = tokio::task::spawn_blocking(move || run_hook_post(&given, "{}"))
            .await
            .expect("実行できること");
        assert!(output.status.success(), "{url} で非ゼロ終了した");
        assert!(output.stdout.is_empty(), "{url} で標準出力に何か出た");
    }
}
