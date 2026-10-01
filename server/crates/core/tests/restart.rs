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

/// 空きが足りない機械（床を切らせて断らせるため）。
#[derive(Debug)]
struct 足りないメモリ;

impl session_host_core::resources::Probe for 足りないメモリ {
    fn read(&self) -> Option<session_host_core::resources::Memory> {
        Some(session_host_core::resources::Memory {
            total_mb: 16_000,
            available_mb: 1_000,
            swap_free_mb: 0,
            free_mb: 1_000,
        })
    }
}

/// ローカルモードの起こし直しの断りは `revive` 種別で配られる（寝ているカードばかりなのに、
/// メモリ不足でセッションを起こせない 設計§6-2）。
///
/// 画面は押し直したときに `revive` の断りだけを消すので、`Other` で配ると実機では
/// 押し直しても古い断りが残る。セルフホスト（`link.rs`）は既に `Revive` だった。
#[tokio::test]
async fn ローカルモードの起こし直しの断りはrevive種別で配られる() {
    let config = config_for("revive-refused");
    let card_id = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _) = 呼び戻し先つきで起こす(&server).await;
        let card_id = session.card_id;
        session.kill();
        card_id
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    let server = common::TestServer::start_with(config).await;
    server
        .wait_for_listed("抜け殻が1枚戻る", |listed| listed.len() == 1)
        .await;
    server
        .manager
        .set_memory_probe(std::sync::Arc::new(足りないメモリ));
    let mut watcher = common::EventWatcher::attach(&server.manager);

    let refusal = agentdashboard_core::client::revive(&target_of(&server), &card_id.to_string())
        .await
        .expect_err("空きが足りないので断られること");
    assert!(
        refusal.to_string().contains("メモリが足りない"),
        "{refusal}"
    );

    let message = watcher
        .wait_for("このカード宛ての断り", |message| {
            matches!(
                message,
                protocol::ws::ServerMessage::Error { card_id: Some(id), .. } if *id == card_id
            )
        })
        .await;
    let protocol::ws::ServerMessage::Error { kind, .. } = message else {
        unreachable!("断りを待っていた");
    };
    assert_eq!(
        kind,
        protocol::ws::ErrorKind::Revive,
        "★起こし直しの断りは revive 種別で配ること"
    );
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

// ---------------------------------------------------------------------------
// 起こし直しの確かめ中に外したカードは起こさない（実装レビュー Astra 1）。
//
// **画面と CLI が通る「外す」口（ws の `Archive`）から当てる。** 外し方は2通りあり、
// サーバから見て実体があれば PC へ `archive` を頼み、無ければ記録だけを外す。後者は
// PC へ何も伝えていなかったので、確かめを待っている起こし直しが後から実体を作り、
// 報告は記録層に捨てられて画面に出ないまま残っていた。
// ---------------------------------------------------------------------------

/// 抜け殻を起こし直させ、Windows 側の確かめで止めてから CLI で外す。外した後に門を開け、
/// **確かめが済んだ後も実体が無いこと**を確かめる。
async fn 確かめ中に外す(server: &common::TestServer, card_id: protocol::CardId) {
    let (外, host_free, _門) = common::確かめで止める(&server.manager);

    let target = target_of(server);
    let 起こし直し = tokio::spawn({
        let target = target.clone();
        async move { agentdashboard_core::client::revive(&target, &card_id.to_string()).await }
    });
    外.聞かれるまで待つ(0).await;

    agentdashboard_core::client::archive(&target, &card_id.to_string())
        .await
        .expect("外せること");

    外.開ける();
    common::取得が終わるまで待つ(&host_free).await;
    // 確かめが済んでから起こすまでの間を与える（起こすなら、ここで既に起きている）
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        server.manager.get(card_id).is_none(),
        "★外したカードの実体を、確かめが済んだ後に起こしている（画面に出ないままメモリを食う）"
    );
    assert!(
        server.registry.get(card_id).is_none(),
        "記録から外れていない"
    );
    起こし直し.abort();

    // **外せた後は、遅れて届いた頼みも外したと断る**（実装レビュー第2回 Astra 1）。記録だけを
    // 外す側では、外した印は記録を外せた後の知らせ（`forget`）が立てる（第3回 Astra 1）
    let in_flight = server
        .manager
        .begin_revive(card_id, None)
        .expect("外したカードへの頼みを、競合（復旧中）として断らないこと");
    let 断り = server
        .manager
        .revive(
            in_flight,
            &common::work_dir(),
            None,
            protocol::ClaudeSessionId::new(),
        )
        .await
        .expect_err("★外せた後に遅れて届いた頼みで、実体を起こしている（外した印が立っていない）")
        .to_string();
    assert!(断り.contains("一覧から外された"), "{断り}");
}

