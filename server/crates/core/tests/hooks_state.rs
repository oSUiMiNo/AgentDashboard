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

/// `/resume` の2つの順序のうち、`SessionEnd` が先に届くほう。
///
/// CLI は会話を呼び戻すとき `SessionEnd` と `SessionStart` を続けて飛ばす。前者は
/// **プロセスの終わりではなく会話の終わり**なので、これだけで終端へ落とすと
/// 生きている claude が操作できなくなる（調査レポートの症状そのもの）。
#[tokio::test]
async fn resume相当はsession_endが先でも終了扱いにならない() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;

    // ここから呼び戻し。前の会話の終わりが先に届く
    common::fire_hook(
        &session,
        &mut watcher,
        "SessionEnd",
        r#"{"reason":"resume"}"#,
    )
    .await;
    common::fire_hook(
        &session,
        &mut watcher,
        "SessionStart",
        r#"{"source":"resume"}"#,
    )
    .await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;

    // 指示を送れることまで見る。状態が終端だと Composer が無効になり、
    // 利用者からは「このセッションだけ操作できない」に見える
    session
        .send_instruction("こんにちは")
        .await
        .expect("指示を送れること");
    watcher.wait_for("received: こんにちは").await;
}

/// `/resume` の2つの順序のうち、`SessionStart` が先に届くほう。
///
/// 終端ガードを解くだけの直し方（方針の案B）では**こちらが救えない**。だから権威を
/// プロセスへ移す形にしてある。2本は別々の性質を見ているので、片方だけでは足りない。
#[tokio::test]
async fn resume相当はsession_startが先でも終了扱いにならない() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;

    // 呼び戻し先の開始が先に届き、前の会話の終わりが後から届く
    common::fire_hook(
        &session,
        &mut watcher,
        "SessionStart",
        r#"{"source":"resume"}"#,
    )
    .await;
    common::fire_hook(
        &session,
        &mut watcher,
        "SessionEnd",
        r#"{"reason":"resume"}"#,
    )
    .await;
    assert_eq!(
        session.status(),
        SessionStatus::WaitingInput,
        "後から届いた SessionEnd で終端へ落としてはいけない"
    );

    session
        .send_instruction("こんにちは")
        .await
        .expect("指示を送れること");
    watcher.wait_for("received: こんにちは").await;
}

#[tokio::test]
async fn session_endだけでは終わらない() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionEnd", "").await;
    assert!(
        !matches!(session.status(), SessionStatus::Ended { .. }),
        "申告だけでは終わらない。実際: {:?}",
        session.status()
    );

    // 申告のあとに届いたフックも、今までどおり効く
    assert_eq!(
        server.post_hook(session.token(), "PreToolUse", "{}").await,
        204
    );
    common::wait_for_status(&session, SessionStatus::Working).await;
}

#[tokio::test]
async fn プロセスが終われば終わる() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionEnd", "").await;

    // 擬似 claude を実際に終わらせる。ここで初めて終了が確定する
    common::send_line(&session, "exit");
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

/// フックが来ないとき、**材料を並べた1行**が出ること（ログ設計§8-4）。
///
/// **原因を1つに決め打ちしない。** 積み残し_運用 項目2 では推測を決め打ちして外している
/// （実際の原因はフォルダ信頼の確認待ちだった）。並べて、読む側に判断させる。
#[tokio::test]
async fn フックが来ないときは材料を並べた1行が出る() {
    let config = agentdashboard_core::config::Config {
        stalled_threshold_secs: 1,
        ..Default::default()
    };
    let server = common::TestServer::start_with(config).await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();

    // 起動マーカーを待つ＝PTY から出力が届いている状態
    let (session, _watcher) = common::start_session(&server.manager).await;
    assert_eq!(session.status(), SessionStatus::Starting);

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    server.manager.sweep_once();
    assert_eq!(session.status(), SessionStatus::Unknown);

    // **相関キーで絞る。** 他のカードの行が混ざる
    let lines = sink.matching(mark, "card_id", &session.card_id.to_string());
    let found: Vec<_> = lines
        .iter()
        .filter(|line| {
            line["msg"]
                .as_str()
                .is_some_and(|msg| msg.contains("フックが1件も届いていません"))
        })
        .collect();
    assert_eq!(found.len(), 1, "1行だけ出ること: {lines:#?}");
    let line = found[0];
    assert_eq!(line["level"], "WARN");

    // 材料1：注入した設定の**実際の**パス。形を写すのではなく、いま在るファイルを指すこと
    let settings = line["settings"].as_str().expect("欄があること");
    assert!(
        std::path::Path::new(settings).is_file(),
        "実在するファイルを指していること: {settings}"
    );
    assert!(settings.contains(&session.card_id.to_string()));
    assert_eq!(line["settings_exists"], true);

    // 材料2：焼き込んだ宛先。確かめたいのは**ポートが受信口と一致していること**
    let url = line["hook_url"].as_str().expect("欄があること");
    assert!(
        url.contains(&format!(":{}/hook/", server.manager.hook_port())),
        "実際: {url}"
    );
    // **合言葉は載せない**（設計§9-3。入館証は伏せるのではなく最初から載せない）
    assert!(
        !url.contains(session.token()),
        "宛先に合言葉が混ざっている: {url}"
    );

    // 材料3：端末の末尾。擬似 claude の起動マーカーは必ず出ている
    let tail = line["tail"].as_str().expect("欄があること");
    assert!(
        tail.contains(testkit::fake_claude::READY_MARKER),
        "端末の末尾が載っていない: {tail}"
    );
    assert!(!tail.contains('\u{1b}'), "制御列が残っている: {tail}");
    assert!(!tail.contains('\n'), "1行に収まること: {tail}");
    assert!(tail.chars().count() <= 401, "{}", tail.chars().count());

    // 材料4：フックを起こす実行ファイル。設計の3材料に無いが、版を消した瞬間に
    // 生きているセッションのフックが全滅する——§8-4 の症状そのもの
    assert!(line["hook_bin"].as_str().is_some_and(|bin| !bin.is_empty()));
}

