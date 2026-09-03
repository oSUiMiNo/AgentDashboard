//! CLI の操作系と待ちの作法の統合（テスト計画フェーズ3「操作系と待ちの作法」と
//! 「設定・版・アカウント」の設定と版）。
//!
//! `TestServer`（実際に待ち受けるローカルモードのサーバ）を起こし、CLI の
//! クライアント層（`client::spawn` など）を**直に呼ぶ**。実行ファイルは起こさない
//! （起こすと `dist` の入口を通ることになり、テストの本体から遠くなる）。
//! 相手は擬似 claude なので課金しない。
//!
//! Hello の順序と未知種別の2本だけは、**サーバの側を偽物にする**（本物のサーバは
//! 未知の種別を流さないし、Hello を遅らせもしないため）。tokio-tungstenite の
//! `accept_async` で受けるだけの小さなスタブで足りる。

// テスト名は日本語で書く。ID などの英大文字が snake_case 判定に引っかかるだけで
// 実害はないため、このファイルに限って許可する（`cli_client.rs` と同じ扱い）
#![allow(non_snake_case)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use agentdashboard_core::client::{self, wait, ws::Ws};
use agentdashboard_core::config::Config;
use common::TestServer;
use futures_util::{FutureExt as _, SinkExt as _, StreamExt as _};
use protocol::ws::{ClientMessage, ServerMessage};
use session_host_core::version::{self, VERSION_SUPPORTED_ENV};

/// 一時の作業ディレクトリ（セッションの cwd に使う）。
fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-cli-ops-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("作業ディレクトリを作れること");
    dir
}

fn target_of(server: &TestServer) -> client::Target {
    client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を読めること")
}

/// セッションの実体が**記録層に載るまで**待って、カードIDを返す。
///
/// `start_session` は擬似 claude の起動（ready）までしか待たない。記録への反映は
/// 報告の経路を通る非同期なので、待たずに前方一致の解決へ進むと「見つかりません」になる
/// （CLI は一覧＝記録層から引くため）。
async fn listed_card(
    server: &TestServer,
    session: &std::sync::Arc<session_host_core::session::Session>,
) -> String {
    let card = session.meta().card_id.to_string();
    server
        .wait_for_listed("カードが載る", |listed| {
            listed.iter().any(|meta| meta.card_id.to_string() == card)
        })
        .await;
    card
}

// ---------------------------------------------------------------------------
// 操作系と待ちの作法
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 起こすと新しいカードのフルIDが返る() {
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("spawn-new");

    let outcome = client::spawn(&target, &cwd.to_string_lossy(), None, None)
        .await
        .expect("起こせること");

    // 返るのは前方一致で引ける**フルの ID**。一覧に実在することまで見る
    let (list, _) = client::sessions(&target).await.expect("一覧を引けること");
    assert!(
        list.iter()
            .any(|meta| meta.card_id.to_string() == outcome.human),
        "返った ID が一覧に居ない: {}",
        outcome.human
    );
    // `--json` は確定に使った知らせ（SessionUpsert）をそのまま
    assert!(
        outcome.raw.contains("session_upsert"),
        "確定に使った知らせが持ち帰りになっていない: {}",
        outcome.raw
    );
}

#[tokio::test]
async fn 同じフォルダに既にカードが在っても新しい方のIDが返る() {
    // `cwd` の一致で待つと、既に走っているカードの更新を「起きた」と読み違える
    // （設計§8-3）。集合の差で待っていることを、同じフォルダの2本目で確かめる
    let server = TestServer::start().await;
    let target = target_of(&server);
    let cwd = work_dir("spawn-same");

    let first = client::spawn(&target, &cwd.to_string_lossy(), None, None)
        .await
        .expect("1本目を起こせること");
    let second = client::spawn(&target, &cwd.to_string_lossy(), None, None)
        .await
        .expect("2本目を起こせること");

    assert_ne!(first.human, second.human, "既存のカードを掴んでいる");
    let (list, _) = client::sessions(&target).await.expect("一覧を引けること");
    assert_eq!(list.len(), 2, "2本とも一覧に居ること");
}

