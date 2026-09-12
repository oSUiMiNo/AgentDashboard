//! `model-post` サブコマンドの検証（テスト計画フェーズ2「`model-post` サブコマンド」）。
//!
//! 注入した `statusLine` から起動される転送役。`hook-post` と守る約束が**逆**なので、
//! 別のファイルで別に確かめる。
//!
//! | | `hook-post` | `model-post` |
//! |---|---|---|
//! | stdout | **何も書かない**（会話へ差し込まれるため） | **モデルの表示名を書く**（端末の表示になるだけ） |
//! | 失敗時の終了コード | 0 | 0（同じ） |
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

/// 実測した payload の形（フェーズ0 で v2.1.269 を採り直した。記録は設計§11 前提1）。
///
/// 実物のトップレベルは14キーある。**転送役はどれも読まない**ので全部は並べないが、
/// **`context_window` は載せてある**——受け口が読む欄が増えたときに、
/// **転送役は何も変えなくてよい**ことをここで確かめるため。
const PAYLOAD: &str = r#"{
  "cwd": "/home/example/dev/app",
  "session_id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  "transcript_path": "/home/example/.claude/projects/app/session.jsonl",
  "model": { "id": "claude-opus-5", "display_name": "Opus 5" },
  "context_window": {
    "used_percentage": 24,
    "remaining_percentage": 76,
    "total_input_tokens": 241500,
    "context_window_size": 1000000
  },
  "version": "2.1.269"
}"#;

fn run_model_post(url: &str, payload: &str) -> std::process::Output {
    let mut child = Command::new(common::hook_program())
        .arg("model-post")
        .arg("--url")
        .arg(url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("model-post を起動できること");

    child
        .stdin
        .take()
        .expect("stdin を掴めること")
        .write_all(payload.as_bytes())
        .expect("payload を渡せること");

    child.wait_with_output().expect("終了を待てること")
}

#[tokio::test]
async fn 転送しつつ標準出力へ表示名を書く() {
    let server = MockHookServer::start()
        .await
        .expect("受信サーバを起動できること");
    // 受け口のパスは `/model/<token>`。モックはフックと同じ形で受ける
    let url = server.hook_url("とーくん", "dummy");

    let output = tokio::task::spawn_blocking({
        let url = url.clone();
        move || run_model_post(&url, PAYLOAD)
    })
    .await
    .expect("実行できること");

    assert!(output.status.success(), "終了コードが 0 でない: {output:?}");

    // **ここが hook-post との違い。** statusLine の標準出力は端末の表示になるので、
    // 書かないとその行が空になる。ダッシュボードが落ちていても人が読める形が残る
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(stdout.trim(), "Opus 5", "実際: {stdout:?}");
    assert!(
        stdout.contains('5'),
        "版番号ごと出ること（表示名をそのまま出す）: {stdout:?}"
    );

    // 転送も済んでいること
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.received_count() == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let received = server.received();
    assert_eq!(received.len(), 1, "1件だけ届くこと");
    assert_eq!(received[0].payload["model"]["id"], "claude-opus-5");
}

#[tokio::test]
async fn 宛先が不達でも終了コード0で終わる() {
    // ダッシュボードが落ちていることが CLI の動作を妨げてはならない。
    // ここで非ゼロを返すと、利用者の端末に statusLine のエラーが出続ける
    let output = tokio::task::spawn_blocking(|| {
        // 誰も待ち受けていないポート
        run_model_post("http://127.0.0.1:1/model/とーくん", PAYLOAD)
    })
    .await
    .expect("実行できること");

    assert!(output.status.success(), "終了コードが 0 でない: {output:?}");
    // 届かなくても、人が読める形は残す
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "Opus 5");
}

#[tokio::test]
async fn 想定外のjsonでも落ちず余計なものを出さない() {
    // 届く JSON は CLI 側の都合で増減する。欲しいキーが無ければ黙る
    for payload in ["{}", r#"{"model":null}"#, "これは JSON ではない", ""] {
        let output = tokio::task::spawn_blocking(move || {
            run_model_post("http://127.0.0.1:1/model/とーくん", payload)
        })
        .await
        .expect("実行できること");

        assert!(
            output.status.success(),
            "{payload:?} で終了コードが 0 でない: {output:?}"
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "",
            "読めない payload で何かを出してはいけない: {payload:?}"
        );
    }
}

#[tokio::test]
async fn 読む欄が増えても転送役は加工しない() {
    // **この配管の前提。** 受け口が `context_window` を読むようになっても、転送役は
    // 何も知らなくてよい——payload を丸ごと送っているからである。ここが加工を始めると、
    // 「CLI がキーを増減しても壊れない」という受け口側の約束が意味を失う
    let server = MockHookServer::start()
        .await
        .expect("受信サーバを起動できること");
    let url = server.hook_url("とーくん", "dummy");

    let output = tokio::task::spawn_blocking({
        let url = url.clone();
        move || run_model_post(&url, PAYLOAD)
    })
    .await
    .expect("実行できること");
    assert!(output.status.success(), "終了コードが 0 でない: {output:?}");

    let deadline = Instant::now() + Duration::from_secs(5);
    while server.received_count() == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let received = server.received();
    assert_eq!(received.len(), 1, "1件だけ届くこと");

    // **丸ごと届いていること。** 転送役が読む3キー以外も落とさない
    let window = &received[0].payload["context_window"];
    assert_eq!(window["used_percentage"], 24, "使用率が落ちていないこと");
    assert_eq!(
        window["context_window_size"], 1_000_000,
        "分母が落ちていないこと（これが自前の表を持たずに済む理由）"
    );
    assert_eq!(
        window["remaining_percentage"], 76,
        "受け口が読まない欄も、転送役は落とさないこと"
    );

    // stdout の約束は変わらない（端末に出るのは表示名だけ）
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "Opus 5");
}
