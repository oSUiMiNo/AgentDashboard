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
//! ローカルでも PTY を生き残らせる案（セッションホストを別プロセスで常駐させる）は
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

// ---------------------------------------------------------------------------
// 抜け殻のカードを起こし直す（接続断のカードを復旧ボタンで戻す テスト計画フェーズ3
// 「ローカルで戻る」）。
//
// **押す道は CLI しか無い段**なので、ここは `client::revive` を通す。画面（フェーズ4）
// より先に道が通るのが、この段の値打ちそのものである。
// ---------------------------------------------------------------------------

/// 起こして、フックで呼び戻し先（`claude_session_id`）まで確定させる。
///
/// **確定させないと戻せない。** 起動しただけのカードは呼び戻し先を持たず、
/// 「戻す先が記録されていません」に落ちる（設計§3-2）。
async fn 呼び戻し先つきで起こす(
    server: &common::TestServer,
) -> (
    std::sync::Arc<session_host_core::session::Session>,
    protocol::ClaudeSessionId,
) {
    let (session, _watcher) = common::start_session(&server.manager).await;
    let claude_session_id = protocol::ClaudeSessionId::new();
    server
        .post_hook(
            session.token(),
            "SessionStart",
            &format!(r#"{{"session_id":"{claude_session_id}"}}"#),
        )
        .await;
    server
        .wait_for_listed("呼び戻し先が載る", |listed| {
            listed
                .iter()
                .any(|meta| meta.claude_session_id == Some(claude_session_id))
        })
        .await;
    (session, claude_session_id)
}

fn target_of(server: &common::TestServer) -> agentdashboard_core::client::Target {
    agentdashboard_core::client::Target::from_url(&format!("http://{}", server.addr))
        .expect("接続先を読めること")
}

#[tokio::test]
async fn 抜け殻のカードは同じidのまま起こし直せる() {
    let config = config_for("revive");

    // --- 1回目：呼び戻し先まで確定させて、サーバだけ畳む ---------------------
    let (card_id, claude_session_id, before) = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, claude_session_id) = 呼び戻し先つきで起こす(&server).await;
        let card_id = session.card_id;
        // 履歴が「続きから読める」ことを言うために、畳む前の中身を控える
        let (_, before) = server
            .get(&format!("/api/sessions/{card_id}/transcript"))
            .await;
        session.kill();
        (card_id, claude_session_id, before)
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    // --- 2回目：抜け殻になっているのを確かめてから、起こし直す ---------------
    let server = common::TestServer::start_with(config).await;
    let listed = server
        .wait_for_listed("抜け殻が1枚戻る", |listed| listed.len() == 1)
        .await;
    assert!(!listed[0].agent_connected, "抜け殻として戻っていない");
    assert!(
        listed[0].revivable(),
        "戻せる状態として見えていない: {:?}",
        listed[0]
    );
    assert!(
        server.manager.get(card_id).is_none(),
        "実体が居るなら、この検査は何も確かめていない"
    );

    let target = target_of(&server);
    agentdashboard_core::client::revive(&target, &card_id.to_string())
        .await
        .expect("起こし直せること");

    // **同じ CardId のまま実体が戻る。** 採番していたら、抜け殻の隣に2枚目ができる
    let listed = server
        .wait_for_listed("繋がった1枚になる", |listed| {
            listed.len() == 1 && listed[0].agent_connected
        })
        .await;
    assert_eq!(listed[0].card_id, card_id, "別のカードとして起きている");
    assert!(
        server.manager.get(card_id).is_some(),
        "実体が戻っていない（記録だけが更新されている）"
    );
    // 頼んだ呼び戻し先を**最初から持っている**（設計§7-3）。フックが1件も届かないまま
    // 失敗しても、戻す先を失わないことの担保
    assert_eq!(
        listed[0].claude_session_id,
        Some(claude_session_id),
        "呼び戻し先が消えている"
    );

    // 履歴は同じカードのものが続けて読める（頭から作り直されていない）
    let (status, after) = server
        .get(&format!("/api/sessions/{card_id}/transcript"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(after, before, "起こし直しで履歴が作り直されている");

    // 抜け殻でなくなったので、ふつうの操作が効く
    let session = server.manager.get(card_id).expect("実体があること");
    agentdashboard_core::client::kill(&target, &card_id.to_string())
        .await
        .expect("終了させられること");
    session.kill();
}

#[tokio::test]
async fn 動いているカードは起こし直せない() {
    // **画面はボタンを出さないだけ**で、CLI には効かない。走っているカードへ撃つと
    // 向こう側は古い実体を畳んでから起こし直す——要件が守りたいものと正反対になる
    // （設計§3-5）
    let server = common::TestServer::start_with(config_for("revive-live")).await;
    let (session, _id) = 呼び戻し先つきで起こす(&server).await;
    let target = target_of(&server);

    let err = agentdashboard_core::client::revive(&target, &session.card_id.to_string())
        .await
        .expect_err("断ること");
    assert!(
        err.to_string().contains("動いています"),
        "理由が「動いている」と読めない: {err}"
    );
    // 巻き添えにしていない
    assert!(
        server.manager.get(session.card_id).is_some(),
        "断ったのに実体が畳まれている"
    );
    session.kill();
}

#[tokio::test]
async fn 呼び戻す先の無いカードは起こし直せない() {
    // **ふつうに起こしたカードはここへ来ない。** ダッシュボードが `--session-id` を採番して
    // 渡すので、起動した時点で呼び戻し先を持っている（設計§15-4 で実機を数えたときも0枚
    // だった）。それでも記録の形の上では `NULL` を取りうるので、**通ったときに何が起きるか
    // を言えるようにしておく**。
    //
    // 製品の経路では作れない状態なので、記録へ直に1枚置いて作る。
    let server = common::TestServer::start_with(config_for("revive-noid")).await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    let listed = server
        .wait_for_listed("1枚出る", |listed| listed.len() == 1)
        .await;

    let mut 呼び戻し先なし = listed[0].clone();
    呼び戻し先なし.claude_session_id = None;
    呼び戻し先なし.agent_connected = false;
    let card_id = 呼び戻し先なし.card_id;
    server
        .registry
        .apply(
            &server_core::registry::ReportOrigin::local(),
            protocol::ws::ServerMessage::SessionUpsert {
                session: Box::new(呼び戻し先なし),
            },
        )
        .await;
    let listed = server
        .wait_for_listed("呼び戻し先が消える", |listed| {
            listed.len() == 1 && listed[0].claude_session_id.is_none()
        })
        .await;
    assert!(!listed[0].revivable(), "戻せる側に見えている");

    let target = target_of(&server);
    let err = agentdashboard_core::client::revive(&target, &card_id.to_string())
        .await
        .expect_err("断ること");
    assert!(
        err.to_string().contains("呼び戻す先"),
        "理由が「戻す先が無い」と読めない: {err}"
    );
    session.kill();
}

#[tokio::test]
async fn 外したカードは起こし直しの対象にならない() {
    // 一覧に出ないものは `--all` にも入らない。**利用者が消したものが復旧で蘇る**のは、
    // 記録が残ることの利点ではなく害になる
    let config = config_for("revive-archived");
    {
        let server = common::TestServer::start_with(config.clone()).await;
        // 呼び戻し先まで確定させる。**戻せる材料が揃っているのに対象外**であることが
        // このテストの主張で、材料が無いだけなら別の理由で通ってしまう
        let (session, _claude_session_id) = 呼び戻し先つきで起こす(&server).await;
        server.manager.archive(session.card_id).expect("外せること");
        server
            .wait_for_listed("空になる", |listed| listed.is_empty())
            .await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let server = common::TestServer::start_with(config).await;
    let target = target_of(&server);
    let outcome = agentdashboard_core::client::revive_all(&target)
        .await
        .expect("0枚でも失敗にはしないこと");
    assert!(
        outcome.human.contains("ありません"),
        "0枚だと言っていない: {}",
        outcome.human
    );
}