#[tokio::test]
async fn 送るだけの既定は確かめずにすぐ返る() {
    let server = TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let outcome = client::send_input(&target, &card[..8], "こんにちは", false, 5)
        .await
        .expect("送れること");

    // 受け取り証には「確かめていない」ことが載る（黙って成功と読ませない）
    assert!(
        outcome.raw.contains("\"confirmed\":false"),
        "確認していないことが受け取り証に無い: {}",
        outcome.raw
    );
    // 待たなかったことと届くことは別——届いたことは端末のエコーで別に確かめる
    watcher.wait_for("こんにちは").await;
}

#[tokio::test]
async fn waitを付けるとターンの終わりまで待つ() {
    let server = TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    // 送る本文そのものに UserPromptSubmit を撃たせる（擬似 claude の `hook` 命令）。
    // CLI は接続してから送るので、この後の状態の動きは全部 CLI にも届く
    let send = tokio::spawn({
        let target = target.clone();
        let prefix = card.clone();
        async move { client::send_input(&target, &prefix, "hook UserPromptSubmit", true, 30).await }
    });

    // 擬似 claude がフックを撃ち終わり、作業中が記録に載るまで見届けてから
    watcher
        .wait_for(&format!(
            "{}UserPromptSubmit",
            testkit::fake_claude::HOOK_SENT_PREFIX
        ))
        .await;
    server
        .wait_for_listed("作業中", |listed| {
            listed
                .iter()
                .any(|meta| meta.status == protocol::SessionStatus::Working)
        })
        .await;
    // ターンを終える（Stop → 入力待ちへ戻る）
    common::fire_hook(&session, &mut watcher, "Stop", "").await;

    let outcome = send
        .await
        .expect("待ちのタスクが生きていること")
        .expect("ターンの終わりで満ちること");
    assert!(
        outcome.human.contains("入力待ち"),
        "何で満ちたのか分からない: {}",
        outcome.human
    );
}

#[tokio::test]
async fn killは終了の知らせまで待つ() {
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let outcome = client::kill(&target, &card[..8]).await.expect("畳めること");

    assert!(
        outcome.human.contains("終了しました"),
        "終了の知らせで満ちていない: {}",
        outcome.human
    );
    let (list, _) = client::sessions(&target).await.expect("一覧を引けること");
    let meta = list
        .iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("カードは残ること（外してはいない）");
    assert!(
        matches!(meta.status, protocol::SessionStatus::Ended { .. }),
        "一覧の状態も終了になっていること: {:?}",
        meta.status
    );
}

#[tokio::test]
async fn rmは外れたの知らせまで待つ() {
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let outcome = client::archive(&target, &card[..8])
        .await
        .expect("外せること");

    assert!(
        outcome.human.contains("外しました"),
        "外れたの知らせで満ちていない: {}",
        outcome.human
    );
    let (list, _) = client::sessions(&target).await.expect("一覧を引けること");
    assert!(
        !list.iter().any(|meta| meta.card_id.to_string() == card),
        "外したカードが一覧に残っている"
    );
}

/// モデル切替のテストで使う擬似のグローバル設定（`model.rs` と同じ形）。
const GLOBAL: &str = r#"{
  "permissions": { "defaultMode": "auto" },
  "model": "claude-fable-5[1m]"
}
"#;

#[tokio::test]
async fn モデル切替は確定の知らせまで待つ() {
    // statusLine の再実行間隔を最小へ（切替の確定はこの周期で決まる）
    let config = Config {
        status_line_refresh_secs: 1,
        ..Config::default()
    };
    let (_path, server) = common::server_with_fake_global("cli-ops-model", GLOBAL, config).await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let outcome = client::set_model(&target, &card[..8], "opus")
        .await
        .expect("切り替わること");

    // 送るのは別名（opus）、確定するのはフルID。持ち帰りは表示名まで解決されている
    assert!(
        outcome.human.contains("Opus 5"),
        "確定したモデルが持ち帰りに無い: {}",
        outcome.human
    );
}

#[tokio::test]
async fn 権限モード切替は反映の知らせまで待つ() {
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    // フッタからいまのモードを読ませておく（切替はいまの位置からの巡回なので）
    server.manager.sweep_once();
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let outcome = client::set_mode(&target, &card[..8], "plan")
        .await
        .expect("着けること");

    assert!(
        outcome.human.contains("plan"),
        "反映されたモードが持ち帰りに無い: {}",
        outcome.human
    );
    assert_eq!(
        session.meta().permission_mode,
        Some(protocol::PermissionMode::new("plan")),
        "実体の側にも着いていること"
    );
}

