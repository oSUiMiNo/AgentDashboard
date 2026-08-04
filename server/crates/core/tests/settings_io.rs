//! 設定の入口の検査と、ファイルへの持ち出し（持ち出し設計§7〜§13）。
//!
//! 相手は擬似 claude なので**課金なしで毎回走らせられる**。
//!
//! ここで見るのは「入口が違っても同じ答えになる」こと。画面からの `PUT` も、
//! ファイルからの読み込みも、同じ検査（`db::settings::check`）を通る。

mod common;

use agentdashboard_core::config::Config;
use std::path::PathBuf;

/// 設定画面を立てたサーバを1つ用意する。
async fn server() -> (common::TestServer, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-settings-io-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("置き場所を作れること");
    let path = dir.join("config.toml");
    std::fs::write(&path, "port = 8787\n").expect("書き出せること");
    let server = common::TestServer::start_with_settings(Config::default(), path).await;
    (server, dir)
}

/// 範囲の外は断り、理由にキーの名前が出ること（持ち出し設計§9）。
///
/// **画面は選択肢で値を絞っているが、REST は直に叩ける。** ここが通ると
/// 「休みなく送り続ける」設定が入る。
#[tokio::test]
async fn 範囲の外の値は断られる() {
    let (server, dir) = server().await;

    let (status, body) = server
        .put("/api/settings", r#"{"sync_interval_secs":0}"#)
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body.contains("sync_interval_secs"),
        "どのキーが駄目かが分かる文であること: {body}"
    );

    // 断ったのなら**何も書かれていない**こと
    let (_, body) = server.get("/api/settings").await;
    assert!(
        body.contains("\"sync_interval_secs\":20"),
        "断ったのに書き換わっている: {body}"
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// 型が違うものも断ること。
#[tokio::test]
async fn 型が違う値は断られる() {
    let (server, dir) = server().await;

    let (status, body) = server
        .put("/api/settings", r#"{"scrollback_lines":-1}"#)
        .await;
    // 負数は u64 として読めないので、そもそも本文の解釈で弾かれる
    assert!(status == 400 || status == 422, "status={status} {body}");

    let (status, body) = server
        .put("/api/settings", r#"{"screen_interval_ms":1}"#)
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("screen_interval_ms"), "{body}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 範囲の中なら通ること（絞りすぎていないこと）。
#[tokio::test]
async fn 画面の選択肢はすべて通る() {
    let (server, dir) = server().await;

    for seconds in [5, 10, 20, 60] {
        let (status, body) = server
            .put(
                "/api/settings",
                &format!(r#"{{"sync_interval_secs":{seconds}}}"#),
            )
            .await;
        assert_eq!(status, 200, "{seconds} 秒が通らない: {body}");
    }
    for millis in [50, 1000, 5000, 10000, 20000] {
        let (status, body) = server
            .put(
                "/api/settings",
                &format!(r#"{{"screen_interval_ms":{millis}}}"#),
            )
            .await;
        assert_eq!(status, 200, "{millis} ミリ秒が通らない: {body}");
    }

    let _ = std::fs::remove_dir_all(dir);
}
