//! フックの宛先が実在しないとき、何が起きるか
//! （`入れ替えのあとフックの宛先が消えたパスのまま固まる` 方針「確かめ方」）。
//!
//! # なぜ通しで確かめるのか
//!
//! この不具合は**静かに壊れた**。宛先が `…/agentdashboard (deleted)` になっていても
//! claude は止まらず（フックは `"async": true` で返事を待たない）、画面には「不明」と
//! しか出ない。**壊れていることを誰も言わない**ので、原因に辿り着くまで時間がかかった。
//!
//! 決め方そのものは `boot.rs` の `handover_hook_bin` が単体で持っている。ここが見るのは
//! **その先**——決めた宛先が実際に使われる経路（settings の `command` → シェル →
//! `hook-post` → 受信口）で、**実在するかどうかが結果をどう分けるか**である。
//!
//! 撃ち方は擬似 claude と同じ `sh -c <command>`（`testkit/src/bin/fake-claude.rs`）に
//! してあるので、**本物と同じ経路**を通る。

mod common;

use session_host_core::session::hooks_settings::{ModelInjection, build_settings};
use std::{
    io::Write as _,
    path::Path,
    process::{Command, Stdio},
};
use testkit::MockHookServer;

/// 注入した settings から、そのイベントの `command` を1本取り出す。
fn command_of(program: &Path, port: u16, token: &str, event: &str) -> String {
    let settings = build_settings(program, port, token, &ModelInjection::default());
    settings["hooks"][event][0]["hooks"][0]["command"]
        .as_str()
        .expect("フックのコマンドが入っていること")
        .to_string()
}

/// 擬似 claude と同じ撃ち方（`sh -c`）で1本走らせる。
fn fire(command: &str, payload: &str) -> std::process::Output {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("シェルを起動できること");
    child
        .stdin
        .take()
        .expect("stdin を掴めること")
        .write_all(payload.as_bytes())
        .expect("payload を渡せること");
    child.wait_with_output().expect("終了を待てること")
}

const PAYLOAD: &str = r#"{"session_id":"11111111-2222-3333-4444-555555555555","tool_name":"Edit"}"#;

#[tokio::test]
async fn 宛先が実在すればフックは届く() {
    let server = MockHookServer::start()
        .await
        .expect("モックを起動できること");
    let command = command_of(
        &common::hook_program(),
        server.addr().port(),
        "とーくん",
        "PreToolUse",
    );

    let output = tokio::task::spawn_blocking(move || fire(&command, PAYLOAD))
        .await
        .expect("実行できること");

    assert!(output.status.success(), "終了コードが 0 であること");
    let received = server.received();
    assert_eq!(received.len(), 1, "1件届くこと");
    assert_eq!(received[0].payload["tool_name"], "Edit");

    server.shutdown().await;
}

#[tokio::test]
async fn 宛先が消えていると1件も届かず_しかも静かに失敗する() {
    // `make build` は走っているプロセスの実体を消す。そのあと `current_exe()` を読むと
    // カーネルは行き先に `(deleted)` を付けて答える——**これが焼き込まれた形**である。
    // 実機では、この値が入れ替えを2回跨いで居座った
    let server = MockHookServer::start()
        .await
        .expect("モックを起動できること");
    let 消えた宛先 = common::hook_program().with_file_name("agentdashboard (deleted)");
    assert!(!消えた宛先.is_file(), "実在しないことが前提のテスト");

    let command = command_of(&消えた宛先, server.addr().port(), "とーくん", "PreToolUse");
    let output = tokio::task::spawn_blocking(move || fire(&command, PAYLOAD))
        .await
        .expect("実行できること");

    // **1件も届かない。** 状態機械へ入力が入らないので、画面は「不明」のまま動かない。
    // JSONL の場所もフックからしか入らないため、構造化ビューにも何も出ない
    assert_eq!(server.received_count(), 0, "1件も届かないこと");

    // **静かに失敗する。** claude はフックの完了を待たない（`"async": true`）ので、
    // 端末では何事も無かったように作業が続く。**これが気づけなかった理由である**
    assert!(
        output.stdout.is_empty(),
        "標準出力へは何も出さない（出すと Claude の会話へ注入される）。実際: {:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        !output.status.success(),
        "シェルとしては失敗していること（気づける材料はここにしか無い）"
    );

    server.shutdown().await;
}