#[tokio::test]
async fn 対象カードへのエラーは時間切れを待たずに落ちる() {
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    server.manager.sweep_once();
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    // dontAsk は起動時にしか選べない（設計§11）ので、切替は理由つきで断られる。
    // その断り（ServerMessage::Error）が届いた瞬間に落ちること——時間切れ（60秒）まで
    // 待っていたら、このテスト自体がそれより早く終わらない
    let started = std::time::Instant::now();
    let err = client::set_mode(&target, &card[..8], "dontAsk")
        .await
        .expect_err("断られること");

    assert_eq!(err.exit_code(), 1, "断られたのだから 1（送り直さない）");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "エラーが来ているのに時間切れまで待っている（{:?}）",
        started.elapsed()
    );
    assert!(
        err.to_string().contains("dontAsk"),
        "サーバの理由がそのまま伝わること: {err}"
    );
}

#[tokio::test]
async fn 満ちない待ちは時間切れの三で終わる() {
    let server = TestServer::start().await;
    let target = target_of(&server);

    let mut ws = Ws::connect(&target).await.expect("繋がること");
    // 誰も外さないカードの取り外しを待つ＝満ちようがない
    let goal = wait::Goal::Removed {
        card: protocol::CardId::new(),
    };
    let err = wait::run(&mut ws, goal, "来ない知らせ", Duration::from_secs(1))
        .await
        .expect_err("時間切れになること");

    // **1（断られた）と 3（確かめられなかった）は別**（設計§8-4）。同じにすると、
    // エージェントが二重に指示を送る経路ができる
    assert_eq!(err.exit_code(), 3);
}

/// 抜け殻のカードを1枚作る（呼び戻し先つき・接続断）。
///
/// ローカルモードでは実体が居るあいだ必ず `agent_connected` が立つので、記録へ直に
/// 1枚置いて倒す。**サーバを畳んで起こし直す形は `restart.rs` が持っている**ので、
/// ここでは「CLI が何をするか」だけに絞る。
async fn 抜け殻を1枚(
    server: &TestServer,
    session: &std::sync::Arc<session_host_core::session::Session>,
) -> protocol::CardId {
    let card = listed_card(server, session).await;
    let listed = server
        .wait_for_listed("1枚出る", |listed| !listed.is_empty())
        .await;
    let mut 抜け殻 = listed
        .into_iter()
        .find(|meta| meta.card_id.to_string() == card)
        .expect("いま起こしたカードが居ること");
    抜け殻.claude_session_id = Some(protocol::ClaudeSessionId::new());
    抜け殻.agent_connected = false;
    let card_id = 抜け殻.card_id;
    server
        .registry
        .apply(
            &server_core::registry::ReportOrigin::local(),
            ServerMessage::SessionUpsert {
                session: Box::new(抜け殻),
            },
        )
        .await;
    server
        .wait_for_listed("接続断になる", |listed| {
            listed
                .iter()
                .any(|meta| meta.card_id == card_id && meta.revivable())
        })
        .await;
    card_id
}

#[tokio::test]
async fn 全部復旧は戻せるものだけを順に回す() {
    // **飛ばしたものを黙って落とさない**のが要点（設計§10-1）。戻せる1枚と、
    // 動いている1枚を並べて、戻ったのが1枚だけであることを見る
    let server = TestServer::start().await;
    let (抜け殻の元, _w1) = common::start_session(&server.manager).await;
    let (動いている, _w2) = common::start_session(&server.manager).await;
    let card_id = 抜け殻を1枚(&server, &抜け殻の元).await;
    let 動いているid = listed_card(&server, &動いている).await;
    let target = target_of(&server);

    let outcome = client::revive_all(&target).await.expect("回れること");

    assert!(
        outcome.human.starts_with("1 枚を起こし直しました"),
        "戻した枚数が読めない: {}",
        outcome.human
    );
    assert!(
        outcome.human.contains("対象外 1 枚"),
        "飛ばした枚数が読めない: {}",
        outcome.human
    );
    assert!(
        outcome.raw.contains(&card_id.to_string()),
        "戻したカードが持ち帰りに入っていない: {}",
        outcome.raw
    );
    assert!(
        !outcome.raw.contains(&動いているid),
        "動いているカードまで戻している: {}",
        outcome.raw
    );

    for session in [抜け殻の元, 動いている] {
        session.kill();
    }
    if let Some(live) = server.manager.get(card_id) {
        live.kill();
    }
}

