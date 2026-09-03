//! 過去のセッションを指定して起こす（名前付け設計§7-4・§7-5）。
//!
//! **復旧（`session_revive.rs`）とは意味が違う。** あちらは**既にあるカード**を元の
//! セッションで起こし直すので CardId をサーバから渡すが、こちらは**新しいカード**を
//! 作る——採番はセッションホスト側で、`Spawn` と同じ扱いになる。
//!
//! 擬似 claude を相手にするので**課金しない**。

#![allow(non_snake_case)]

mod common;

use protocol::{ClaudeSessionId, PermissionMode};

#[tokio::test]
async fn 過去のセッションを起こすと新しいカードができる() {
    let manager = common::manager();
    let cwd = common::work_dir();
    let session = ClaudeSessionId::new();

    let 一 = manager.recall(&cwd, None, session).expect("1本目");
    let 二 = manager.recall(&cwd, None, session).expect("2本目");

    // **既存のカードを起こし直さない。** 二度押しはカードが2枚できるだけで、
    // 利用者から見て説明の付く結果になる（設計§7-1 の注記）
    assert_ne!(一.card_id, 二.card_id, "同じ呼び戻し先でもカードは別");
    assert_eq!(manager.list().len(), 2, "2枚とも残ること");
}

#[tokio::test]
async fn 起こしたカードは最初から呼び戻し先を持っている() {
    // **これが「起こしたあとも名前が付いている」を満たす**（設計§7-5）。名前は
    // `claude_session_id` で引くので、先に入っていれば最初の報告から名前が出る。
    //
    // 素の `resume` はここが空になる（CLI 側が別のIDを名乗りうるため、最初のフックが
    // 確定させる）。**こちらは「どのセッションを指定したか」を知っている**ので違う。
    let manager = common::manager();
    let cwd = common::work_dir();
    let session = ClaudeSessionId::new();

    let recalled = manager.recall(&cwd, None, session).expect("起こせること");
    assert_eq!(
        recalled.meta().claude_session_id,
        Some(session),
        "呼び戻し先が最初から入っていない"
    );

    // 比較のため、素の `resume` は空のまま
    let resumed = manager.resume(&cwd, session).expect("起こせること");
    assert_eq!(
        resumed.meta().claude_session_id,
        None,
        "素の引き継ぎまで振る舞いを変えてしまっている"
    );
}

#[tokio::test]
async fn 権限モードを渡せる() {
    // `--permission-mode` と `--resume` は**組で渡せて実際に効く**（復旧設計§15-2 の実測）。
    // 素の `resume` は渡す口を持たないので、ここが `recall` を足した理由の半分にあたる
    let manager = common::manager();
    let cwd = common::work_dir();
    let session = ClaudeSessionId::new();
    let mode = PermissionMode::new("acceptEdits");

    let recalled = manager
        .recall(&cwd, Some(mode.clone()), session)
        .expect("起こせること");

    assert_eq!(
        recalled.meta().permission_mode,
        Some(mode),
        "頼んだ権限モードがカードに載っていない"
    );
}

#[tokio::test]
async fn 権限モードと呼び戻し先は組で子プロセスまで届く() {
    // **カードの記録を見るだけでは足りない。** 記録の初期値と、CLI へ渡す起動引数は
    // 別々に積むので、片方だけ積んで「渡せている」と読める形になりうる——実際に
    // そうなっていた（引数に積み忘れていて、記録上は頼んだモード・実際は利用者の
    // 既定、という食い違いが起きる）。
    //
    // なので**起動された子プロセス自身に聞く**（`session_env.rs` と同じ流儀）。
    let manager = common::manager();
    let session = ClaudeSessionId::new();
    let mode = PermissionMode::new("acceptEdits");

    let recalled = manager
        .recall(&common::work_dir(), Some(mode), session)
        .expect("起こせること");
    let mut watcher = common::Watcher::attach(&recalled);
    watcher.wait_for(testkit::fake_claude::READY_MARKER).await;

    common::send_line(&recalled, "dump");
    watcher
        .wait_for(testkit::fake_claude::DUMP_END_MARKER)
        .await;

    let argv: Vec<String> = watcher
        .seen()
        .lines()
        .filter_map(|line| {
            line.trim_end_matches('\r')
                .strip_prefix(testkit::fake_claude::ARGV_PREFIX)
        })
        .map(str::to_string)
        .collect();

    let resume = argv
        .iter()
        .position(|arg| arg == "--resume")
        .unwrap_or_else(|| panic!("--resume が渡っていない: {argv:?}"));
    assert_eq!(
        argv.get(resume + 1).map(String::as_str),
        Some(session.to_string().as_str()),
        "頼んだセッションが渡っていない: {argv:?}"
    );

    let permission = argv
        .iter()
        .position(|arg| arg == "--permission-mode")
        .unwrap_or_else(|| panic!("--permission-mode が渡っていない: {argv:?}"));
    assert_eq!(
        argv.get(permission + 1).map(String::as_str),
        Some("acceptEdits"),
        "頼んだ権限モードが渡っていない: {argv:?}"
    );

    // **自己採番していないこと。** `--session-id` が混ざると、指定した過去の
    // セッションではなく新しいセッションが始まる
    assert!(
        !argv.iter().any(|arg| arg == "--session-id"),
        "引き継ぎなのに自己採番している: {argv:?}"
    );

    recalled.kill();
}

#[tokio::test]
async fn 起こした先は本当に動く() {
    // 型の上で通っていても、**擬似 claude が起動していなければ意味が無い**。
    // 起動の合図（`READY_MARKER`）まで見る
    let manager = common::manager();
    let session = ClaudeSessionId::new();

    let recalled = manager
        .recall(&common::work_dir(), None, session)
        .expect("起こせること");
    let mut watcher = common::Watcher::attach(&recalled);
    watcher.wait_for(testkit::fake_claude::READY_MARKER).await;
}
