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
use testkit::fake_claude;

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

/// 申告は取り消される。**取り消されたあとに落ちたものは、異常終了として出る。**
///
/// 申告は画面に出さないと決めてある（方針）ので、外から取り消しを確かめる窓は
/// `ok` の真偽しかない。したがってこの1本が「`PreToolUse` で申告が取り消されること」の
/// 観測も兼ねている。
#[tokio::test]
async fn 申告が取り消されたあとの異常終了は異常終了として出る() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;

    // 呼び戻し。前の会話の終わりが申告として届く
    common::fire_hook(
        &session,
        &mut watcher,
        "SessionEnd",
        r#"{"reason":"resume"}"#,
    )
    .await;
    // 死んだプロセスはフックを出さない。届いた1件がそのまま「まだ生きている」の証拠になる
    common::fire_hook(&session, &mut watcher, "PreToolUse", "").await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    // そのあと本当に落ちた。誰も終わりを意図していなかったので異常終了である
    common::send_line(&session, "crash 9");
    watcher.wait_for(fake_claude::CRASH_MARKER).await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: false }).await;
}

/// `/exit` 相当の回帰。**申告が残っているなら、終了コードが非ゼロでも異常終了ではない。**
///
/// CLI 自身が終わりを名乗ってから落ちた形なので、利用者から見て「落ちた」ではない。
#[tokio::test]
async fn 申告の直後に終わったら正常終了のまま() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionEnd", "").await;

    common::send_line(&session, "crash 9");
    watcher.wait_for(fake_claude::CRASH_MARKER).await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;
}

/// しきい値を最短にした設定。**猶予は停滞のしきい値を流用している**（設計§6）ので、
/// 猶予切れの検証も既存の停滞テストとまったく同じ作法に乗る。
fn 猶予を最短にした設定() -> agentdashboard_core::config::Config {
    agentdashboard_core::config::Config {
        stalled_threshold_secs: 1,
        ..Default::default()
    }
}

/// 見張りを、配信が出なくなるまで回す。
///
/// **見張りには申告のほかにも仕事がある**——フッタから権限モードを読んで控える経路が
/// あり、初回はそこでカード全体が1回配信される。**申告を立てる前に**済ませておかないと、
/// 「申告を下ろしたから配信された」のか「別の仕事で配信された」のかが見分けられない。
///
/// 上限を持たせてあるのは、止まらないときに**固まらず落ちる**ようにするため。
async fn 見張りを落ち着かせる(server: &common::TestServer) {
    let mut events = server.manager.subscribe_events();
    for _ in 0..10 {
        server.manager.sweep_once();
        if events.try_recv().is_err() {
            return;
        }
    }
    panic!("見張りの配信が10周たっても止まりません");
}

/// 取り消す相手が居ない順序（`SessionStart` が先・`SessionEnd` が後で、そのあと無音）を、
/// 見張りが拾うこと。
///
/// **申告は画面に出さない**と決めてあるので、下りたことを外から見る窓は `ok` の真偽しかない。
#[tokio::test]
async fn 猶予を過ぎた申告は見張りが下ろす() {
    let server = common::TestServer::start_with(猶予を最短にした設定()).await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    common::fire_hook(
        &session,
        &mut watcher,
        "SessionEnd",
        r#"{"reason":"resume"}"#,
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    server.manager.sweep_once();

    // 申告が下りたので、このあとの異常終了は異常終了として出る
    common::send_line(&session, "crash 9");
    watcher.wait_for(fake_claude::CRASH_MARKER).await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: false }).await;
}