#[tokio::test]
async fn 全部復旧は対象が無ければ零枚と言う() {
    // **沈黙させない。** 押したのに何も起きなかったのか、対象が無かったのかを
    // 利用者が区別できなくなる
    let server = TestServer::start().await;
    let target = target_of(&server);

    let outcome = client::revive_all(&target)
        .await
        .expect("0枚でも落ちないこと");
    assert!(
        outcome.human.contains("0枚"),
        "0枚だと言っていない: {}",
        outcome.human
    );
}

#[tokio::test]
async fn 起こし直しの断りは時間切れを待たずに一で落ちる() {
    // 動いているカードは断られる（設計§3-5）。**1（断られた）で落ちること**——
    // 3（確かめられなかった）と同じにすると、送り直して二重に効かせる経路ができる
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let started = std::time::Instant::now();
    let err = client::revive(&target, &card[..8])
        .await
        .expect_err("断られること");

    assert_eq!(err.exit_code(), 1, "断られたのだから 1（送り直さない）");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "断りが来ているのに時間切れまで待っている（{:?}）",
        started.elapsed()
    );
    session.kill();
}

// ---------------------------------------------------------------------------
// サーバの側を偽物にする2本（Hello の順序・未知種別）
// ---------------------------------------------------------------------------

fn text_of(message: &ServerMessage) -> tokio_tungstenite::tungstenite::Message {
    tokio_tungstenite::tungstenite::Message::text(
        serde_json::to_string(message).expect("組み立てられること"),
    )
}

#[tokio::test]
async fn 知らない種別の知らせが混ざっても落ちない() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("待ち受けられること");
    let addr = listener.local_addr().expect("番号を読めること");
    let card = protocol::CardId::new();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("受けられること");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("upgrade できること");
        socket
            .send(text_of(&ServerMessage::Hello {
                flow_high: 1,
                flow_low: 1,
            }))
            .await
            .expect("送れること");
        // サーバに種別が1つ増えた未来のふり。ここで CLI が落ちると、
        // 種別の追加のたびに古い CLI が全部止まることになる（設計§7-3）
        socket
            .send(tokio_tungstenite::tungstenite::Message::text(
                r#"{"t":"future_thing","payload":{"x":1}}"#,
            ))
            .await
            .expect("送れること");
        socket
            .send(text_of(&ServerMessage::SessionRemoved { card_id: card }))
            .await
            .expect("送れること");
        // クライアントが片付けを済ませて切るまで居る
        while let Some(Ok(_)) = socket.next().await {}
    });

    let target = client::Target::from_url(&format!("http://{addr}")).expect("接続先を読めること");
    let mut ws = Ws::connect(&target).await.expect("繋がること");
    let outcome = wait::run(
        &mut ws,
        wait::Goal::Removed { card },
        "取り外し",
        Duration::from_secs(5),
    )
    .await
    .expect("未知の種別を読み飛ばして満ちること");
    assert!(outcome.human.contains("外しました"));
}

#[tokio::test]
async fn helloを受け取ってから送る() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("待ち受けられること");
    let addr = listener.local_addr().expect("番号を読めること");
    let (report_tx, report_rx) = tokio::sync::oneshot::channel::<(bool, String)>();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("受けられること");
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("upgrade できること");
        // Hello を**わざと遅らせる**。時間で待つ実装なら、この間に送ってしまう
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Hello より前に届いているものが無いかを覗く（あれば時間で待っている証拠）
        let premature = socket.next().now_or_never().is_some();
        socket
            .send(text_of(&ServerMessage::Hello {
                flow_high: 1,
                flow_low: 1,
            }))
            .await
            .expect("送れること");
        // Hello の後に届いた最初のフレーム＝クライアントの送信
        let first = match socket.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => text.to_string(),
            other => format!("テキストではない: {other:?}"),
        };
        let _ = report_tx.send((premature, first));
    });

    let target = client::Target::from_url(&format!("http://{addr}")).expect("接続先を読めること");
    let mut ws = Ws::connect(&target)
        .await
        .expect("Hello まで待って繋がること");
    ws.send(&ClientMessage::Kill {
        card_id: protocol::CardId::new(),
    })
    .await
    .expect("送れること");

    // 上限つきで受ける。Hello を待たない壊れ方だと、スタブの覗き見がクライアントの
    // 送信を食ってしまい**報告が永久に来ない**（壊し検証で実際に固まった）——
    // 固まるテストは何も教えてくれないので、時間で落として理由を言わせる
    let (premature, first) = tokio::time::timeout(Duration::from_secs(10), report_rx)
        .await
        .expect("スタブが10秒以内に報告すること（来ないなら Hello の待ち方が壊れている）")
        .expect("スタブが報告を落とさないこと");
    assert!(
        !premature,
        "Hello より前に何かを送っている（時間ではなく合図で待つ。設計§7-2）"
    );
    assert!(
        first.contains("\"kill\""),
        "Hello の後に送ったものが届いていること: {first}"
    );
}

