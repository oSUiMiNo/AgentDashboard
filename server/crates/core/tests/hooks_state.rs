//! フックの受信から状態表示までの通し確認
//! （テスト計画フェーズ2「HookIngest」「状態機械」）。
//!
//! ここでは実際に core を待ち受けさせ、擬似 claude に**注入した settings のフックを
//! 本当に起動させて**検証する。単体テストで遷移表そのものは網羅している（`state.rs`）が、
//! 「settings の生成 → CLI がフックを起動 → `hook-post` が転送 → 受信口が合言葉を照合 →
//! 状態機械が回る → 差分が配信される」という**継ぎ目**は、通してみないと確かめられない。

mod common;

use protocol::{SessionStatus, ws::ServerMessage};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// 合言葉を知らない相手からの通知は受け付けない。
#[tokio::test]
async fn 合言葉が違うフックは拒否される() {
    let server = common::TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    assert_eq!(
        server
            .post_hook("でたらめな合言葉", "PreToolUse", "{}")
            .await,
        404,
        "カードの存在を漏らさないため一律で見つからない扱いにする"
    );
    assert_eq!(
        session.status(),
        SessionStatus::Starting,
        "状態は動かないこと"
    );

    assert_eq!(
        server.post_hook(session.token(), "PreToolUse", "{}").await,
        204,
        "正しい合言葉なら受理される"
    );
    common::wait_for_status(&session, SessionStatus::Working).await;
}

#[tokio::test]
async fn 注入していないイベント名は受け流す() {
    let server = common::TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    // Claude Code が将来イベントを増やしても、4xx を返してログを汚さない
    assert_eq!(
        server.post_hook(session.token(), "PreCompact", "{}").await,
        204
    );
    assert_eq!(session.status(), SessionStatus::Starting);
}

#[tokio::test]
async fn 壊れたjsonでも受理して状態だけは進める() {
    let server = common::TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    assert_eq!(
        server
            .post_hook(session.token(), "UserPromptSubmit", "{壊れている")
            .await,
        204
    );
    common::wait_for_status(&session, SessionStatus::Working).await;
}

#[tokio::test]
async fn 待ち受けはループバックだけに開いている() {
    let server = common::TestServer::start().await;

    // 127.0.0.1 では繋がる
    assert!(std::net::TcpStream::connect(server.addr).is_ok());

    // 同じポートでも、外向きのアドレスでは待ち受けていない
    let host_ip = local_ipv4();
    if let Some(ip) = host_ip {
        let outside = SocketAddr::new(IpAddr::V4(ip), server.addr.port());
        assert!(
            std::net::TcpStream::connect_timeout(&outside, std::time::Duration::from_millis(300))
                .is_err(),
            "ループバック以外にも開いている: {outside}"
        );
    }
}

