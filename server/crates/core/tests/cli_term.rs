//! CLI の端末系の統合（テスト計画フェーズ3「画面とキー」と、`--follow`）。
//!
//! `TestServer`（実際に待ち受けるローカルモードのサーバ）を起こし、CLI の
//! クライアント層（`client::screen` など）を**直に呼ぶ**（`cli_ops.rs` と同じ流儀）。
//! 相手は擬似 claude なので課金しない。
//!
//! リサイズの観測は擬似 claude の `RESIZED` マーカーに頼る——PTY のサイズに getter は
//! 無いので、**SIGWINCH が子まで届いたこと**が「リサイズが起きた」ことの唯一の証拠になる。

// テスト名は日本語で書く。ID などの英大文字が snake_case 判定に引っかかるだけで
// 実害はないため、このファイルに限って許可する（`cli_ops.rs` と同じ扱い）
#![allow(non_snake_case)]

mod common;

use std::path::PathBuf;
use std::time::Duration;

use agentdashboard_core::client::{self, render};
use agentdashboard_core::config::Config;
use common::TestServer;
use testkit::fake_claude::{READY_MARKER, RECEIVED_PREFIX, RESIZED_PREFIX};

/// 一時の作業ディレクトリ（セッションの cwd に使う）。
fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-cli-term-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("作業ディレクトリを作れること");
    dir
}

fn target_of(server: &TestServer) -> client::Target {
    client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を読めること")
}

/// セッションの実体が**記録層に載るまで**待って、カードIDを返す（`cli_ops.rs` と同じ）。
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
// 画面（テスト計画F3「画面とキー」）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn 画面はスナップショットが届きテキストとして読める() {
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let shot = client::screen(&target, &card[..8], 120, 40)
        .await
        .expect("画面を1枚受け取れること");

    // `--raw` はこの payload をそのまま出す（エスケープ列＝リングの生バイト）
    let raw_text = String::from_utf8_lossy(&shot.payload);
    assert!(
        raw_text.contains(READY_MARKER),
        "payload に端末の生の中身が入っていること: {raw_text}"
    );
    // 既定の表示は vt100 を通したテキスト
    let text = render::render_screen(&shot.payload, shot.rows, shot.cols);
    assert!(
        text.contains(READY_MARKER),
        "描いた画面から起動の行が読めること: {text}"
    );
}

#[tokio::test]
async fn 画面の購読は端末をその大きさへリサイズする() {
    // **副作用を明示的に固定する**（CLI設計§9-2）。`SubPty` は購読と同時に PTY を
    // その大きさへリサイズするので、同じセッションをブラウザで開いている人の表示幅も
    // 変わる。`ターミナルの表示サイズがスマホに引っ張られる` が片付いて購読とサイズが
    // 分離されたら、**このテストが落ちることで気づける**
    let server = TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    client::screen(&target, &card[..8], 60, 20)
        .await
        .expect("画面を受け取れること");

    // SIGWINCH が子まで届いた＝PTY が本当にリサイズされた、の唯一の観測
    watcher.wait_for(&format!("{RESIZED_PREFIX}60x20")).await;
}

#[tokio::test]
async fn 同じ大きさで繰り返し叩いても画面は壊れない() {
    // 購読し直しでは、前の購読の増分（0x01）が新しいスナップショット（0x03）より
    // 先に届くことがある（CLI設計§15-3 の実測）。`screen` は最初の 0x03 まで読み飛ばす
    // 作りなので、間に出力を挟んで叩き直しても壊れた画面にならない
    let server = TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let first = client::screen(&target, &card[..8], 120, 40)
        .await
        .expect("1回目を受け取れること");
    assert!(
        render::render_screen(&first.payload, 40, 120).contains(READY_MARKER),
        "1回目が読めること"
    );

    // 間に出力を発生させ、増分（0x01）が流れる状況を作ってから叩き直す
    session
        .write_input("繰り返しの目印\r".as_bytes())
        .expect("入力を書けること");
    watcher.wait_for("繰り返しの目印").await;

    let second = client::screen(&target, &card[..8], 120, 40)
        .await
        .expect("2回目も受け取れること");
    let text = render::render_screen(&second.payload, 40, 120);
    assert!(
        text.contains(READY_MARKER) && text.contains("繰り返しの目印"),
        "2回目は増分ぶんも含めて読めること: {text}"
    );
}