// ---------------------------------------------------------------------------
// 設定と版
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 設定の変更は触った項目だけが変わる() {
    let dir = work_dir("settings-set");
    let fake_global = dir.join("claude-settings.json");
    std::fs::write(&fake_global, "{}").expect("偽のグローバル設定を書けること");
    let server = TestServer::start_with_settings(Config::default(), fake_global).await;
    let target = target_of(&server);

    let body = client::settings_update_body("project_autostart_session", "true")
        .expect("本文を組めること");
    let raw = client::settings_set(&target, body)
        .await
        .expect("変えられること");

    let view: serde_json::Value = serde_json::from_str(&raw).expect("応答を読めること");
    assert_eq!(view["project_autostart_session"], true, "触った項目: {raw}");
    assert_eq!(
        view["always_bypass_permissions"], false,
        "触っていない項目が動いている: {raw}"
    );

    // 数の項目も同じ道を通る。**画面の選択肢に足した 0.3秒 が CLI からも入る**ことを見る
    // ——検査は1か所に集めてあるので、入口によって通ったり通らなかったりしてはいけない
    let body = client::settings_update_body("screen_interval_ms", "300").expect("本文を組めること");
    let raw = client::settings_set(&target, body)
        .await
        .expect("変えられること");

    let view: serde_json::Value = serde_json::from_str(&raw).expect("応答を読めること");
    assert_eq!(
        view["intervals"]["screen_interval_ms"], 300,
        "触った項目: {raw}"
    );
    assert_eq!(
        view["project_autostart_session"], true,
        "さっき変えた値が巻き戻っている: {raw}"
    );
}

#[tokio::test]
async fn 受けられない設定はサーバの断りがそのまま伝わる() {
    // LAN のパスワードは **127.0.0.1 からだけ**変えられる（設計§8-3）。LAN の向こうの
    // ふりで叩き、断りの理由（次の一手）が CLI の言葉に残ることを見る
    let dir = work_dir("settings-refuse");
    let fake_global = dir.join("claude-settings.json");
    std::fs::write(&fake_global, "{}").expect("偽のグローバル設定を書けること");
    let peer: std::net::SocketAddr = "192.168.7.9:40000".parse().expect("読めること");
    let server = TestServer::start_with_settings_from(Config::default(), fake_global, peer).await;
    let target = target_of(&server);

    let body = client::settings_update_body("lan_password", "ひみつ").expect("本文を組めること");
    let err = client::settings_set(&target, body)
        .await
        .expect_err("断られること");

    assert_eq!(err.exit_code(), 1);
    assert!(
        err.to_string().contains("127.0.0.1"),
        "サーバの理由（どこから叩けば通るか）が消えている: {err}"
    );
}

/// 保管庫に「名乗るだけの版」を置く（`versions.rs` から写した最小限。あちらは
/// このテストからは参照できない——テストバイナリどうしは import できない）。
fn write_stored_version(state_dir: &Path, version_name: &str) {
    let dir = version::versions_dir(state_dir).join(version_name);
    std::fs::create_dir_all(&dir).expect("保管庫を作れること");
    for name in version::BINARIES {
        let path = dir.join(name);
        // パーサだけは IPC の hello で版を名乗る（門がそこへ聞きに来る）
        let body = if name == "transcript-parser" {
            format!(
                "#!/bin/sh\nprintf '{{\"ev\":\"hello\",\"parser_version\":\"{version_name}\"}}\\n'\n"
            )
        } else {
            format!("#!/bin/sh\necho '{name} {version_name}'\n")
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

/// 門の問いに答えられる一式を保管庫へ置く（`versions.rs` の `write_gate_ready_version` と同型）。
fn write_gate_ready_version(state_dir: &Path, version_name: &str) {
    write_stored_version(state_dir, version_name);
    let names = server_core::db::migration_names()
        .into_iter()
        .map(|name| format!("    echo '{name}'"))
        .collect::<Vec<_>>()
        .join("\n");
    let marker = agentdashboard_core::cli::SCHEMA_NAMES_MARKER;
    let path = version::versions_dir(state_dir)
        .join(version_name)
        .join("agentdashboard");
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
             \x20 --version) echo 'agentdashboard {version_name}' ;;\n\
             \x20 migrations)\n\
             \x20   echo '{marker}'\n{names} ;;\n\
             \x20 *) exit 0 ;;\n\
             esac\n"
        ),
    )
    .expect("書けること");
}

