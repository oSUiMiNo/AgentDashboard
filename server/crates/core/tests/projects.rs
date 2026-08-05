//! 追加した PJT 枠の増減（テスト計画 フェーズ3「枠の増減」「縮退」）。
//!
//! # なぜ REST まで通して見るのか
//!
//! `server-core/tests/db.rs` が確かめているのは**記録の決まり**（二重に入らない・
//! 持ち主で絞る・作り直し）で、ここが確かめるのは**口を叩いたときに何が起きるか**である。
//! 設計§11 の「書けてから配る」は、記録層だけを見ていても、口だけを見ていても分からない。
//!
//! # 配られたかどうかは記録層の知らせで見る
//!
//! ブラウザの役をするより、`registry` の知らせを直に受けるほうが確かめたいことに近い。
//! WebSocket を張ると「届いたか」に接続の都合が混ざる（テスト計画 フェーズ4 の担当）。

#![allow(non_snake_case)]

mod common;

use protocol::ws::ServerMessage;
use sea_orm::{ActiveValue::Set, EntityTrait as _};
use server_core::db;
use std::time::Duration;

fn config_for(label: &str) -> agentdashboard_core::config::Config {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-projects-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");

    agentdashboard_core::config::Config {
        state_dir: Some(dir.clone()),
        claude_settings_path: Some(dir.join("claude-settings.json")),
        database_url: Some(format!("sqlite://{}", dir.join("dashboard.db").display())),
        ..agentdashboard_core::config::Config::default()
    }
}

/// 枠の知らせだけを待つ。ほかの知らせ（カードの上下）は読み飛ばす。
async fn wait_for_project_event(
    events: &mut tokio::sync::broadcast::Receiver<server_core::registry::AccountEvent>,
    what: &str,
) -> ServerMessage {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!left.is_zero(), "{what} が配られない");
        match tokio::time::timeout(left, events.recv()).await {
            Ok(Ok(event)) => match event.message {
                message @ (ServerMessage::ProjectUpsert { .. }
                | ServerMessage::ProjectRemoved { .. }) => return message,
                _ => continue,
            },
            Ok(Err(err)) => panic!("{what} を待てない: {err}"),
            Err(_) => panic!("{what} が配られない"),
        }
    }
}

/// 枠の知らせが**来ないこと**を確かめる。
async fn expect_no_project_event(
    events: &mut tokio::sync::broadcast::Receiver<server_core::registry::AccountEvent>,
    what: &str,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return;
        }
        match tokio::time::timeout(left, events.recv()).await {
            Ok(Ok(event)) => {
                if matches!(
                    event.message,
                    ServerMessage::ProjectUpsert { .. } | ServerMessage::ProjectRemoved { .. }
                ) {
                    panic!("{what}: 書けていないのに配られた");
                }
            }
            // 何も来ないまま時間切れ＝期待どおり
            Ok(Err(_)) | Err(_) => return,
        }
    }
}

fn paths_of(body: &str) -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(body)
        .expect("枠の一覧を読めること")
        .into_iter()
        .map(|row| row["path"].as_str().expect("path があること").to_string())
        .collect()
}

