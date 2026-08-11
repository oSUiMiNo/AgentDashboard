//! CLI のクライアント層（`client`）の統合テスト（CLIテスト計画 フェーズ3「読む系」）。
//!
//! `TestServer` を起こして、**クライアント層の関数を直に呼ぶ**。実行ファイルは起こさない
//! ——起こすと `dist` の入口と引数解釈まで束になり、落ちたときにどの層が壊れたのか
//! 分からなくなる。引数の解釈は `cli.rs` の単体テストが別に見ている。
//!
//! 相手はローカルモードの `TestServer`（`AuthMode::Open`・127.0.0.1 は素通し）なので、
//! 札を作らずに読む系の全部を通せる（CLI設計§13 の段1 が成り立つ根拠そのもの）。

// テスト名は日本語で書いている。英大文字（ID / PJT 等）が混ざると snake_case 判定に
// 引っかかるだけで実害はないため、このファイルに限って許可する。
#![allow(non_snake_case)]

mod common;

use agentdashboard_core::client;
use agentdashboard_core::config::Config;
use common::TestServer;
use std::path::PathBuf;

/// テストごとに独立した作業場所（`transcript.rs` と同じ理由——再開位置の混線防止）。
fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-cli-client-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("作業ディレクトリを作れること");
    dir
}

fn target_of(server: &TestServer) -> client::Target {
    client::Target::from_url(&format!("http://{}", server.addr)).expect("接続先を作れること")
}

#[tokio::test]
async fn 一覧を引くと起こしたセッションが載っている() {
    let server = TestServer::start().await;
    let target = target_of(&server);

    // まだ何も無い
    let (empty, raw) = client::sessions(&target).await.expect("一覧を引けること");
    assert!(empty.is_empty());
    assert_eq!(raw.trim(), "[]", "生の本文はサーバの応答そのもの");

    let (session, _watcher) = common::start_session(&server.manager).await;
    server
        .wait_for_listed("1枚が載る", |listed| listed.len() == 1)
        .await;

    let (listed, _) = client::sessions(&target).await.expect("一覧を引けること");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].card_id, session.card_id);
}

#[tokio::test]
async fn 前方一致の短いIDで一件に絞れる() {
    let server = TestServer::start().await;
    let target = target_of(&server);
    let (session, _watcher) = common::start_session(&server.manager).await;
    server
        .wait_for_listed("1枚が載る", |listed| listed.len() == 1)
        .await;

    // UUID の先頭8文字（画面や `session ls` に出る形そのまま）で絞る
    let full = session.card_id.to_string();
    let (meta, raw_element) = client::session_show(&target, &full[..8])
        .await
        .expect("絞れること");
    assert_eq!(meta.card_id, session.card_id);
    // 生の切り出しはその1件の JSON になっている（配列ではない）
    let value: serde_json::Value =
        serde_json::from_str(&raw_element).expect("切り出しも JSON のまま");
    assert_eq!(value["card_id"].as_str(), Some(full.as_str()));

    // **生の切り出しは一覧の該当要素とバイト一致する**（CLI設計§10-2。コードレビュー対応10）。
    // `serde_json::Value` を経由すると鍵が辞書順へ並び替わり、整形も変わる
    let (_, raw_list) = client::sessions(&target).await.expect("一覧を引けること");
    let element = raw_list
        .trim()
        .strip_prefix('[')
        .and_then(|rest| rest.trim().strip_suffix(']'))
        .expect("一覧は配列")
        .trim();
    assert_eq!(
        raw_element, element,
        "show の切り出しが一覧の要素と食い違っている（並べ替えや整形をしていないか）"
    );

    // 当たらない指定は「見つかりません」で断られる（終了コード1の族）
    let err = client::session_show(&target, "ffffffff")
        .await
        .expect_err("見つからないこと");
    assert_eq!(err.exit_code(), 1);

    // 空の ID は「見つからない」ではなく**引数の誤り**（exit 2。コードレビュー対応6）
    // ——`session rm "$CARD"` の変数が空のとき、唯一のカードを掴ませない
    let err = client::session_show(&target, "")
        .await
        .expect_err("空は断られること");
    assert_eq!(err.exit_code(), 2, "実際の言葉: {err}");
}

#[tokio::test]
async fn 履歴を引けて遡りも効く() {
    let dir = work_dir("transcript");
    let mut config = Config {
        state_dir: Some(dir.join("state")),
        ..Config::default()
    };
    // 遡り（--before）を見るため、1ページを小さくする
    config.transcript_page_limit = 2;
    let server = TestServer::start_with_parser(config).await;
    let target = target_of(&server);

    let session = server
        .manager
        .spawn(&dir.to_string_lossy())
        .expect("セッションを起動できること");
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

    // 会話1往復ぶん（transcript.rs の sample_lines と同じ形）
    let lines = [
        r#"{"type":"user","uuid":"u1","timestamp":"2026-07-29T00:00:00.000Z","version":"2.1.220","message":{"role":"user","content":"テストを流して"}}"#,
        r#"{"type":"assistant","uuid":"u2","parentUuid":"u1","timestamp":"2026-07-29T00:00:01.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"text","text":"流します"}]}}"#,
        r#"{"type":"assistant","uuid":"u3","parentUuid":"u2","timestamp":"2026-07-29T00:00:02.000Z","version":"2.1.220","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm test"}}]}}"#,
    ];
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&transcript)
            .expect("トランスクリプトへ書けること");
        for line in lines {
            writeln!(file, "{line}").expect("行を書けること");
        }
    }
    server
        .wait_for_transcript(session.card_id, "3件以上", |nodes| nodes.len() >= 3)
        .await;

    // 短いIDで引ける（前方一致の解決が transcript の道でも効くこと）
    let card = session.card_id.to_string();
    let (page, raw) = client::transcript(&target, &card[..8], None, None)
        .await
        .expect("履歴を引けること");
    assert_eq!(page.nodes.len(), 2, "1ページの上限（2件）で切れること");
    assert!(page.has_more, "まだ前があると分かること");
    assert!(raw.contains("nodes"), "生の本文はサーバの応答そのもの");

    // 遡る：いま見えている先頭より前を頼むと、残りが届く
    let before = page.nodes[0].id.0.clone();
    let (older, _) = client::transcript(&target, &card[..8], Some(&before), None)
        .await
        .expect("遡れること");
    assert_eq!(older.nodes.len(), 1, "残りの1件が届くこと");
    assert!(!older.has_more, "これより前は無いと分かること");
}

