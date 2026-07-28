//! フック受信モックサーバの動作確認（テスト計画フェーズ1「テストヘルパ実装」）。

use testkit::MockHookServer;

#[tokio::test]
async fn 受信したフックのトークンとイベント名とpayloadを記録する() {
    let server = MockHookServer::start()
        .await
        .expect("モックサーバが起動すること");
    let addr = server.addr();

    let body = r#"{"session_id":"11111111-2222-3333-4444-555555555555","transcript_path":"/tmp/session.jsonl","tool_name":"Edit"}"#;
    let status = tokio::task::spawn_blocking(move || {
        testkit::post_json(addr, "/hook/token-abc/PreToolUse", body)
    })
    .await
    .expect("ブロッキングタスクが完了すること")
    .expect("POST が成功すること");

    assert_eq!(status, 200);

    let received = server.received();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].token, "token-abc");
    assert_eq!(received[0].event, "PreToolUse");
    assert_eq!(received[0].payload["tool_name"], "Edit");
    assert_eq!(
        received[0].payload["session_id"],
        "11111111-2222-3333-4444-555555555555"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn 複数イベントが到着順に記録される() {
    let server = MockHookServer::start()
        .await
        .expect("モックサーバが起動すること");
    let addr = server.addr();

    for event in ["SessionStart", "UserPromptSubmit", "Stop"] {
        let path = format!("/hook/tok/{event}");
        tokio::task::spawn_blocking(move || testkit::post_json(addr, &path, r#"{"ok":true}"#))
            .await
            .expect("ブロッキングタスクが完了すること")
            .expect("POST が成功すること");
    }

    let events: Vec<String> = server
        .received()
        .into_iter()
        .map(|hook| hook.event)
        .collect();
    assert_eq!(events, ["SessionStart", "UserPromptSubmit", "Stop"]);
    assert_eq!(server.received_count(), 3);

    server.shutdown().await;
}

#[tokio::test]
async fn 壊れたjsonでも拒否せず生ボディを保持する() {
    // フォーマット変更の観測が目的のテストダブルなので、受信自体を失敗させてはいけない
    let server = MockHookServer::start()
        .await
        .expect("モックサーバが起動すること");
    let addr = server.addr();

    let status = tokio::task::spawn_blocking(move || {
        testkit::post_json(addr, "/hook/tok/Notification", "{壊れたJSON")
    })
    .await
    .expect("ブロッキングタスクが完了すること")
    .expect("POST が成功すること");

    assert_eq!(status, 200);
    let received = server.received();
    assert_eq!(received.len(), 1);
    assert!(received[0].payload.is_null(), "パース不能なら Null になる");
    assert_eq!(received[0].raw_body, "{壊れたJSON");

    server.shutdown().await;
}

#[tokio::test]
async fn hook_urlはセッション毎のトークンを含む形になる() {
    let server = MockHookServer::start()
        .await
        .expect("モックサーバが起動すること");
    let url = server.hook_url("tok-1", "PreToolUse");
    assert_eq!(
        url,
        format!("http://{}/hook/tok-1/PreToolUse", server.addr())
    );
    assert!(
        url.starts_with("http://127.0.0.1:"),
        "ループバックのみ: {url}"
    );
    server.shutdown().await;
}