#[tokio::test]
async fn 枠を足すと記録に残り知らせが配られる() {
    let server = common::TestServer::start_with(config_for("add")).await;
    let mut events = server.registry.subscribe_events();

    let (status, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(r#"{"host":"local","path":"/home/example/dev/app"}"#),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let added: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    assert_eq!(added["project"]["host"], "local");
    assert_eq!(added["project"]["path"], "/home/example/dev/app");
    // 設定を切っているあいだは起こさない（既定 OFF。設計§12）
    assert_eq!(added["spawned"], false);
    assert!(
        added.get("spawn_error").is_none(),
        "起こそうとしていないのに理由が付いている: {body}"
    );

    match wait_for_project_event(&mut events, "枠が増えたこと").await {
        ServerMessage::ProjectUpsert { project } => {
            assert_eq!(project.path, "/home/example/dev/app");
            assert_eq!(project.host, "local");
        }
        other => panic!("別の知らせが来た: {other:?}"),
    }

    let (status, body) = server.get("/api/projects").await;
    assert_eq!(status, 200);
    assert_eq!(paths_of(&body), vec!["/home/example/dev/app".to_string()]);

    // 二度押しても増えない（記録層のユニーク索引が効いている）
    let (status, _) = server
        .request(
            "POST",
            "/api/projects",
            Some(r#"{"host":"local","path":"/home/example/dev/app"}"#),
        )
        .await;
    assert_eq!(status, 200);
    let (_, body) = server.get("/api/projects").await;
    assert_eq!(paths_of(&body).len(), 1, "二度押しで増えた");
}

#[tokio::test]
async fn 枠を消すと記録から消え知らせが配られる() {
    let server = common::TestServer::start_with(config_for("remove")).await;

    let (_, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(r#"{"host":"local","path":"/home/example/dev/app"}"#),
        )
        .await;
    let added: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    let id = added["project"]["id"].as_str().expect("id があること");

    let mut events = server.registry.subscribe_events();
    let (status, body) = server
        .request("DELETE", &format!("/api/projects/{id}"), None)
        .await;
    assert_eq!(status, 204, "{body}");

    match wait_for_project_event(&mut events, "枠が消えたこと").await {
        ServerMessage::ProjectRemoved { project_id } => {
            assert_eq!(project_id.to_string(), id);
        }
        other => panic!("別の知らせが来た: {other:?}"),
    }

    let (_, body) = server.get("/api/projects").await;
    assert!(paths_of(&body).is_empty(), "消えていない: {body}");
}

#[tokio::test]
async fn セッションが居る枠は消せない() {
    // 走っている作業を巻き添えにしないため（設計§13）。押せない理由も返す
    let server = common::TestServer::start_with(config_for("busy")).await;
    let (_session, _watcher) = common::start_session(&server.manager).await;

    let project = server
        .wait_for_listed("1枚が載ること", |listed| listed.len() == 1)
        .await
        .first()
        .expect("カードが1枚")
        .project
        .0
        .clone();

    let (_, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(&serde_json::json!({ "host": "local", "path": project }).to_string()),
        )
        .await;
    let added: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    let id = added["project"]["id"].as_str().expect("id があること");

    let mut events = server.registry.subscribe_events();
    let (status, body) = server
        .request("DELETE", &format!("/api/projects/{id}"), None)
        .await;
    assert_eq!(status, 409, "セッションが居るのに消せた: {body}");
    assert!(
        body.contains("セッション"),
        "押せない理由が伝わらない: {body}"
    );
    expect_no_project_event(&mut events, "断られた削除").await;

    let (_, body) = server.get("/api/projects").await;
    assert_eq!(paths_of(&body).len(), 1, "断ったのに消えている");
}

#[tokio::test]
async fn 書けなかったものは配らない() {
    // 配ってから書くと、画面には出ているのに読み込み直すと消える——嘘をつくことになる。
    // ここでは「断られた要求」で確かめる：**記録が動いていないなら知らせも出ない**
    let server = common::TestServer::start_with(config_for("silent")).await;
    let mut events = server.registry.subscribe_events();

    // ① 知らない PC（他人の PC と同じ言葉で断る）
    let (status, _) = server
        .request(
            "POST",
            "/api/projects",
            Some(r#"{"host":"これはUUIDではない","path":"/x"}"#),
        )
        .await;
    assert_eq!(status, 404);

    // ② 登録されていない PC
    let (status, _) = server
        .request(
            "POST",
            "/api/projects",
            Some(&serde_json::json!({ "host": uuid::Uuid::new_v4(), "path": "/x" }).to_string()),
        )
        .await;
    assert_eq!(status, 404);

    // ③ 無い枠を消す
    let (status, _) = server
        .request(
            "DELETE",
            &format!("/api/projects/{}", uuid::Uuid::new_v4()),
            None,
        )
        .await;
    assert_eq!(status, 404);

    expect_no_project_event(&mut events, "断られた3つ").await;
    let (_, body) = server.get("/api/projects").await;
    assert!(paths_of(&body).is_empty(), "断ったのに増えている: {body}");
}

#[tokio::test]
async fn サーバを起こし直しても枠は残る() {
    // 要件「追加された PJT 枠はアプリを落として再起動しても保たれる」
    let config = config_for("persist");

    {
        let server = common::TestServer::start_with(config.clone()).await;
        let (status, _) = server
            .request(
                "POST",
                "/api/projects",
                Some(r#"{"host":"local","path":"/home/example/dev/app"}"#),
            )
            .await;
        assert_eq!(status, 200);
    }

    let server = common::TestServer::start_with(config).await;
    let (status, body) = server.get("/api/projects").await;
    assert_eq!(status, 200);
    assert_eq!(
        paths_of(&body),
        vec!["/home/example/dev/app".to_string()],
        "起こし直したら消えた"
    );
}

#[tokio::test]
async fn 繋がっていないpcの枠も足せて一覧に出る() {
    // 設計§17「枠そのものは必ず出す」。**帰属は記録で見る**ので、電源を切っている PC の
    // 枠も足せる——接続で判定すると、寝ている PC の枠を作れなくなる
    let server = common::TestServer::start_with(config_for("offline")).await;

    let agent = uuid::Uuid::new_v4();
    db::entity::agents::Entity::insert(db::entity::agents::ActiveModel {
        id: Set(agent),
        account_id: Set(db::LOCAL_ACCOUNT_ID),
        name: Set("寝ているノート".to_string()),
        created_at: Set(1),
        last_seen_at: Set(None),
        model_table: Set(None),
        capabilities: Set(None),
    })
    .exec(server.registry.db())
    .await
    .expect("PC を登録できること");

    let (status, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(
                &serde_json::json!({ "host": agent, "path": "/home/example/dev/app" }).to_string(),
            ),
        )
        .await;
    assert_eq!(status, 200, "繋がっていない PC の枠を作れない: {body}");

    let (_, body) = server.get("/api/projects").await;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&body).expect("読めること");
    assert_eq!(rows.len(), 1);
    // 画面はこの `host` をそのまま REST のパスへ載せる
    assert_eq!(rows[0]["host"], agent.to_string());
}

/// 設定が ON なら、枠を足したその場でセッションが**1本だけ**起きること（設計§12）。
///
/// **数を見るのが要点。** 「起きたこと」だけを見ると、2本起こしていても通ってしまう。
#[tokio::test]
async fn 設定がonなら追加と同時に1本だけ起きる() {
    let server = common::TestServer::start_with(config_for("autostart-on")).await;

    let (status, body) = server
        .put("/api/settings", r#"{"project_autostart_session":true}"#)
        .await;
    assert_eq!(status, 200, "{body}");

    let (status, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(r#"{"host":"local","path":"/tmp"}"#),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let added: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    assert_eq!(
        added["spawned"], true,
        "起こしたことが応答に載らない: {body}"
    );
    assert!(
        added.get("spawn_error").is_none(),
        "起きたのに理由が付いている: {body}"
    );

    let listed = server
        .wait_for_listed("1枚が載ること", |listed| !listed.is_empty())
        .await;
    assert_eq!(listed.len(), 1, "1本だけのはずが {} 本", listed.len());
    assert_eq!(listed[0].project.0, "/tmp");

    // 枠も残っていること（枠が先、セッションは後）
    let (_, body) = server.get("/api/projects").await;
    assert_eq!(paths_of(&body), vec!["/tmp".to_string()]);
}

/// 設定が OFF なら、枠だけが増えてセッションは起きないこと（設計§12）。
#[tokio::test]
async fn 設定がoffなら枠だけが増える() {
    let server = common::TestServer::start_with(config_for("autostart-off")).await;

    // 既定が OFF であることも一緒に見る（明示的に切らずに足す）
    let (status, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(r#"{"host":"local","path":"/tmp"}"#),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["spawned"],
        false
    );

    // **「まだ起きていない」と「起きない」は待たないと区別できない。**
    // カードが載るのを待つ形にすると、載らないことを確かめようがない
    tokio::time::sleep(Duration::from_millis(600)).await;
    let (_, listed) = server.get("/api/sessions").await;
    assert_eq!(
        serde_json::from_str::<Vec<serde_json::Value>>(&listed)
            .expect("一覧を読めること")
            .len(),
        0,
        "切っているのに起きた: {listed}"
    );

    let (_, body) = server.get("/api/projects").await;
    assert_eq!(paths_of(&body), vec!["/tmp".to_string()]);
}

/// 起こせなくても枠は残り、**理由が応答に載る**こと（設計§26-1）。
///
/// 消してしまうと、PC が寝ているだけなのに「追加そのものが失敗した」ように見える。
#[tokio::test]
async fn 起こせなくても枠は残り理由が返る() {
    let server = common::TestServer::start_with(config_for("autostart-fail")).await;

    let (status, _) = server
        .put("/api/settings", r#"{"project_autostart_session":true}"#)
        .await;
    assert_eq!(status, 200);

    // 存在しないフォルダ＝起こせない。枠のほうは**パスの実在を見ない**ので足せる
    let (status, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(r#"{"host":"local","path":"/存在しないはずのフォルダ"}"#),
        )
        .await;
    assert_eq!(status, 200, "起こせないだけで枠まで断られた: {body}");

    let added: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    assert_eq!(added["spawned"], false, "{body}");
    let reason = added["spawn_error"]
        .as_str()
        .unwrap_or_else(|| panic!("理由が載っていない: {body}"));
    assert!(!reason.is_empty(), "理由が空: {body}");

    let (_, body) = server.get("/api/projects").await;
    assert_eq!(
        paths_of(&body),
        vec!["/存在しないはずのフォルダ".to_string()],
        "起こせなかったせいで枠まで消えている"
    );
}
