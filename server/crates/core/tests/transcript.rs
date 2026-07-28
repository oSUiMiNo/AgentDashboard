//! 構造化ビューの通し確認（設計§8）。
//!
//! フックが運んできた `transcript_path` → パーサ子プロセス → core の履歴ウィンドウ、
//! という**フェーズ3で新しく通した経路**を端から端まで動かす。
//!
//! ここが動くことは「パーサが別プロセスとして正しく世話されている」ことの証明でもある。
//! 単体テストはパーサの中身しか見ないので、プロセスの起動・IPC・再開位置の受け渡しは
//! この層でしか確かめられない。

mod common;

use agentdashboard_core::config::Config;
use common::TestServer;
use protocol::Node;
use std::path::PathBuf;
use std::time::Duration;

/// テストごとに独立した作業場所を作る。
///
/// 再開位置の保存先を分けないと、前のテストが残した位置から読み始めて「何も届かない」
/// という追いにくい失敗になる。
fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-transcript-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("作業ディレクトリを作れること");
    dir
}

fn config_for(dir: &std::path::Path) -> Config {
    Config {
        state_dir: Some(dir.join("state")),
        ..Config::default()
    }
}

/// 会話1往復ぶんの最小トランスクリプト。
fn sample_lines() -> Vec<String> {
    vec![
        r#"{"type":"user","uuid":"u1","timestamp":"2026-07-29T00:00:00.000Z","version":"2.1.220","message":{"role":"user","content":"テストを流して"}}"#.to_string(),
        r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","timestamp":"2026-07-29T00:00:01.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"text","text":"流します"}]}}"#.to_string(),
        r#"{"type":"assistant","uuid":"u3","parentUuid":"u2","timestamp":"2026-07-29T00:00:02.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm test"}}]}}"#.to_string(),
    ]
}

fn result_line() -> String {
    r#"{"type":"user","uuid":"u4","parentUuid":"u3","timestamp":"2026-07-29T00:00:03.000Z","version":"2.1.220","toolUseResult":{"stdout":"1 passed"},"message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1 passed"}]}}"#.to_string()
}

fn append(path: &std::path::Path, lines: &[String]) {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("トランスクリプトへ書けること");
    for line in lines {
        writeln!(file, "{line}").expect("行を書けること");
    }
}