/// この機械の外向きIPv4アドレス（無ければ `None`）。
fn local_ipv4() -> Option<Ipv4Addr> {
    // 外へパケットは出さない。接続先を決める過程でOSが選ぶ送信元アドレスだけを見る
    let socket = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("192.0.2.1", 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

/// 擬似 claude が実際にフックを起動する経路で、設計§5 の一連の遷移をたどる。
#[tokio::test]
async fn 注入したフックが起動して状態が順に変わる() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;
    let mut events = common::EventWatcher::attach(&server.manager);

    // 起動しただけではフックが1件も来ていないので「起動中」のまま
    assert_eq!(session.status(), SessionStatus::Starting);

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;

    // CLI 側のセッションIDとトランスクリプトの場所が、フック経由で確定する。
    // 擬似 claude は起動引数で受け取ったIDをそのまま payload に載せるので、
    // 「ダッシュボードが採番した値が CLI を一周して戻ってくる」ことの確認になる
    assert!(session.meta().claude_session_id.is_some());
    assert!(
        session
            .transcript_path()
            .is_some_and(|path| path.ends_with(".jsonl")),
        "JSONL の場所を控えていること（フェーズ3のパーサが使う）"
    );

    common::fire_hook(&session, &mut watcher, "UserPromptSubmit", "").await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    // 権限確認は型フィールドで判定する（メッセージ文字列の解析は不要）
    common::fire_hook(
        &session,
        &mut watcher,
        "Notification",
        r#"{"notification_type":"permission_prompt"}"#,
    )
    .await;
    common::wait_for_status(&session, SessionStatus::WaitingPermission).await;

    // ターミナルで直接許可した場合、許可されたことを伝えるフックは無い。
    // 次のツール実行で自然に復帰するのが唯一の経路（設計§5）
    common::fire_hook(&session, &mut watcher, "PreToolUse", "").await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    // サブエージェントはバッジの数だけを動かす
    common::fire_hook(&session, &mut watcher, "SubagentStart", "").await;
    assert_eq!(session.meta().subagent_active, 1);
    assert_eq!(session.status(), SessionStatus::Working);
    common::fire_hook(&session, &mut watcher, "SubagentStop", "").await;
    assert_eq!(session.meta().subagent_active, 0);

    // Stop は直前の応答を運んでくるので、JSONL を読まずに小窓へ要約を出せる
    common::fire_hook(
        &session,
        &mut watcher,
        "Stop",
        r#"{"last_assistant_message":"テストが通りました"}"#,
    )
    .await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    assert_eq!(
        session.meta().last_assistant_message.as_deref(),
        Some("テストが通りました")
    );

    // 差分と全体、どちらの配信も実際に流れていること
    let seen_status = events
        .wait_for("status 差分", |message| {
            matches!(message, ServerMessage::Status { .. })
        })
        .await;
    assert!(matches!(seen_status, ServerMessage::Status { .. }));
}

#[tokio::test]
async fn session_endを受けたら正常終了として扱う() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionEnd", "").await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    // 終わったカードは、後から届いたフックで生き返らない
    assert_eq!(
        server.post_hook(session.token(), "PreToolUse", "{}").await,
        204
    );
    assert_eq!(session.status(), SessionStatus::Ended { ok: true });
}

#[tokio::test]
async fn 作業中のまま無音が続くと停滞として表示される() {
    let config = agentdashboard_core::config::Config {
        // 判定を待っていられないので、しきい値を最短にする（意味は同じ）
        stalled_threshold_secs: 1,
        ..Default::default()
    };

    let server = common::TestServer::start_with(config).await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    server
        .post_hook(session.token(), "UserPromptSubmit", "{}")
        .await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    server.manager.sweep_once();
    assert_eq!(session.status(), SessionStatus::Stalled);

    // 何かフックが届けば作業中へ戻る
    server.post_hook(session.token(), "PostToolUse", "{}").await;
    common::wait_for_status(&session, SessionStatus::Working).await;
}

#[tokio::test]
async fn 出力はあるのにフックが来なければ判断できない状態になる() {
    // 設計§11。注入した settings が効いていない（ポートが塞がっている等）とき、
    // 一覧が「起動中」のまま灰色で止まると、利用者は原因に気づけない
    let config = agentdashboard_core::config::Config {
        stalled_threshold_secs: 1,
        ..Default::default()
    };

    let server = common::TestServer::start_with(config).await;
    // 起動マーカーを待つ＝PTY から出力が届いている状態
    let (session, _watcher) = common::start_session(&server.manager).await;
    assert_eq!(session.status(), SessionStatus::Starting);
    assert!(!session.meta().hooks_seen);

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    server.manager.sweep_once();
    assert_eq!(session.status(), SessionStatus::Unknown);

    // フックが届き始めれば普通の状態表示に戻る
    server
        .post_hook(session.token(), "UserPromptSubmit", "{}")
        .await;
    common::wait_for_status(&session, SessionStatus::Working).await;
    assert!(session.meta().hooks_seen);
}

#[tokio::test]
async fn api_sessionsが現在の一覧を返す() {
    let server = common::TestServer::start().await;

    let (status, body) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
    assert_eq!(body.trim(), "[]", "まだ何も起動していない");

    let (session, _watcher) = common::start_session(&server.manager).await;
    server
        .post_hook(session.token(), "UserPromptSubmit", "{}")
        .await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    let (status, body) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
    let sessions: Vec<protocol::SessionMeta> =
        serde_json::from_str(&body).expect("SessionMeta の配列として読めること");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].card_id, session.card_id);
    assert_eq!(sessions[0].status, SessionStatus::Working);
}