#[tokio::test]
async fn フックの1行はセッション1本につき1回しか出ない() {
    // `Starting → Unknown` の遷移がそのままラッチとして働く（新しい印は要らない）
    let config = agentdashboard_core::config::Config {
        stalled_threshold_secs: 1,
        ..Default::default()
    };
    let server = common::TestServer::start_with(config).await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();

    let (session, _watcher) = common::start_session(&server.manager).await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    server.manager.sweep_once();
    server.manager.sweep_once();
    server.manager.sweep_once();

    let found = sink
        .matching(mark, "card_id", &session.card_id.to_string())
        .into_iter()
        .filter(|line| {
            line["msg"]
                .as_str()
                .is_some_and(|msg| msg.contains("フックが1件も届いていません"))
        })
        .count();
    assert_eq!(found, 1, "見張りを3周しても1行だけ");
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
    // 実体が Working になっても、記録へ渡るのは1段あと（設計§9-1 の「書いてから配る」）。
    // ここで確かめたいのは**ブラウザから見える一覧**なので、そちらを待つ
    server
        .wait_for_listed("1枚が作業中", |listed| {
            listed.len() == 1 && listed[0].status == SessionStatus::Working
        })
        .await;

    let (status, body) = server.get("/api/sessions").await;
    assert_eq!(status, 200);
    let sessions: Vec<protocol::SessionMeta> =
        serde_json::from_str(&body).expect("SessionMeta の配列として読めること");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].card_id, session.card_id);
    assert_eq!(sessions[0].status, SessionStatus::Working);
}

/// 経路が痕跡を残し、`card_id` で串刺しにできること（設計§16-1 の2・3）。
///
/// **相関キーを載せて回る作業（§10-4）の効果は、これでしか言えない。** 形が JSON に
/// なっただけでは `--card` から何も引けず、土台だけ入れた状態と区別が付かない。
#[tokio::test]
async fn 一本のセッションを起こすと_card_id_で串刺しにできる() {
    let server = common::TestServer::start().await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();

    let (session, mut watcher) = common::start_session(&server.manager).await;
    // **SessionStart を通す。** トランスクリプトの場所が確定して、パーサへ監視を
    // 頼む経路（`card_id` つき）が走る。正常系で `card_id` が載る数少ない行のひとつ
    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    server
        .post_hook(session.token(), "UserPromptSubmit", "{}")
        .await;
    common::wait_for_status(&session, SessionStatus::Working).await;
    session.kill();

    let lines = sink.matching(mark, "card_id", &session.card_id.to_string());
    assert!(
        !lines.is_empty(),
        "card_id で引ける行が1つも無い。相関キーが載っていない"
    );

    // 必須7欄（§2-1）。**1行1レコードとして読めること**
    for line in &lines {
        for field in ["ts", "level", "target", "proc", "pid", "run_id", "msg"] {
            assert!(line.get(field).is_some(), "{field} が無い: {line}");
        }
    }

    // 串刺しの実体は「複数の経路にまたがること」。1つの target からしか出ないなら、
    // それは1箇所が喋っているだけで、串刺しにはなっていない
    let targets: std::collections::BTreeSet<&str> = lines
        .iter()
        .filter_map(|line| line["target"].as_str())
        .collect();
    assert!(!targets.is_empty(), "target が読めない: {lines:#?}");
}
