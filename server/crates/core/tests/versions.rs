//! 版を見る口と消す口（CICD設計§12・§13・§14、テスト計画フェーズ2・3）。
//!
//! 一覧の中身そのもの（3本の版が揃うか・並び順）は `agent-core` の単体で固めてある。
//! ここで見るのは**口としての振る舞い**——使えない構成では出さないこと、錠が効くこと、
//! 消した結果が次の一覧へ反映されること。
//!
//! # 使える構成の道を通すには上書きが要る
//!
//! テストは箱の中で走る（`scripts/cargo` は docker の中で cargo を動かす）ので、
//! 自動判定は必ず「使えない」に倒れる。上書き口が無いと有効側の道を一度も通せない
//! （設計§21-4）。
//!
//! # 置き場所は共通の土台が使い捨てへ向けている
//!
//! 既定の `state_dir` は**利用者の本物の状態ディレクトリ**なので、素直に立てると
//! テストが実環境の保管庫を読み書きする。個々のテストの心がけに頼らないよう、
//! `common::TestServer` 側で使い捨てへ倒してある（`database_url` と同じ扱い）。

#![allow(non_snake_case)]

mod common;

use agent_core::version::{self, VERSION_SUPPORTED_ENV};
use protocol::VersionId;
use std::path::Path;

/// 版を名乗るだけの一式を保管庫へ置く。
fn write_stored_version(state_dir: &Path, version: &str) {
    let dir = version::versions_dir(state_dir).join(version);
    std::fs::create_dir_all(&dir).expect("保管庫を作れること");
    for name in version::BINARIES {
        let path = dir.join(name);
        let body = if name == "transcript-parser" {
            format!("#!/bin/sh\nprintf '{{\"ev\":\"hello\",\"parser_version\":\"{version}\"}}\\n'\n")
        } else {
            format!("#!/bin/sh\necho '{name} {version}'\n")
        };
        std::fs::write(&path, body).expect("書けること");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("実行できる形にできること");
        }
    }
}

/// 使える構成のふりをする。
///
/// nextest はテストごとに別プロセスなので、ここで立てても他のテストへは漏れない。
fn pretend_supported() {
    unsafe { std::env::set_var(VERSION_SUPPORTED_ENV, "1") };
}

async fn view(server: &common::TestServer) -> serde_json::Value {
    let (status, body) = server.get("/api/versions").await;
    assert_eq!(status, 200, "一覧を読めない: {body}");
    serde_json::from_str(&body).expect("VersionsView として読めること")
}

#[tokio::test]
async fn 使えない構成では機能ごと出さない() {
    // できないことをボタンにしない（設計§14）。走査そのものを省く
    unsafe { std::env::set_var(VERSION_SUPPORTED_ENV, "0") };
    let server = common::TestServer::start().await;

    let view = view(&server).await;
    assert_eq!(view["supported"], false);
    assert_eq!(
        view["entries"].as_array().map(Vec::len),
        Some(0),
        "出さないと決めた構成で中身を返している"
    );
}

#[tokio::test]
async fn 保管庫の版が一覧に並ぶ() {
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");

    let view = view(&server).await;
    assert_eq!(view["supported"], true);
    let entries = view["entries"].as_array().expect("一覧があること");
    let found = entries
        .iter()
        .find(|entry| entry["version"] == "0.1.1")
        .unwrap_or_else(|| panic!("置いた版が並んでいない: {entries:?}"));
    assert_eq!(found["origin"], "stored");
    assert_eq!(found["usable"], true, "3本とも同じ版を名乗っている");
    assert_eq!(found["selected"], false, "まだ選んでいない");
    assert_eq!(view["selected"], serde_json::Value::Null);
}

#[tokio::test]
async fn 選んでいる版は一覧の外にも出る() {
    // 「いま走っている版」と「次に起こす版」は別物なので、選択中の印だけでは
    // 「押しても何も起きない」ように見える（設計§14）
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");
    version::write_pointer(
        &state_dir,
        Some(&version::versions_dir(&state_dir).join("0.1.1").join("agentdashboard")),
    );

    let view = view(&server).await;
    assert_eq!(view["selected"], "0.1.1");
}