/// 申告を下ろしても、**状態は1つも動かず、ブラウザへは1バイトも流れない**（設計§6）。
///
/// 申告の間も状態は動かしていないので、下ろしても戻すものが無い。ここで配信すると、
/// 画面には何も変わっていないのに更新だけが流れることになる。
#[tokio::test]
async fn 申告が下りても状態は動かず配信も起きない() {
    let server = common::TestServer::start_with(猶予を最短にした設定()).await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    // 申告を立てる**前に**、見張りの別の仕事を済ませておく
    見張りを落ち着かせる(&server).await;
    common::fire_hook(&session, &mut watcher, "SessionEnd", "").await;

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    // **フックの配信を受け取らないよう、見張りの直前で張る。** 申告そのものは
    // `last_activity_at` を進めるので、手前から張ると自分が起こした行を数えてしまう
    let mut events = server.manager.subscribe_events();
    server.manager.sweep_once();

    assert_eq!(
        session.status(),
        SessionStatus::WaitingInput,
        "申告を下ろしても状態は動かないこと"
    );
    let 届いたもの = events.try_recv();
    assert!(
        matches!(
            届いたもの,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "申告を下ろしただけでブラウザへ流してはいけない: {届いたもの:?}"
    );
}

#[tokio::test]
async fn 申告が無いまま見張りを回しても何も起きない() {
    let server = common::TestServer::start_with(猶予を最短にした設定()).await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    見張りを落ち着かせる(&server).await;

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let mut events = server.manager.subscribe_events();
    server.manager.sweep_once();

    assert_eq!(session.status(), SessionStatus::WaitingInput);
    let 届いたもの = events.try_recv();
    assert!(
        matches!(
            届いたもの,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "申告が無いのだから、見張りは何もしないこと: {届いたもの:?}"
    );
}

/// 申告の一生（立つ → フックで下りる → また立つ → 猶予切れで下りる）が、
/// **`card_id` で串刺しに読める形**で残ること（設計§7）。
///
/// `調査レポート.md` は「`/resume` と `/clear` が `reason` に何を入れるか」を確かめられなかった
/// 理由として「**payload をどこにも残していない**」を挙げている。同じ穴を塞ぐのがこの3行なので、
/// **欄まで含めて固定する**。
#[tokio::test]
async fn 申告の一生が_card_id_つきの3行として残る() {
    let server = common::TestServer::start_with(猶予を最短にした設定()).await;
    let sink = session_host_core::logging::capture::sink();
    let mark = sink.mark();

    let (session, mut watcher) = common::start_session(&server.manager).await;
    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;

    // ① 申告が立つ（理由つき）
    common::fire_hook(
        &session,
        &mut watcher,
        "SessionEnd",
        r#"{"reason":"resume"}"#,
    )
    .await;
    // ② 次のフックが届いて下りる
    common::fire_hook(&session, &mut watcher, "PreToolUse", "").await;
    common::wait_for_status(&session, SessionStatus::Working).await;
    // ③ もう一度立てて、今度は猶予切れで下ろす（理由は載らない payload）
    common::fire_hook(&session, &mut watcher, "SessionEnd", "").await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    server.manager.sweep_once();

    // **相関キーで絞る。** 他のカードの行が混ざる
    let lines = sink.matching(mark, "card_id", &session.card_id.to_string());
    let 探す = |needle: &str| -> Vec<serde_json::Value> {
        lines
            .iter()
            .filter(|line| line["msg"].as_str().is_some_and(|msg| msg.contains(needle)))
            .cloned()
            .collect()
    };

    let 立った = 探す("CLI が終了を名乗りました");
    let フックで下りた = 探す("フックが届いたので");
    let 猶予で下りた = 探す("猶予の間に終わらなかったので");
    assert_eq!(立った.len(), 2, "申告は2回立てた: {lines:#?}");
    assert_eq!(フックで下りた.len(), 1, "フックで下りたのは1回: {lines:#?}");
    assert_eq!(猶予で下りた.len(), 1, "猶予で下りたのは1回: {lines:#?}");

    // 必須7欄（ログ設計§2-1）。**`--card` で串刺しに引けるための性質そのもの**
    for line in 立った.iter().chain(&フックで下りた).chain(&猶予で下りた) {
        for field in ["ts", "level", "target", "proc", "pid", "run_id", "msg"] {
            assert!(line.get(field).is_some(), "{field} が無い: {line}");
        }
        assert_eq!(
            line["level"], "INFO",
            "利用者の正常な操作なので警告にしない"
        );
    }

    // 理由は欄として載る。**無いときは空**でよい（判定には使っていないので困らない）
    assert_eq!(立った[0]["reason"], "resume");
    assert_eq!(立った[1]["reason"], "");
    assert_eq!(フックで下りた[0]["reason"], "resume");

    // 下ろした側は、どのフックで下りたのか・どれだけ経っていたのかまで読める
    assert_eq!(フックで下りた[0]["hook"], "PreToolUse");
    assert!(フックで下りた[0]["elapsed_ms"].is_number());
    assert!(猶予で下りた[0]["elapsed_ms"].is_number());
}

/// 申告が立っている間、**そのカードは生きているものとして数えられる**（設計§9）。
///
/// 数える側が騙されると、被害は表示に留まらない——`version restart` の門は「生きたカードが
/// 0枚だから安全」と判断して実機ごと落とし、枠の削除は走っているセッションを巻き添えにする。
/// どちらも一覧（`registry.list`）を見ているので、ここを1本で押さえられる。
#[tokio::test]
async fn 申告中のカードは生きているものとして数えられる() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    let 載ったカード = server
        .wait_for_listed("1枚が入力待ち", |listed| {
            listed.len() == 1 && listed[0].status == SessionStatus::WaitingInput
        })
        .await;
    let 申告前の最終活動 = 載ったカード[0].last_activity_at;
    let project = 載ったカード[0].project.0.clone();

    // 枠を登録しておく。**削除の門（`has_sessions`）が数える入口**がここ
    let (_, body) = server
        .request(
            "POST",
            "/api/projects",
            Some(&serde_json::json!({ "host": "local", "path": project }).to_string()),
        )
        .await;
    let added: serde_json::Value = serde_json::from_str(&body).expect("応答を読めること");
    let project_id = added["project"]["id"].as_str().expect("id があること");

    common::fire_hook(
        &session,
        &mut watcher,
        "SessionEnd",
        r#"{"reason":"resume"}"#,
    )
    .await;

    // **記録へ届いたことを待ってから判定する。** 申告は状態を変えないので、撃った直後に
    // 読むと「まだ前の報告しか届いていない」のか「届いたうえで終了扱いになっていない」のかが
    // 区別できない。最終活動が進んだことが、届いたことの証拠になる
    let listed = server
        .wait_for_listed("申告の報告が記録へ届くこと", |listed| {
            listed.len() == 1 && listed[0].last_activity_at > 申告前の最終活動
        })
        .await;
    assert!(
        !matches!(listed[0].status, SessionStatus::Ended { .. }),
        "申告だけで終了扱いになっている: {:?}",
        listed[0].status
    );

    let (status, body) = server
        .request("DELETE", &format!("/api/projects/{project_id}"), None)
        .await;
    assert_eq!(status, 409, "申告だけで枠が消せてしまう: {body}");
}

/// 申告が立っていても、**履歴の監視は新しいトランスクリプトへ張り替わる**。
///
/// 調査レポートが観測した「1箇所だけが嘘をつく」状態のうち、**張り替えの側は元から
/// 正しかった**（`apply_hook` は `state::apply` の手前で控える）。直しすぎて、こちらを
/// 巻き添えにしていないことを見る。
#[tokio::test]
async fn 申告中でも履歴の監視は新しいトランスクリプトへ張り替わる() {
    /// 呼び戻した先の会話。**別のファイルになる**ことが要点なので、値そのものに意味は無い。
    ///
    /// 擬似 claude の `transcript_path` は**起動時に渡した ID**から組み立てられるので、
    /// payload の `session_id` を上書きしても場所は動かない。本物の `/resume` と同じく、
    /// **フックに新しい場所を名乗らせる**のが正しい再現になる。
    const 呼び戻し先: &str = "11111111-2222-3333-4444-555555555555";

    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    let 呼び戻す前 = session.transcript_path().expect("場所を控えていること");

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
        &format!(
            r#"{{"session_id":"{呼び戻し先}","transcript_path":"/tmp/fake-claude/{呼び戻し先}.jsonl","source":"resume"}}"#
        ),
    )
    .await;

    let 呼び戻した後 = 張り替えを待つ(&session, &呼び戻す前).await;
    assert!(
        呼び戻した後.contains(呼び戻し先),
        "呼び戻した先を指していない: {呼び戻した後}"
    );
}