#[tokio::test]
async fn スナップショットの前に届いた増分は読み飛ばす() {
    // 購読し直しでは、前の購読の増分（0x01）が新しいスナップショット（0x03）より先に
    // 届くことがある（CLI設計§15-3。フェーズ0 で実測）。**本物のサーバはこの順序を
    // 決定的に作れない**（新しい接続には必ず 0x03 が先に来る）ので、スタブで作る
    use futures_util::{SinkExt as _, StreamExt as _};
    use protocol::frame::{self, FrameKind};
    use protocol::ws::ServerMessage;

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
        let hello = serde_json::to_string(&ServerMessage::Hello {
            flow_high: 1,
            flow_low: 1,
        })
        .expect("組み立てられること");
        socket
            .send(tokio_tungstenite::tungstenite::Message::text(hello))
            .await
            .expect("送れること");
        // 前の購読の増分のふり（0x01）→ そのあとで本物のスナップショット（0x03）
        for (kind, payload) in [
            (FrameKind::PtyOutput, b"stale".as_slice()),
            (FrameKind::PtySnapshot, b"snapshot".as_slice()),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Binary(
                    frame::encode(kind, card, payload).into(),
                ))
                .await
                .expect("送れること");
        }
        while let Some(Ok(_)) = socket.next().await {}
    });

    let target = client::Target::from_url(&format!("http://{addr}")).expect("接続先を読めること");
    let mut ws = agentdashboard_core::client::ws::Ws::connect(&target)
        .await
        .expect("繋がること");
    let payload = client::snapshot_after(&mut ws, card)
        .await
        .expect("スナップショットが取れること");
    assert_eq!(
        payload, b"snapshot",
        "先に届いた増分（0x01）を画面として返してはいけない"
    );
}

#[tokio::test]
async fn 空のリセットの後に出し直された全画面を画面として返す() {
    // リモートのカードは「空の 0x03（リセット）→ PC が出し直した全画面（0x03）」の順で
    // 届く（CLI設計§20-1。サーバは古い全画面を持たない——gateway の subscribe_pty）。
    // 最初の 0x03 で返る素の作法（§15-3）のままだと**リモートの画面が常に空**になる。
    // フェーズ6 の受け入れ（外のサーバ越しの実測）で実際に踏んだ形をスタブで固定する
    use futures_util::{SinkExt as _, StreamExt as _};
    use protocol::frame::{self, FrameKind};
    use protocol::ws::ServerMessage;

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
        let hello = serde_json::to_string(&ServerMessage::Hello {
            flow_high: 1,
            flow_low: 1,
        })
        .expect("組み立てられること");
        socket
            .send(tokio_tungstenite::tungstenite::Message::text(hello))
            .await
            .expect("送れること");
        // 空のリセット → 途中の増分 → 出し直しの全画面
        for (kind, payload) in [
            (FrameKind::PtySnapshot, b"".as_slice()),
            (FrameKind::PtyOutput, b"partial".as_slice()),
            (FrameKind::PtySnapshot, b"remote-full".as_slice()),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Binary(
                    frame::encode(kind, card, payload).into(),
                ))
                .await
                .expect("送れること");
        }
        while let Some(Ok(_)) = socket.next().await {}
    });

    let target = client::Target::from_url(&format!("http://{addr}")).expect("接続先を読めること");
    let mut ws = agentdashboard_core::client::ws::Ws::connect(&target)
        .await
        .expect("繋がること");
    let payload = client::snapshot_after(&mut ws, card)
        .await
        .expect("スナップショットが取れること");
    assert_eq!(
        payload, b"remote-full",
        "空のリセットを画面として返してはいけない（出し直しの全画面が答え）"
    );
}