/// 履歴が届くまで待つ。
async fn wait_for_nodes(
    session: &std::sync::Arc<agentdashboard_core::session::Session>,
    at_least: usize,
) -> Vec<protocol::TreeNode> {
    for _ in 0..200 {
        let nodes = session.transcript_snapshot();
        if nodes.len() >= at_least {
            return nodes;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "履歴が {at_least} 件に届きませんでした（現在 {} 件）",
        session.transcript_snapshot().len()
    );
}

async fn start_session_with_transcript(
    dir: &std::path::Path,
) -> (
    TestServer,
    std::sync::Arc<agentdashboard_core::session::Session>,
    PathBuf,
) {
    let server = TestServer::start_with_parser(config_for(dir)).await;
    let session = server
        .manager
        .spawn(&dir.to_string_lossy())
        .expect("セッションを起動できること");

    // 本物と同じ形（<sid>.jsonl）にする。パーサはここから subagents/ の場所を導く
    let transcript = dir.join("session.jsonl");
    let payload = serde_json::json!({
        "session_id": "11111111-2222-3333-4444-555555555555",
        "transcript_path": transcript.to_string_lossy(),
        "hook_event_name": "SessionStart",
    });
    let status = server
        .post_hook(session.token(), "SessionStart", &payload.to_string())
        .await;
    assert_eq!(status, 204, "フックが受理されること");

    (server, session, transcript)
}

#[tokio::test]
async fn フックが運んだJSONLをパーサが読んで履歴が届く() {
    let dir = work_dir("basic");
    let (_server, session, transcript) = start_session_with_transcript(&dir).await;

    append(&transcript, &sample_lines());
    let nodes = wait_for_nodes(&session, 3).await;

    let kinds: Vec<&str> = nodes
        .iter()
        .map(|node| match node.node {
            Node::UserMessage { .. } => "user",
            Node::AssistantText { .. } => "assistant",
            Node::ToolCall { .. } => "tool",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, vec!["user", "assistant", "tool"]);

    // ツールコールは直前のアシスタント本文にぶら下がる（掘れる表示の土台）
    assert_eq!(nodes[2].parent.as_ref(), Some(&nodes[1].id));
}

#[tokio::test]
async fn ファイルが後から現れてもエラーにならない() {
    // transcript_path はフックが先に運んでくるが、その時点でファイルはまだ無い。
    // 「無い＝異常」と扱うと構造化ビューが起動直後に必ず壊れる（フェーズ2の実測）
    let dir = work_dir("late-file");
    let (_server, session, transcript) = start_session_with_transcript(&dir).await;

    assert!(!transcript.exists(), "この時点ではまだファイルが無い");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(session.transcript_snapshot().is_empty());

    append(&transcript, &sample_lines());
    let nodes = wait_for_nodes(&session, 3).await;
    assert_eq!(nodes.len(), 3, "後から現れたファイルを読める");
}

#[tokio::test]
async fn ツールコールの結果は同じノードを更新して届く() {
    let dir = work_dir("tool-result");
    let (_server, session, transcript) = start_session_with_transcript(&dir).await;

    append(&transcript, &sample_lines());
    let before = wait_for_nodes(&session, 3).await;
    let tool_id = before[2].id.clone();
    assert!(matches!(
        before[2].node,
        Node::ToolCall {
            status: protocol::ToolStatus::Pending,
            ..
        }
    ));

    append(&transcript, &[result_line()]);
    for _ in 0..200 {
        let nodes = session.transcript_snapshot();
        let updated = nodes.iter().find(|node| node.id == tool_id);
        if let Some(node) = updated {
            if let Node::ToolCall { status, .. } = &node.node {
                if *status == protocol::ToolStatus::Ok {
                    // 結果が届いても件数は増えない（上書きであって追加ではない）
                    assert_eq!(nodes.len(), 3, "同じノードが二重に積まれていない");
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("ツールコールの結果が反映されませんでした");
}

#[tokio::test]
async fn 巻き戻りを検知したら履歴を捨てる() {
    // `/rewind` でファイルが縮んだときの防御。捨てずに続けると、消えたはずの
    // やり取りが画面に残り続ける
    let dir = work_dir("reset");
    let (_server, session, transcript) = start_session_with_transcript(&dir).await;

    append(&transcript, &sample_lines());
    wait_for_nodes(&session, 3).await;

    std::fs::write(&transcript, "").expect("縮められること");
    for _ in 0..200 {
        if session.transcript_snapshot().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("巻き戻りを検知しても履歴が残ったままです");
}

#[tokio::test]
async fn 履歴のRESTページングが遡れる() {
    let dir = work_dir("paging");
    let (server, session, transcript) = start_session_with_transcript(&dir).await;

    append(&transcript, &sample_lines());
    let nodes = wait_for_nodes(&session, 3).await;

    // 起点の指定なし＝手元の最新から
    let (status, body) = server
        .get(&format!("/api/sessions/{}/transcript", session.card_id))
        .await;
    assert_eq!(status, 200);
    let page: serde_json::Value = serde_json::from_str(&body).expect("JSON が返ること");
    assert_eq!(page["nodes"].as_array().unwrap().len(), 3);

    // 2件目より前＝1件目だけ
    let (status, body) = server
        .get(&format!(
            "/api/sessions/{}/transcript?before={}",
            session.card_id, nodes[1].id.0
        ))
        .await;
    assert_eq!(status, 200);
    let page: serde_json::Value = serde_json::from_str(&body).expect("JSON が返ること");
    let returned = page["nodes"].as_array().unwrap();
    assert_eq!(returned.len(), 1, "起点={} 応答={body}", nodes[1].id.0);
    assert_eq!(returned[0]["id"].as_str().unwrap(), nodes[0].id.0);
}

#[tokio::test]
async fn 知らないカードの履歴は404になる() {
    let dir = work_dir("not-found");
    let server = TestServer::start_with_parser(config_for(&dir)).await;
    let (status, _) = server
        .get(&format!(
            "/api/sessions/{}/transcript",
            protocol::CardId::new()
        ))
        .await;
    assert_eq!(status, 404);
}