#[tokio::test]
async fn 枠とフォルダとファイルと設定と版がそれぞれ引ける() {
    let dir = work_dir("read-all");
    // `settings show` も見るので、設定の持ち主（SettingsStore）ごと立てる
    // （素の `start()` は設定の口を配線せず、`GET /api/settings` は 404 が正しい挙動）
    let fake_global = dir.join("claude-settings.json");
    std::fs::write(&fake_global, "{}").expect("偽のグローバル設定を書けること");
    let server = TestServer::start_with_settings(Config::default(), fake_global).await;
    let target = target_of(&server);

    // --- project ls ---
    let body = format!(r#"{{"host":"local","path":"{}"}}"#, dir.to_string_lossy());
    let (status, response) = server.request("POST", "/api/projects", Some(&body)).await;
    assert_eq!(status, 200, "枠を足せること: {response}");
    let (projects, _) = client::projects(&target).await.expect("枠を引けること");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].path, dir.to_string_lossy());

    // --- host dir（日本語のパスがクエリを通ることも一緒に見る） ---
    let nested = dir.join("計画");
    std::fs::create_dir_all(&nested).expect("フォルダを作れること");
    std::fs::write(dir.join("メモ.md"), "# メモ\n本文\n").expect("ファイルを書けること");
    let (listing, _) = client::host_dir(&target, "local", Some(&dir.to_string_lossy()))
        .await
        .expect("フォルダを覗けること");
    let names: Vec<&str> = listing
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert!(names.contains(&"計画"), "フォルダが載る: {names:?}");
    assert!(names.contains(&"メモ.md"), "ファイルが載る: {names:?}");

    // --- host file ---
    let path = dir.join("メモ.md");
    let (content, _) = client::host_file(&target, "local", &path.to_string_lossy())
        .await
        .expect("ファイルを読めること");
    assert_eq!(content.text, "# メモ\n本文\n");
    assert!(!content.truncated);

    // --- settings show（解釈しない約束なので、形だけを見る） ---
    let raw = client::settings_raw(&target)
        .await
        .expect("設定を引けること");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("JSON であること");
    assert!(
        value.get("available_modes").is_some(),
        "設定の応答に見えること: {raw}"
    );

    // --- version ls ---
    let (view, _) = client::versions(&target).await.expect("版を引けること");
    // `supported` は環境で変わる（このテストはコンテナの中で走ると `/.dockerenv` を
    // 見て偽になる）ので断言しない。**どの構成でも埋まる欄**（稼働中の版）だけを見る
    assert_eq!(
        view.running.0,
        env!("CARGO_PKG_VERSION"),
        "稼働中の版は自分の版"
    );
}

#[tokio::test]
async fn 相手が居ないときは繋げないという言葉と終了コードになる() {
    // 予約だけして誰も聞いていないポートへ話しかける
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("空きポートを取れること");
    let addr = listener.local_addr().expect("番号を読めること");
    drop(listener);
    let target = client::Target::from_url(&format!("http://{addr}")).expect("接続先を作れること");
    let err = client::sessions(&target).await.expect_err("繋げないこと");
    assert_eq!(err.exit_code(), 4, "「待って再試行」の族であること");
    let text = err.to_string();
    assert!(text.contains("相手が居ません"), "言葉が違う: {text}");
}

#[tokio::test]
async fn 前段がchunkedで返しても読める() {
    // 同梱の前段設定は Content-Length を保つが、**利用者が Caddy へ `encode gzip` を
    // 1行足すだけで chunked が現れる**（CLI設計§15-1 の実測）。手書きクライアントなら
    // ここで壊れる——hyper を借りた判断（§6-2）が実際に効いていることを、chunked を
    // 返すスタブで机の上に固定する（テスト計画F4「前段が chunked で返しても読めること」）
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("空きポートを取れること");
    let addr = listener.local_addr().expect("番号を読めること");
    let serve = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("接続が来ること");
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        // 要求ヘッダを読み切る（中身は見ない——ここはただの前段役）
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = socket.read(&mut chunk).await.expect("読めること");
            buffer.extend_from_slice(&chunk[..read]);
            if read == 0 || buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        // `[]` を2バイトの chunk 1つ＋終端で返す
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\n\
                  Content-Type: application/json\r\n\
                  Transfer-Encoding: chunked\r\n\
                  Connection: close\r\n\
                  \r\n\
                  2\r\n[]\r\n0\r\n\r\n",
            )
            .await
            .expect("書けること");
    });

    let target = client::Target::from_url(&format!("http://{addr}")).expect("接続先を作れること");
    let (sessions, raw) = client::sessions(&target).await.expect("読めること");
    assert!(sessions.is_empty(), "chunked の本文が解けること: {raw}");
    serve.await.expect("スタブが最後まで生きること");
}