#[tokio::test]
async fn 消すと一覧から消えてポインタも外れる() {
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");
    version::write_pointer(
        &state_dir,
        Some(&version::versions_dir(&state_dir).join("0.1.1").join("agentdashboard")),
    );

    let (status, body) = server.request("DELETE", "/api/versions/0.1.1", None).await;
    assert_eq!(status, 200, "消せない: {body}");

    let view: serde_json::Value = serde_json::from_str(&body).expect("応答が一覧であること");
    assert!(
        !view["entries"]
            .as_array()
            .expect("一覧があること")
            .iter()
            .any(|entry| entry["version"] == "0.1.1"),
        "消したのに並んでいる: {view}"
    );
    assert_eq!(view["selected"], serde_json::Value::Null, "予約も外れる");
    assert_eq!(
        version::read_pointer(&state_dir),
        None,
        "既定へ落ちていない"
    );
}

#[tokio::test]
async fn 保管庫にない版は無いと言う() {
    // 「消せない」と「そもそも無い」を呼び分ける
    let server = common::TestServer::start().await;
    let (status, body) = server.request("DELETE", "/api/versions/9.9.9", None).await;
    assert_eq!(status, 404, "実際: {body}");
}

#[tokio::test]
async fn 錠を取っている間の操作は断られる() {
    // 錠は**プロセスをまたぐ**（落として、新しいプロセスが立ち上がってくる）ので、
    // プロセスの中の錠では足りない
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_stored_version(&state_dir, "0.1.1");

    version::acquire_lock(&state_dir).expect("先に取れること");

    let (status, body) = server.request("DELETE", "/api/versions/0.1.1", None).await;
    assert_eq!(status, 409, "二重の操作が通ってしまった: {body}");
    assert!(body.contains("動いています"), "理由を書く: {body}");

    // 返せば通る
    version::release_lock(&state_dir);
    let (status, body) = server.request("DELETE", "/api/versions/0.1.1", None).await;
    assert_eq!(status, 200, "返したのに断られた: {body}");
}

#[tokio::test]
async fn 前回の結末は繋いだ瞬間に読める() {
    // **知らせではなく状態として持つ**（設計§11）。新しい版が起動できなかったことは
    // ブラウザが繋がる前に決まるので、流すだけでは誰にも届かない
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    version::write_outcome(
        &state_dir,
        &version::Outcome {
            attempted: Some(VersionId::new("0.2.0")),
            attempted_path: "/どこか/agentdashboard".to_string(),
            running: VersionId::new("0.1.1"),
            failed_reason: Some("起動できませんでした".to_string()),
            at: 1,
        },
    );

    let view = view(&server).await;
    assert_eq!(view["outcome"]["attempted"], "0.2.0");
    assert_eq!(view["outcome"]["failed_reason"], "起動できませんでした");
}

#[tokio::test]
async fn 最後に読めた最新版が一覧に載る() {
    // **この口は見に行かない**（設計§8）。外へ出るのは背景の周期だけで、ここは
    // 最後に読めた値を返すだけ——さもないと画面を開くたびにネットワークが要る
    pretend_supported();
    let server = common::TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();

    // 一度も見に行けていなければ載らない
    assert!(view(&server).await["latest"].is_null());

    agent_core::version_ops::record_latest(
        &state_dir,
        &agent_core::version_ops::Latest {
            version: VersionId::new("0.9.0"),
            prerelease: false,
            has_artifact: true,
        },
        1_234,
    );

    let view = view(&server).await;
    assert_eq!(view["latest"]["version"], "0.9.0");
    assert_eq!(view["latest"]["has_artifact"], true);
    assert_eq!(view["latest"]["checked_at"], 1_234);
    // **新着かどうかはサーバが決めない。** 画面が「走っている版より新しいか」で決める
    assert!(
        view["latest"].get("is_new").is_none(),
        "サーバが新着かどうかを決めてしまっている"
    );
}