// ---------------------------------------------------------------------------
// キー（テスト計画F3「画面とキー」）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn キーは並べた順に届き確定はcrとして効く() {
    let server = TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    // space → ctrl-u → tab → enter の順で送る。擬似 claude は ctrl-u で入力行を
    // 消すので、**順序どおりなら**確定された行はタブ1文字だけになる。
    // 順序が崩れて space が ctrl-u の後に届くと、行に空白が混ざって一致しない
    let outcome = client::send_keys(
        &target,
        &card[..8],
        &[
            "space".to_string(),
            "ctrl-u".to_string(),
            "tab".to_string(),
            "enter".to_string(),
        ],
    )
    .await
    .expect("キーを送れること");

    // 受け取り証には「確かめていない」ことが載る（§16-3 の作法）
    assert!(
        outcome.raw.contains("\"confirmed\":false"),
        "確認していないことが受け取り証に無い: {}",
        outcome.raw
    );

    // enter（CR）で確定された行が、タブ**だけ**であること（順序の証明）
    watcher.wait_for(&format!("{RECEIVED_PREFIX}\t")).await;
}

#[tokio::test]
async fn 知らないキーの名前では何も送らずに断られる() {
    // 接続先の解決より手前で断る（何も送らない）ので、サーバは要らない——が、
    // 統合の経路（`send_keys`）から断られることを見る
    let server = TestServer::start().await;
    let (session, _watcher) = common::start_session(&server.manager).await;
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    let error = client::send_keys(&target, &card[..8], &["meta-x".to_string()])
        .await
        .expect_err("知らない名前で断られること");
    let text = error.to_string();
    assert!(
        text.contains("meta-x") && text.contains("enter"),
        "どの名前が駄目かと、受け付ける一覧の両方が言われること: {text}"
    );
    assert_eq!(error.exit_code(), 1, "不正な値は「断られた」（コード1）");
}

// ---------------------------------------------------------------------------
// 履歴の追いかけ（`transcript --follow`）
// ---------------------------------------------------------------------------

/// 会話1往復ぶんの最小トランスクリプト（`transcript.rs` と同じ素材）。
fn sample_lines() -> Vec<String> {
    vec![
        r#"{"type":"user","uuid":"u1","timestamp":"2026-07-29T00:00:00.000Z","version":"2.1.220","message":{"role":"user","content":"テストを流して"}}"#.to_string(),
        r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","timestamp":"2026-07-29T00:00:01.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"text","text":"流します"}]}}"#.to_string(),
    ]
}

#[tokio::test]
async fn followで後から書かれた履歴が届く() {
    let dir = work_dir("follow");
    let config = Config {
        state_dir: Some(dir.join("state")),
        ..Config::default()
    };
    let server = TestServer::start_with_parser(config).await;
    let session = server
        .manager
        .spawn(&dir.to_string_lossy())
        .expect("セッションを起動できること");
    let target = target_of(&server);
    let card = listed_card(&server, &session).await;

    // フックで transcript_path を教える（本物と同じ経路。`transcript.rs` と同じ形）
    let transcript = dir.join("session.jsonl");
    let payload = serde_json::json!({
        "session_id": "11111111-2222-3333-4444-555555555555",
        "transcript_path": transcript.to_string_lossy(),
        "hook_event_name": "SessionStart",
    });
    let status = server
        .post_hook(session.token(), "SessionStart", &payload.to_string())
        .await;
    assert_eq!(status, 204, "フックが受理されること");

    // 購読を開いてから書く——「後から届く追記」を追いかけられることが本体
    let mut stream = client::follow(&target, &card[..8])
        .await
        .expect("購読を開けること");
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&transcript)
            .expect("トランスクリプトへ書けること");
        for line in sample_lines() {
            writeln!(file, "{line}").expect("行を書けること");
        }
    }

    // Reset（購読開始の冪等化）を挟んで Append が届くまで待つ
    let mut texts: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while texts.is_empty() {
        let event = tokio::time::timeout_at(deadline, stream.next())
            .await
            .expect("20秒以内に追記が届くこと")
            .expect("追いかけを続けられること");
        if let client::FollowEvent::Append { nodes, raw } = event {
            assert!(
                raw.contains("transcript_append"),
                "raw は届いた知らせのまま"
            );
            for node in &nodes {
                if let protocol::Node::UserMessage { text, .. } = &node.node {
                    texts.push(text.clone());
                }
            }
        }
    }
    assert!(
        texts.iter().any(|text| text.contains("テストを流して")),
        "書いた本文が追記として届くこと: {texts:?}"
    );
    stream.close().await;
}