#[tokio::test]
async fn 前回の起動が残した抜け殻を確かめ中に外すと確かめが済んでも起こさない() {
    // **サーバから見て実体が無い**カード。外す口は記録だけを外す側へ進む
    let config = config_for("revive-withdrawn-dormant");
    let card_id = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _) = 呼び戻し先つきで起こす(&server).await;
        let card_id = session.card_id;
        session.kill();
        card_id
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    let server = common::TestServer::start_with(config).await;
    let listed = server
        .wait_for_listed("抜け殻が1枚戻る", |listed| listed.len() == 1)
        .await;
    assert!(listed[0].revivable(), "戻せる状態として見えていない");
    assert!(
        server.manager.get(card_id).is_none(),
        "実体が居るなら、記録だけを外す側を通らない"
    );

    確かめ中に外す(&server, card_id).await;
}

#[tokio::test]
async fn 寝かせた抜け殻を確かめ中に外すと確かめが済んでも起こさない() {
    // **サーバから見て実体がある**カード（寝かせただけ）。外す口は `archive` を頼む側へ進む
    let server = common::TestServer::start_with(config_for("revive-withdrawn-asleep")).await;
    let (session, _) = 呼び戻し先つきで起こす(&server).await;
    let card_id = session.card_id;
    session.kill();
    server
        .wait_for_listed("寝る", |listed| {
            listed.iter().any(|meta| {
                meta.card_id == card_id && matches!(meta.status, SessionStatus::Ended { .. })
            })
        })
        .await;
    assert!(
        server.manager.get(card_id).is_some(),
        "抜け殻が居ないなら、archive を頼む側を通らない"
    );

    確かめ中に外す(&server, card_id).await;
}

#[tokio::test]
async fn 外した知らせが起こし直しの頼みより先に届いても起こさない() {
    // 実装レビュー第2回 Astra 1（ローカルモード）。起こし直しの口が材料を記録から引いた後、
    // 別の画面で外すと、外した知らせ（`forget`）が起こし直しの受付（`begin_revive`）より先に
    // 実体の側へ届く。**外す側には下ろす札がまだ無く**、後から受け付けた起こし直しが誰にも
    // 見えない実体を作っていた。
    //
    // 順は「知らせ → 材料を引いて受け付ける → 記録を外す」で固定する（材料は記録を外す前なら
    // 引けるので、実体の側に届く順は同じ）。外す口（ws の `Archive`）を通す試験は上の2本
    let config = config_for("forget-before-revive");
    let card_id = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _) = 呼び戻し先つきで起こす(&server).await;
        let card_id = session.card_id;
        session.kill();
        card_id
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    let server = common::TestServer::start_with(config).await;
    server
        .wait_for_listed("抜け殻が1枚戻る", |listed| listed.len() == 1)
        .await;
    let 外 = common::止める外側::開いたまま();
    server
        .manager
        .set_host_free(session_host_core::resources::HostFree::new(
            true,
            std::sync::Arc::clone(&外)
                as std::sync::Arc<dyn session_host_core::resources::HostFreeProbe>,
            Duration::from_secs(60),
        ));
    server
        .manager
        .set_memory_probe(std::sync::Arc::new(common::十分なメモリ));
    let host =
        agentdashboard_core::local::LocalSessionHost::new(std::sync::Arc::clone(&server.manager))
            .with_registry(std::sync::Arc::clone(&server.registry));
    let mut events = server.manager.subscribe_events();

    server_core::session_host::SessionHost::forget(
        &host,
        server_core::db::LOCAL_ACCOUNT_ID,
        card_id,
        None,
    )
    .await
    .expect("外した知らせを渡せること");
    server_core::session_host::SessionHost::revive(
        &host,
        server_core::session_host::ReviveRequest {
            account_id: server_core::db::LOCAL_ACCOUNT_ID,
            card_id,
            op: None,
        },
    )
    .await
    .expect("受付は通ること（断りは配信で届く）");
    server
        .registry
        .archive_owned(server_core::db::LOCAL_ACCOUNT_ID, card_id)
        .await
        .expect("記録を外せること");

    let 断り = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(protocol::ws::ServerMessage::Error {
                    card_id: Some(id),
                    kind: protocol::ws::ErrorKind::Revive,
                    busy,
                    message,
                    ..
                }) if id == card_id => return (busy, message),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    panic!("配信が閉じた")
                }
                _ => {}
            }
        }
    })
    .await
    .expect("★外したカードへの起こし直しの断りが届かない");
    assert_eq!(
        断り.0,
        Some(false),
        "終わった断りとして配ること: {}",
        断り.1
    );
    assert!(断り.1.contains("一覧から外された"), "{}", 断り.1);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        server.manager.get(card_id).is_none(),
        "★外したカードの実体を、後から受け付けた起こし直しで起こしている"
    );
    assert_eq!(
        外.聞かれた(),
        0,
        "外したカードのために Windows 側を聞きに行かないこと"
    );
}

