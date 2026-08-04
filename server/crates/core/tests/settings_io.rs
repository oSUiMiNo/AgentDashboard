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

/// 書き出して読み戻すと元の状態へ戻ること（持ち出し設計§7・§8）。
///
/// **持ち出しの目的そのもの。** ここが通らないなら、書き出しか読み込みのどちらかが
/// 4つ揃っていない。
#[tokio::test]
async fn 書き出して読み戻すと元へ戻る() {
    let (server, dir) = server().await;

    // 元の状態を作る（既定とは違う値にしておかないと、戻ったのか判別できない）
    let (status, _) = server
        .put(
            "/api/settings",
            r#"{"always_bypass_permissions":true,"sync_interval_secs":5,
                "screen_interval_ms":1000,"scrollback_lines":4000}"#,
        )
        .await;
    assert_eq!(status, 200);

    let (status, exported) = server.get("/api/settings/export").await;
    assert_eq!(status, 200, "{exported}");
    assert!(exported.contains("agentdashboard-settings"), "{exported}");

    // 4つとも別の値へ変える
    let (status, _) = server
        .put(
            "/api/settings",
            r#"{"always_bypass_permissions":false,"sync_interval_secs":60,
                "screen_interval_ms":20000,"scrollback_lines":1000}"#,
        )
        .await;
    assert_eq!(status, 200);

    // 読み戻す
    let (status, body) = server
        .request("POST", "/api/settings/import", Some(&exported))
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"applied\""), "{body}");
    assert!(body.contains("\"ignored\":[]"), "{body}");

    let (_, body) = server.get("/api/settings").await;
    assert!(
        body.contains("\"always_bypass_permissions\":true"),
        "{body}"
    );
    assert!(body.contains("\"sync_interval_secs\":5"), "{body}");
    assert!(body.contains("\"screen_interval_ms\":1000"), "{body}");
    assert!(body.contains("\"scrollback_lines\":4000"), "{body}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 書き出しに入るのはアカウントの4つだけで、秘密もサーバ全体のものも入らないこと
/// （持ち出し設計§7）。
#[tokio::test]
async fn 書き出しにはアカウントの設定しか入らない() {
    let (server, dir) = server().await;

    let (_, exported) = server.get("/api/settings/export").await;
    let value: serde_json::Value = serde_json::from_str(&exported).expect("JSON であること");
    let settings = value["settings"].as_object().expect("settings があること");

    let mut keys: Vec<&str> = settings.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "always_bypass_permissions",
            "screen_interval_ms",
            "scrollback_lines",
            "sync_interval_secs"
        ],
        "持ち出しの顔ぶれが変わっている: {exported}"
    );

    // 秘密は名前すら現れないこと（値だけでなくキーでも）
    for forbidden in ["lan_password", "update_check", "pairing", "token"] {
        assert!(
            !exported.contains(forbidden),
            "{forbidden} が書き出しへ混ざっている: {exported}"
        );
    }

    let _ = std::fs::remove_dir_all(dir);
}

/// 関係ないファイルを選んだら断り、**何も書き換えないこと**（持ち出し設計§9）。
#[tokio::test]
async fn 関係ないファイルは断られ何も変わらない() {
    let (server, dir) = server().await;
    let (_, before) = server.get("/api/settings").await;

    for text in [
        "これは JSON ではない",
        r#"{"port":8787}"#,
        r#"{"kind":"something-else","format":1,"settings":{}}"#,
    ] {
        let (status, body) = server
            .request("POST", "/api/settings/import", Some(text))
            .await;
        assert_eq!(status, 400, "断られること: {body}");
    }

    let (_, after) = server.get("/api/settings").await;
    assert_eq!(after, before, "断ったのに書き換わっている");

    let _ = std::fs::remove_dir_all(dir);
}

/// 1つでも駄目なら何も入らず、理由にキーの名前が出ること（持ち出し設計§9）。
#[tokio::test]
async fn 一部が駄目なファイルは丸ごと断られる() {
    let (server, dir) = server().await;
    let (_, before) = server.get("/api/settings").await;

    let text = r#"{"kind":"agentdashboard-settings","format":1,"settings":{
        "sync_interval_secs": 5,
        "scrollback_lines": 0
    }}"#;
    let (status, body) = server
        .request("POST", "/api/settings/import", Some(text))
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("scrollback_lines"), "{body}");

    let (_, after) = server.get("/api/settings").await;
    assert_eq!(after, before, "半分だけ入ってはいけない");

    let _ = std::fs::remove_dir_all(dir);
}

/// 知らないキーは無視して読み込み、**無視したことを伝えること**（持ち出し設計§9）。
#[tokio::test]
async fn 知らないキーは無視して伝える() {
    let (server, dir) = server().await;

    let text = r#"{"kind":"agentdashboard-settings","format":1,"settings":{
        "sync_interval_secs": 10,
        "未来のキー": 1
    }}"#;
    let (status, body) = server
        .request("POST", "/api/settings/import", Some(text))
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains("未来のキー"),
        "無視したことが伝わること: {body}"
    );

    // 入っていないキーは触られないこと（既定で埋めない）
    let (_, body) = server.get("/api/settings").await;
    assert!(body.contains("\"sync_interval_secs\":10"), "{body}");
    assert!(body.contains("\"scrollback_lines\":1000"), "{body}");

    let _ = std::fs::remove_dir_all(dir);
}
