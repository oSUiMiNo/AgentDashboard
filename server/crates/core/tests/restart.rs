//! サーバだけを再起動したときの見え方（テスト計画フェーズ2「ローカルモードの履歴永続」）。
//!
//! # 何が新しくなったのか
//!
//! フェーズ1 まで、カードの実体はメモリの `HashMap` だけだった。プロセスが死ねば一覧も
//! 履歴も消え、同時に子プロセスの claude も死ぬので**両方いっぺんに消えて辻褄が合って
//! いた**。フェーズ2 で DB が真実になり、片方（記録）だけが生き残るようになった。
//!
//! | | 再起動前 | 再起動後 |
//! |---|---|---|
//! | claude・PTY | 生きている | **死んでいる**（子プロセスなので道連れ。設計§1-3 の既知の制約） |
//! | カードの記録 | ある | **ある**（DB に書いてあるので消えない） |
//!
//! だから戻ってきたカードは「履歴だけが読める抜け殻」になる。**それを隠さずに出す**
//! （利用者判断）——`agent_connected=false` を立てて鮮度が落ちていることを示し、
//! `status` は最後の既知状態のまま残す。リモートの接続断（設計§6-3）と同じ扱い。
//!
//! ローカルでも PTY を生き残らせる案（エージェントを別プロセスで常駐させる）は
//! 設計§16-2 の持ち越し。ここではそれが**入っていない**ことを前提に固める。

mod common;

use protocol::SessionStatus;
use std::time::Duration;

/// 同じ DB を指す設定を2つ作るための下ごしらえ。
fn config_for(label: &str) -> agentdashboard_core::config::Config {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-restart-{label}-{}",
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

#[tokio::test]
async fn サーバだけ再起動するとカードは戻り履歴も読めるが操作はできない() {
    let config = config_for("restore");

    // --- 1回目の起動 ---------------------------------------------------------
    //
    // **わざと終了させない。** 終了させると `Ended` が最後の既知状態になり、
    // 「作業中のまま戻ってくる」という肝心の見え方が確かめられなくなる。
    // セッションの控えだけ持ち越して、サーバは畳む（＝サーバだけが死んだ状態）
    let session = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _watcher) = common::start_session(&server.manager).await;
        server
            .post_hook(session.token(), "UserPromptSubmit", "{}")
            .await;
        common::wait_for_status(&session, SessionStatus::Working).await;
        server
            .wait_for_listed("1枚が作業中", |listed| {
                listed.len() == 1 && listed[0].status == SessionStatus::Working
            })
            .await;
        server
            .registry
            .get(session.card_id)
            .expect("記録があること");
        session
    };
    let card_id = session.card_id;
    // 落ちきるのを待つ。書き込みの途中で DB を掴んだまま消えると、次の起動が
    // 「壊れているのか、まだ書いている途中なのか」を区別できない
    tokio::time::sleep(Duration::from_millis(200)).await;

    // --- 2回目の起動（同じ DB を指す）----------------------------------------
    let server = common::TestServer::start_with(config).await;

    let (status, body) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
    let listed: Vec<protocol::SessionMeta> =
        serde_json::from_str(&body).expect("SessionMeta の配列として読めること");

    assert_eq!(listed.len(), 1, "前回のカードが戻っていない: {body}");
    assert_eq!(listed[0].card_id, card_id);
    assert!(
        !listed[0].agent_connected,
        "PTY は道連れで死んでいるのに、繋がっているように見えている"
    );
    // 状態は書き換えない。「最後に知っていた状態＋鮮度が落ちている印」が要件2-3 の充足形
    assert_eq!(listed[0].status, SessionStatus::Working);

    // 履歴の口も開いている（パーサに聞かず DB から返す。設計§3-3）
    let (status, _) = server
        .get(&format!("/api/sessions/{card_id}/transcript"))
        .await;
    assert_eq!(status, 200, "履歴が読めない");

    // ただし実体は居ないので、操作は断られる
    assert!(
        server.manager.get(card_id).is_none(),
        "死んだはずのセッションが実体として残っている"
    );

    // 持ち越した控えで擬似 claude を畳む（実運用ではサーバと道連れに死ぬ）
    session.kill();
}

#[tokio::test]
async fn 外したカードは再起動しても戻らない() {
    // 記録は残す（履歴を失わせない）が、一覧へは出さない。**利用者が消したものが
    // 再起動で復活する**のは、記録が残ることの利点ではなく害になる
    let config = config_for("archived");

    {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _watcher) = common::start_session(&server.manager).await;
        server
            .wait_for_listed("1枚出る", |listed| listed.len() == 1)
            .await;

        server.manager.archive(session.card_id).expect("外せること");
        server
            .wait_for_listed("空になる", |listed| listed.is_empty())
            .await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let server = common::TestServer::start_with(config).await;
    let (status, body) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
    assert_eq!(body.trim(), "[]", "外したカードが戻ってきた: {body}");
}

#[tokio::test]
async fn パーサが居なくても履歴は返る() {
    // 設計§3-3 の改善点。初期実装では、窓から落ちた範囲をパーサに JSONL を読み直して
    // もらっていたので、**パーサが縮退すると遡れず 503** だった。読み先が DB へ変わり、
    // 「DB にある範囲は常に返せる」になった。
    //
    // ここではパーサを一切立てずに（＝いちばん強い縮退）確かめる
    let server = common::TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    server
        .wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;

    assert!(
        server.parser.is_none(),
        "この検証はパーサを立てない状態で行う"
    );

    let (status, body) = server
        .get(&format!(
            "/api/sessions/{}/transcript?limit=10",
            session.card_id
        ))
        .await;
    assert_eq!(
        status, 200,
        "パーサが居ないだけで遡れなくなっている: {body}"
    );
    assert!(body.contains("\"nodes\""), "ページの形で返ること: {body}");

    session.kill();
}

#[tokio::test]
async fn 画面から変えた設定は再起動しても残る() {
    // 検収条件「〜設定でき、アプリ再起動後も保持される」（設計§13-1）。
    // 置き場所を DB にした狙いがこれで、**同じ DB を指す2回目の起動で読めること**が
    // 満たされた形にあたる（`config.toml` へ書き戻す必要が無い）
    let config = config_for("settings");

    {
        let server = common::TestServer::start_with(config.clone()).await;
        let (status, body) = server
            .put(
                "/api/settings",
                &serde_json::json!({
                    "sync_interval_secs": 5,
                    "screen_interval_ms": 1000,
                    "scrollback_lines": 300,
                })
                .to_string(),
            )
            .await;
        // 設定の持ち主（`config.toml` 側）は立てていないので、応答は DB のぶんだけ。
        // 保存そのものは通る
        assert_eq!(status, 200, "保存できない: {body}");
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let server = common::TestServer::start_with(config).await;
    let intervals = server.registry_intervals().await.expect("間隔を読めること");
    assert_eq!(intervals.sync_interval_secs, 5);
    assert_eq!(intervals.screen_interval_ms, 1000);
    assert_eq!(intervals.scrollback_lines, 300);
}