// ---------------------------------------------------------------------------
// 記録を外せなかったカードは、一覧に残り後から起こし直せる（実装レビュー第3回 Astra 1）。
//
// 記録だけを外す側は、以前は外す**前に**外した印を PC へ立てさせていた。記録を外す書き込みが
// DB の失敗で落ちると、カードは一覧に残るのに、その PC では以後の起こし直しが「一覧から
// 外された」で断られ続けた（プロセスが起き直すまで）。
// ---------------------------------------------------------------------------

/// 記録を外す書き込み（`archived` を立てる UPDATE）だけを DB の側で落とす。**同じ DB へ別に
/// 繋いでトリガを張る**——サーバの接続には手を入れないので、それ以外の書き込みは通る。
async fn 記録を外せなくする(server: &common::TestServer) -> sea_orm::DatabaseConnection {
    use sea_orm::ConnectionTrait as _;
    let db = server_core::db::connect(&server.config.resolved_database_url())
        .await
        .expect("同じ DB へ繋げること");
    db.execute_unprepared(
        "CREATE TRIGGER refuse_archive BEFORE UPDATE OF archived ON sessions \
         WHEN NEW.archived BEGIN SELECT RAISE(ABORT, 'test: archive refused'); END",
    )
    .await
    .expect("トリガを張れること");
    db
}

async fn 記録を外せるように戻す(db: &sea_orm::DatabaseConnection) {
    use sea_orm::ConnectionTrait as _;
    db.execute_unprepared("DROP TRIGGER refuse_archive")
        .await
        .expect("トリガを外せること");
}

/// 前回の起動が残した抜け殻（サーバから見て実体が無い＝外す口は記録だけを外す側へ進む）。
async fn 前回の起動が残した抜け殻(
    label: &str,
) -> (common::TestServer, protocol::CardId) {
    let config = config_for(label);
    let card_id = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _) = 呼び戻し先つきで起こす(&server).await;
        let card_id = session.card_id;
        session.kill();
        card_id
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let server = common::TestServer::start_with(config).await;
    server
        .wait_for_listed("抜け殻が1枚戻る", |listed| listed.len() == 1)
        .await;
    assert!(
        server.manager.get(card_id).is_none(),
        "実体が居るなら、記録だけを外す側を通らない"
    );
    (server, card_id)
}