/// 使える構成のふりをする。nextest はテストごとに別プロセスなので他へは漏れない。
fn pretend_supported() {
    unsafe { std::env::set_var(VERSION_SUPPORTED_ENV, "1") };
}

#[tokio::test]
async fn 版の予約はその場では何も起こさない() {
    pretend_supported();
    let server = TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    write_gate_ready_version(&state_dir, "0.1.1");
    let target = target_of(&server);

    let raw = client::version_select(&target, "0.1.1", false)
        .await
        .expect("予約できること");

    let view: serde_json::Value = serde_json::from_str(&raw).expect("応答を読めること");
    assert_eq!(view["selected"], "0.1.1", "予約になっていない: {raw}");
    // **選んだ瞬間には何も起きない**（CICD設計）。落とす指示が飛んでいないことまで見る
    assert!(
        !server.stopped.load(std::sync::atomic::Ordering::SeqCst),
        "選んだだけで落とそうとしている"
    );
}

#[tokio::test]
async fn 確かめられない版は同意の付け方を添えて断られる() {
    pretend_supported();
    let server = TestServer::start().await;
    let state_dir = server.config.agent().resolved_state_dir();
    // 名乗るだけの版＝記録の形を答えられない（この機能より前の版と同じ）
    write_stored_version(&state_dir, "0.1.0");
    let target = target_of(&server);

    let err = client::version_select(&target, "0.1.0", false)
        .await
        .expect_err("同意なしでは断られること");
    assert_eq!(err.exit_code(), 1);
    assert!(
        err.to_string().contains("--confirm-unverified"),
        "進め方の案内が無い: {err}"
    );

    client::version_select(&target, "0.1.0", true)
        .await
        .expect("同意すれば通ること");
}

#[tokio::test]
async fn 入れ替えは生きたカードを数えて止まりforceでだけ落ちる() {
    pretend_supported();
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    // 門は一覧（記録層）から数えるので、カードが載るまで待ってから叩く
    let _card = listed_card(&server, &session).await;
    let target = target_of(&server);

    // 生きたカードが1本 → 件数を言って止まる。**落とす指示そのものを送らない**
    let err = client::version_restart(&target, false)
        .await
        .expect_err("止まること");
    assert_eq!(err.exit_code(), 1);
    assert!(
        err.to_string().contains("1 本"),
        "何本道連れになるかが無い: {err}"
    );
    assert!(
        !server.stopped.load(std::sync::atomic::Ordering::SeqCst),
        "止まると言いながら落とす指示を送っている"
    );

    // --force のときだけ、生きたまま落とす。**落ちるのは応答を返した後**（CICD設計§24
    // 「返してから落とす」）なので、旗は即時ではなく少し待って見る
    client::version_restart(&target, true)
        .await
        .expect("force なら落とせること");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !server.stopped.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "落とす指示が届いていない"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------------------
// 生で取る（`ファイル閲覧で画像とHTMLも表示する` 設計§9。テスト計画フェーズ3「CLI」）
// ---------------------------------------------------------------------------

/// 1x1 の GIF89a。**43バイトの実物。**
const 小さなGIF: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
];

#[tokio::test]
async fn 画像はバイト列のまま取れる() {
    // **文字列を経由しない**ことの裏取り。途中で `String` にすると置き換え文字が混ざり、
    // 書き出したファイルが壊れる（設計§9）
    let dir = work_dir("host-file-raw");
    let path = dir.join("撮った.gif");
    std::fs::write(&path, 小さなGIF).expect("置けること");
    let server = TestServer::start().await;

    let bytes = client::host_file_raw(&target_of(&server), "local", &path.display().to_string())
        .await
        .expect("取れること");

    assert_eq!(bytes, 小さなGIF, "1バイトも化けていないこと");
}