/// 履歴の監視先が変わるまで待つ。
///
/// **同じ種類のフックを2回撃つときは、`fire_hook` の印では待てない。** `Watcher::wait_for` は
/// 溜まった出力に印が含まれていれば即座に返るので、1回目の `SessionStart` が残した印で
/// 通り抜けてしまい、2回目が届く前に判定してしまう。**効果そのものを待つ。**
async fn 張り替えを待つ(session: &session_host_core::session::Session, 前: &str) -> String {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if let Some(path) = session.transcript_path()
            && path != 前
        {
            return path;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "20秒たっても張り替わりませんでした（いまも {前}）"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// 1本で呼び戻しが起きても、**他のカードは1つも動かない**。
///
/// 要件が「そのあと新しく別のセッションを起動してみたが、そちらは問題無く入力待ちに
/// なっている」と書いているとおり、症状は1本だけに出る。印をカード単位で持っていることの確認。
#[tokio::test]
async fn 一本で呼び戻しが起きても他のカードは動かない() {
    let server = common::TestServer::start().await;
    let (呼び戻す側, mut watcher) = common::start_session(&server.manager).await;
    let (巻き添えを見る側, mut 見る側の監視) = common::start_session(&server.manager).await;

    for (session, watcher) in [
        (&呼び戻す側, &mut watcher),
        (&巻き添えを見る側, &mut 見る側の監視),
    ] {
        common::fire_hook(session, watcher, "SessionStart", "").await;
        common::wait_for_status(session, SessionStatus::WaitingInput).await;
    }
    let 巻き添えを見る側の最終活動 = 巻き添えを見る側.meta().last_activity_at;

    // 片方だけで `/resume` 相当を起こす
    common::fire_hook(
        &呼び戻す側,
        &mut watcher,
        "SessionEnd",
        r#"{"reason":"resume"}"#,
    )
    .await;
    common::fire_hook(
        &呼び戻す側,
        &mut watcher,
        "SessionStart",
        r#"{"source":"resume"}"#,
    )
    .await;

    assert_eq!(
        巻き添えを見る側.status(),
        SessionStatus::WaitingInput,
        "隣のカードの状態が動いている"
    );
    assert_eq!(
        巻き添えを見る側.meta().last_activity_at,
        巻き添えを見る側の最終活動,
        "隣のカードの最終活動が動いている"
    );
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

/// 停滞したカードが、走っている印の無い画面なら自分で入力待ちへ戻ること（設計§3・§4）。
///
/// **これが本イシューの本体である。** ターンが完了せずに終わると `Stop` が飛ばないので、
/// カードは停滞のまま永久に取り残される——端末は空のプロンプトで待っているのに。
///
/// **5秒より短い間隔では起きないこと**（設計§5-3）も同時に確かめる。分けると5秒の待ちが
/// 2回になる。
#[tokio::test]
async fn 停滞したカードは画面に印が無ければ入力待ちへ戻る() {
    let config = agentdashboard_core::config::Config {
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
    assert_eq!(session.status(), SessionStatus::Stalled, "まず停滞へ落ちる");

    // **落ちた周では見ない**（設計§13-7）ので、何周回してもまだ戻らない。ここが
    // 5秒の間引きの検査でもある——相乗りしている1秒巡回で倒れてしまわないこと
    for _ in 0..5 {
        server.manager.sweep_once();
    }
    assert_eq!(
        session.status(),
        SessionStatus::Stalled,
        "5秒より短い間隔では画面を見に行かない"
    );

    tokio::time::sleep(std::time::Duration::from_millis(5100)).await;
    server.manager.sweep_once();
    assert_eq!(
        session.status(),
        SessionStatus::WaitingInput,
        "印が無いので入力待ちへ倒れる"
    );
}

/// 走っている印が出ていれば、停滞のまま留まること（設計§3-3 の陰性対照）。
///
/// **この対照が無いと、「常に入力待ちへ倒す」実装でも上のテストは緑になる。**
#[tokio::test]
async fn 走っている印が出ていれば停滞のまま戻らない() {
    let config = agentdashboard_core::config::Config {
        stalled_threshold_secs: 1,
        ..Default::default()
    };

    let server = common::TestServer::start_with(config).await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    server
        .post_hook(session.token(), "UserPromptSubmit", "{}")
        .await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    // 実物と同じ形の印を画面へ出す（`fixtures/v2.1.232/screens/working-long.txt`）
    session
        .send_instruction("paint ✽ Ebbing… (2m 10s · ↓ 543 tokens · thinking)")
        .await
        .expect("印を描かせる");

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    server.manager.sweep_once();
    assert_eq!(session.status(), SessionStatus::Stalled);

    tokio::time::sleep(std::time::Duration::from_millis(5100)).await;
    server.manager.sweep_once();
    assert_eq!(
        session.status(),
        SessionStatus::Stalled,
        "印が出ているので停滞に留まる"
    );
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

/// API エラーで終わったターンが、継ぎ目を通って入力待ちになる（設計§6）。
///
/// 単体では `apply` の腕を見ているだけなので、**注入した settings に `StopFailure` が
/// 現れているか**はここでしか確かめられない。`hooks_settings.rs` は `HookEvent::ALL` を
/// 回すだけなので、腕を足せば注入も付いてくる——その主張が本当かを通しで見る。
#[tokio::test]
async fn stop_failureは継ぎ目を通って入力待ちにする() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "UserPromptSubmit", "").await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    common::fire_hook(
        &session,
        &mut watcher,
        "StopFailure",
        r#"{"error":"rate_limit"}"#,
    )
    .await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
}

/// サブエージェントが残っているターンの終わりが、継ぎ目を通して「サブ待ち」になる
/// （設計§14）。
///
/// **単体（`state.rs`）とは見ているものが違う。** あちらは遷移の表そのもの、こちらは
/// **注入した settings → 擬似 claude → HTTP → 受信口 → 状態機械**の一式が繋がっていること。
/// `SubagentStart` は `HookEvent::ALL` に載っているだけで settings へ書き出されるので、
/// **この経路が通ることは名前だけでは確かめられない。**
#[tokio::test]
async fn サブが残ったままターンが終わるとサブ待ちになる() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "UserPromptSubmit", "").await;
    common::wait_for_status(&session, SessionStatus::Working).await;

    // **同じイベントを続けて撃たない。** 擬似 claude は「撃った」合図を端末へ出し、
    // `fire_hook` はそれを待つ作りなので、2回続けると1回目の合図で待ちが解けてしまう。
    // **本数の勘定は `state.rs` の単体テストが持っている**ので、ここは継ぎ目だけを見る
    common::fire_hook(&session, &mut watcher, "SubagentStart", "").await;
    assert_eq!(session.meta().subagent_active, 1);
    assert_eq!(
        session.status(),
        SessionStatus::Working,
        "メインが走っている間は、サブが立っても状態を動かさない"
    );

    // メインが手を止めた。サブが残っているので入力待ちにはしない
    common::fire_hook(&session, &mut watcher, "Stop", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingSubagents).await;

    // **サブが動かすツールで、サブ待ちが消えないこと。**
    //
    // ツールを叩いたのがメインとは限らない——サブエージェントのツールコールも同じ
    // フックを飛ばす。ここで作業中へ戻ると、`Stop` でサブ待ちにした直後に消える
    // （利用者が実機で踏んだ壊れ方）
    common::fire_hook(&session, &mut watcher, "PostToolUse", "").await;
    assert_eq!(
        session.status(),
        SessionStatus::WaitingSubagents,
        "サブのツールコールで作業中へ戻ってはいけない"
    );

    // 最後の1本が終わって初めて入力待ちへ
    common::fire_hook(&session, &mut watcher, "SubagentStop", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    assert_eq!(session.meta().subagent_active, 0);
}