#[tokio::test]
async fn 記録を外せなかった抜け殻は一覧に残り外す前の起こし直しは戻らず後から起こし直せる() {
    let (server, card_id) = 前回の起動が残した抜け殻("archive-db-failed").await;
    let (外, host_free, _門) = common::確かめで止める(&server.manager);
    let target = target_of(&server);
    let 先の起こし直し = tokio::spawn({
        let target = target.clone();
        async move { agentdashboard_core::client::revive(&target, &card_id.to_string()).await }
    });
    外.聞かれるまで待つ(0).await;

    let db = 記録を外せなくする(&server).await;
    let 外した = agentdashboard_core::client::archive(&target, &card_id.to_string()).await;
    let 断り = 外した
        .expect_err("記録を外せなかったことを返すこと")
        .to_string();
    assert!(断り.contains("記録を外せませんでした"), "{断り}");
    assert!(
        server.registry.get(card_id).is_some(),
        "記録を外せなかったカードは一覧に残っていること"
    );

    // **外し始めたときに取り下げた起こし直しは戻らない**
    外.開ける();
    common::取得が終わるまで待つ(&host_free).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        server.manager.get(card_id).is_none(),
        "★外し始めて取り下げた起こし直しを、確かめが済んだ後に起こしている"
    );

    // **新しい頼みは通る。** DB は落ちたままでもよい（起こし直しは記録を外さない）
    agentdashboard_core::client::revive(&target, &card_id.to_string())
        .await
        .expect("★記録を外せなかった（一覧に残った）カードを、外したものとして断っている");
    assert!(
        server.manager.get(card_id).is_some(),
        "起こし直した実体があること"
    );
    let 先の断り = 先の起こし直し
        .await
        .expect("落ちないこと")
        .expect_err("取り下げた起こし直しは断りで終わること")
        .to_string();
    assert!(
        先の断り.contains("一覧から外す操作が始まった"),
        "外し終える前の取り下げを、外したと言っていない: {先の断り}"
    );

    // 戻したら外せる（外した印はここで初めて立つ）
    記録を外せるように戻す(&db).await;
    agentdashboard_core::client::archive(&target, &card_id.to_string())
        .await
        .expect("記録を外せること");
    assert!(
        server.registry.get(card_id).is_none(),
        "記録から外れていない"
    );
}

#[tokio::test]
async fn 寝かせた抜け殻を外したとき記録を書けなくても書けるようになれば一覧から外れる() {
    // 実体がある側（PC が外す主）。PC は実体を畳み、外した印を立ててから「外した」と報告する。
    // **報告は1回きり**で、以前は記録を書けなければ捨てていたので、カードは一覧に残るのに
    // その PC では起こし直しが「一覧から外された」で断られ続けた（実装レビュー第3回 Astra 1 と
    // 同じ種類の穴）。PC の側の外す処理は取り消せないので、記録の側が書けるまで取り込み直す
    let server = common::TestServer::start_with(config_for("archive-reported-db-failed")).await;
    let (session, _) = 呼び戻し先つきで起こす(&server).await;
    let card_id = session.card_id;
    session.kill();
    server
        .wait_for_listed("寝る", |listed| {
            listed.iter().any(|meta| {
                meta.card_id == card_id && matches!(meta.status, SessionStatus::Ended { .. })
            })
        })
        .await;
    assert!(
        server.manager.get(card_id).is_some(),
        "抜け殻が居ないなら、PC が外す側を通らない"
    );
    // 取り込み直しは急かす口でだけ進める（時計に頼らない）
    server
        .registry
        .外した報告の取り込み直しの間隔(Duration::from_secs(3_600));
    let mut events = server.registry.subscribe_events();

    let db = 記録を外せなくする(&server).await;
    let target = target_of(&server);
    // **画面と CLI が受け取るのは「保存できませんでした」**（記録層の知らせ）。外れたという
    // 知らせは、記録を書けるまで出さない
    let 外した = agentdashboard_core::client::archive(&target, &card_id.to_string()).await;
    let 断り = 外した
        .expect_err("記録を書けないうちは、外れたと言わないこと")
        .to_string();
    assert!(断り.contains("記録を保存できませんでした"), "{断り}");
    assert!(
        server.manager.get(card_id).is_none(),
        "PC の側は外し終えている"
    );
    assert!(
        server.registry.get(card_id).is_some(),
        "記録を書けないうちは、一覧に残っていること"
    );

    記録を外せるように戻す(&db).await;
    let 外れた = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            server.registry.外した報告の取り込み直しを急かす();
            match tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
                Ok(Ok(event)) => {
                    if matches!(
                        event.message,
                        protocol::ws::ServerMessage::SessionRemoved { card_id: id } if id == card_id
                    ) {
                        return;
                    }
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    panic!("配信が閉じた")
                }
                _ => {}
            }
        }
    })
    .await;
    assert!(
        外れた.is_ok(),
        "★PC が外したと報告したカードを、記録を書けるようになっても一覧から外していない"
    );
    assert!(
        server.registry.get(card_id).is_none(),
        "記録から外れていない"
    );
}