#[tokio::test]
async fn 生で返せない相手は理由ごと断られる() {
    let dir = work_dir("host-file-raw-refused");
    let path = dir.join("計画.md");
    std::fs::write(&path, "# 計画\n").expect("置けること");
    let server = TestServer::start().await;

    let err = client::host_file_raw(&target_of(&server), "local", &path.display().to_string())
        .await
        .expect_err("断ること");

    // **断り文をそのまま持ち上げる**（状態コードごとの言い換えをしない）
    assert!(
        format!("{err}").contains("生で返せる種別ではありません"),
        "理由が読めること: {err}"
    );
}

#[tokio::test]
async fn 従来の呼び方は一文字も変わっていない() {
    // **壊していないこと**（設計§13）。`--raw` を足しても既定の道は同じ
    let dir = work_dir("host-file-plain");
    let path = dir.join("計画.md");
    std::fs::write(&path, "# 計画\n- [x] 済み\n").expect("置けること");
    let server = TestServer::start().await;

    let (content, raw) =
        client::host_file(&target_of(&server), "local", &path.display().to_string())
            .await
            .expect("取れること");

    assert!(content.text.contains("- [x] 済み"));
    assert!(raw.contains("\"truncated\""), "生の本文もそのまま返ること");
}

#[tokio::test]
async fn 過去の一覧は_CLI_からも枠で絞れる() {
    // **画面の口は CLI からも同じようにできること**（設計§11）。画面は枠の「＋」
    // から自分の枠だけを引くので、CLI にも同じ絞り込みが要る。
    //
    // 枠は**組でしか意味を持たない**——パスだけで絞ると、同じパスの PJT を持つ
    // 別の機械のセッションが混ざる（設計§16）。
    let server = TestServer::start().await;
    let target = target_of(&server);
    let ここ = work_dir("past-here");
    let よそ = work_dir("past-there");

    // **走査元を偽装する。** 実在を確かめる側は履歴のあるものしか残さないので、
    // 塞がないと一覧が必ず空になる（設計§8-5）
    let home = work_dir("past-home");
    let 履歴置き場 = home.join(".claude").join("projects").join("どこでもよい");
    std::fs::create_dir_all(&履歴置き場).expect("作れること");
    unsafe { std::env::set_var(session_host_core::claude_home::CLAUDE_HOME_ENV, &home) };

    // 2つの枠に1本ずつ起こし、履歴を置いてから終わらせて外す
    let mut 外した = Vec::new();
    for cwd in [&ここ, &よそ] {
        let outcome = client::spawn(&target, &cwd.to_string_lossy(), None, None)
            .await
            .expect("起こせること");
        外した.push(outcome.human.clone());
    }
    let (一覧, _) = client::sessions(&target).await.expect("一覧を引けること");
    for card in &外した {
        let meta = 一覧
            .iter()
            .find(|meta| meta.card_id.to_string() == *card)
            .expect("いま起こしたカード");
        let session = meta.claude_session_id.expect("起動時に採番されていること");
        std::fs::write(履歴置き場.join(format!("{session}.jsonl")), "{}\n").expect("置けること");
    }
    // **終わらせてから外す。** 実体があるカードが指しているセッションは過去に
    // 出さない決まりなので（設計§6-4）、生かしたまま外すと一覧に出てこない
    for card in &外した {
        client::kill(&target, card).await.expect("終われること");
        client::archive(&target, card).await.expect("外せること");
    }

    let (絞った, _) = client::past_sessions(&target, Some(("local", &ここ.to_string_lossy())))
        .await
        .expect("引けること");
    assert_eq!(
        絞った.len(),
        1,
        "頼んだ枠のぶんが1本だけ返っていない: {:?}",
        絞った.iter().map(|r| r.project.0.clone()).collect::<Vec<_>>()
    );
    assert_eq!(
        絞った[0].project.0,
        ここ.to_string_lossy(),
        "頼んでいない枠のものが返っている"
    );

    // 枠を渡さなければ、両方の枠のものが見える（CLI から眺める道を塞がない）
    let (全部, _) = client::past_sessions(&target, None)
        .await
        .expect("引けること");
    assert!(
        全部.iter()
            .any(|row| row.project.0 == よそ.to_string_lossy()),
        "枠なしなのに、別の枠のものが出てこない: {:?}",
        全部.iter().map(|r| r.project.0.clone()).collect::<Vec<_>>()
    );
}