// ---------------------------------------------------------------------------
// 確かめ中の起こし直しは、終了の頼みでも止まる（実装レビュー第3回 Astra 2）。
//
// **画面と CLI が通る「終了」の口（ws の `Kill`）から当てる。** 以前の終了は古い実体
// （もう止まっている）だけを止め、確かめが済むと新しいプロセスを起こしていた。
// ---------------------------------------------------------------------------

/// 起こし直しを確かめで止めてから CLI で終了を頼み、**CLI が成功で返ること**・**取り下げた
/// 起こし直しが断りで終わること**・**確かめが済んだ後も新しい実体が起きないこと**を見る。
async fn 確かめ中に終了を頼む(server: &common::TestServer, card_id: protocol::CardId) {
    let 前の実体 = server.manager.get(card_id);
    let (外, host_free, _門) = common::確かめで止める(&server.manager);
    let target = target_of(server);
    let 起こし直し = tokio::spawn({
        let target = target.clone();
        async move { agentdashboard_core::client::revive(&target, &card_id.to_string()).await }
    });
    外.聞かれるまで待つ(0).await;

    let 終了 = tokio::time::timeout(
        Duration::from_secs(10),
        agentdashboard_core::client::kill(&target, &card_id.to_string()),
    )
    .await
    .expect("★終了の頼みが、起こし直しを止めた後も上限まで待ち続けている");
    let 終了 = 終了.expect("★起こし直しを止めたのに、終了できなかったと返している");
    // **終了の頼みへの答え（番号付きの状態）で満ちたこと**（実装レビュー第5回 Astra 2・第6回
    // Astra 1）。寝ているカードの写しは `Ended` なので、写しで満ちると取り下げを読まずに成功する
    assert!(
        終了.raw.contains(r#""t": "status""#) && 終了.raw.contains(r#""op": ""#),
        "★終了の頼みへの答えではなく、接続直後の写しで満ちている: {}",
        終了.raw
    );

    外.開ける();
    common::取得が終わるまで待つ(&host_free).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let いまの実体 = server.manager.get(card_id);
    assert_eq!(
        いまの実体.as_ref().map(std::sync::Arc::as_ptr),
        前の実体.as_ref().map(std::sync::Arc::as_ptr),
        "★終了を頼んだ後に、確かめが済んだ起こし直しが新しいプロセスを起こしている"
    );
    let 断り = 起こし直し
        .await
        .expect("落ちないこと")
        .expect_err("取り下げた起こし直しは断りで終わること")
        .to_string();
    assert!(断り.contains("終了を頼まれた"), "{断り}");
    assert!(
        server.registry.get(card_id).is_some(),
        "終了しただけのカードは一覧に残ること"
    );
}

#[tokio::test]
async fn 寝かせた抜け殻を確かめ中に終了させると確かめが済んでも起こさない() {
    // 報告の場面そのもの（終了済みの実体が残るカード）
    let server = common::TestServer::start_with(config_for("revive-killed-asleep")).await;
    let (session, _) = 呼び戻し先つきで起こす(&server).await;
    let card_id = session.card_id;
    session.kill();
    server
        .wait_for_listed("寝る", |listed| {
            listed.iter().any(|meta| {
                meta.card_id == card_id && matches!(meta.status, SessionStatus::Ended { .. })
            })
        })
        .await;
    assert!(
        server.manager.get(card_id).is_some(),
        "終了済みの実体が残っていること"
    );

    確かめ中に終了を頼む(&server, card_id).await;
}

#[tokio::test]
async fn 起こし直していない寝たカードの終了は写しの後に届く答えですぐ満ちる() {
    // 実装レビュー第5回 Astra 2・第6回 Astra 1。CLI は接続直後の写しの `Ended` では満ちないので、
    // **起こし直しが無いときの答え**が要る。終わっていた実体なら PC が「既に終わっていた」、
    // 何も無い（前回の起動が残した）なら「何も無かった」と番号付きで答え、記録層が記録と合わせて
    // 成功にする。どちらも上限（30 秒）まで待たずに成功で返ること
    let server = common::TestServer::start_with(config_for("kill-asleep-no-revive")).await;
    let (session, _) = 呼び戻し先つきで起こす(&server).await;
    let card_id = session.card_id;
    session.kill();
    server
        .wait_for_listed("寝る", |listed| {
            listed.iter().any(|meta| {
                meta.card_id == card_id && matches!(meta.status, SessionStatus::Ended { .. })
            })
        })
        .await;
    assert!(
        server.manager.get(card_id).is_some(),
        "終わった実体が残っていること（配り直す側を通す）"
    );
    let 終了 = tokio::time::timeout(
        Duration::from_secs(10),
        agentdashboard_core::client::kill(&target_of(&server), &card_id.to_string()),
    )
    .await
    .expect("★終わっていた実体への終了に答えが無く、上限まで待っている")
    .expect("終わっていたカードの終了は成功で返すこと");
    assert!(終了.human.contains("終了しました"), "{}", 終了.human);
}

#[tokio::test]
async fn 前回の起動が残した抜け殻の終了は止めるものが無くても成功で返る() {
    // 実体も起こし直しも無い（PC は何も無かったと答える）。以前は写しの `Ended` で満ちていた
    let config = config_for("kill-left-over");
    let card_id = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _) = 呼び戻し先つきで起こす(&server).await;
        let card_id = session.card_id;
        session.kill();
        server
            .wait_for_listed("寝る", |listed| {
                listed.iter().any(|meta| {
                    meta.card_id == card_id && matches!(meta.status, SessionStatus::Ended { .. })
                })
            })
            .await;
        card_id
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let server = common::TestServer::start_with(config).await;
    let listed = server
        .wait_for_listed("抜け殻が1枚戻る", |listed| listed.len() == 1)
        .await;
    assert!(
        matches!(listed[0].status, SessionStatus::Ended { .. }),
        "寝た姿で戻ること（写しが Ended の側を通す）"
    );
    assert!(server.manager.get(card_id).is_none(), "実体が無いこと");
    let 終了 = tokio::time::timeout(
        Duration::from_secs(10),
        agentdashboard_core::client::kill(&target_of(&server), &card_id.to_string()),
    )
    .await
    .expect("★止めるものが無かったという答えが CLI まで届かず、上限まで待っている")
    .expect("★止めるものが無かっただけなのに、終了できなかったと返している");
    // PC は「何も無かった」と答え、記録が終わっているので記録層が成功にして配る（実装レビュー
    // 第6回 Astra 1。以前は CLI が写しの `Ended` で見分けていた）
    assert!(終了.human.contains("終了しました"), "{}", 終了.human);
    assert!(
        終了.raw.contains(r#""op": ""#),
        "★終了の頼みへの番号付きの答えではないもので満ちている: {}",
        終了.raw
    );
}

#[tokio::test]
async fn 作業中のまま残った抜け殻を確かめ中に終了させると待ち切らずに止まる() {
    // 実体が無いカード（ローカルでは終了の頼みが PC へ届く）で、**最後の既知状態が `Ended`
    // でない**もの（サーバだけが落ちた形）。`Ended` は来ないので、CLI は取り下げた起こし直しの
    // 断りで満ちなければ、断りで「終了できなかった」と落ちるか上限まで待ち切る
    let config = config_for("revive-killed-working");
    let card_id = {
        let server = common::TestServer::start_with(config.clone()).await;
        let (session, _) = 呼び戻し先つきで起こす(&server).await;
        server
            .post_hook(session.token(), "UserPromptSubmit", "{}")
            .await;
        common::wait_for_status(&session, SessionStatus::Working).await;
        server
            .wait_for_listed("作業中", |listed| {
                listed.len() == 1 && listed[0].status == SessionStatus::Working
            })
            .await;
        session.card_id
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let server = common::TestServer::start_with(config).await;
    let listed = server
        .wait_for_listed("抜け殻が1枚戻る", |listed| listed.len() == 1)
        .await;
    assert!(listed[0].revivable(), "戻せる状態として見えていない");
    // 最後の既知状態が `Ended` でない形。`Ended` の形は `寝かせた抜け殻を確かめ中に…` が見る
    // （第5回 Astra 2 までは、`Ended` だと CLI が接続直後の写しで満ち、断りの道を通らなかった）
    assert_eq!(listed[0].status, SessionStatus::Working, "最後の既知状態");
    assert!(server.manager.get(card_id).is_none(), "実体が無いこと");

    確かめ中に終了を頼む(&server, card_id).await;
}

// ---------------------------------------------------------------------------
// 束が満ちた起こし直しの頼みには、その番号への終わった断りを返す（寝ているカードばかりなのに、
// メモリ不足でセッションを起こせない 実装レビュー第10回 Astra 2）。
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 束が満ちた後の起こし直しの頼みにはその番号への終わった断りを配る() {
    // 競合で断った頼みの番号は先の札へ束ね、先の起こし直しが断られたらその断りで答える。束には
    // 上限を設けたので、**満ちた後の頼みの番号はどこにも残らない**——ここで答えないと、その番号を
    // 待つ CLI・枝分かれは上限まで待つ。ローカルの競合は頼んだ接続へ同期に返る（記録層を通らない）
    // ので、終わった断りは配信で配る
    use session_host_core::session::{REVIVE_OPS_KEPT, TOO_MANY_REVIVE_REQUESTS};
    let server = common::TestServer::start().await;
    let (session, _) = 呼び戻し先つきで起こす(&server).await;
    let card_id = session.card_id;
    let host =
        agentdashboard_core::local::LocalSessionHost::new(std::sync::Arc::clone(&server.manager))
            .with_registry(std::sync::Arc::clone(&server.registry));
    // 先に起こしている札を表に置いたままにする
    let _先の起こし直し = server
        .manager
        .begin_revive(card_id, None)
        .expect("先の札が立つこと");
    let mut events = server.manager.subscribe_events();

    let mut 溢れた番号 = Vec::new();
    for _ in 0..REVIVE_OPS_KEPT + 3 {
        let op = protocol::ws::OpId::new();
        match server_core::session_host::SessionHost::revive(
            &host,
            server_core::session_host::ReviveRequest {
                account_id: server_core::db::LOCAL_ACCOUNT_ID,
                card_id,
                op: Some(op),
            },
        )
        .await
        {
            // 束ねた（競合）。頼んだ接続へ同期に断る
            Err(message) => assert_eq!(message, session_host_core::session::ALREADY_REVIVING),
            Ok(()) => 溢れた番号.push(op),
        }
    }
    assert!(
        !溢れた番号.is_empty(),
        "★束が満ちた後の頼みも競合として断り、その番号へ答える道を作っていない"
    );
    for op in 溢れた番号 {
        let 断り = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(protocol::ws::ServerMessage::Error {
                    card_id: Some(id),
                    kind: protocol::ws::ErrorKind::Revive,
                    busy,
                    message,
                    ops,
                    ..
                }) = events.recv().await
                    && id == card_id
                    && ops == vec![op]
                {
                    return (busy, message);
                }
            }
        })
        .await
        .expect("★束が満ちた後の頼みの番号へ、終わった断りを配っていない");
        assert_eq!(
            断り,
            (Some(false), TOO_MANY_REVIVE_REQUESTS.to_string()),
            "終わった断りとして配ること（待っても起きないので、枝分かれはすぐ終わってよい）"
        );
    }
    session.kill();
}
