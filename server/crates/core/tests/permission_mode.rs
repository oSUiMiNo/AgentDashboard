//! 権限モードの通し確認（テスト計画フェーズ3）。
//!
//! 相手は擬似 claude なので**課金なしで毎回走らせられる**。擬似 claude は本物と同じ形の
//! フッタを出し、Shift+Tab で同じ順序に巡回し、フックの payload に `permission_mode` を
//! 載せる（設計§11 の実測に合わせてある）。おかげで「起動 → 表示 → 切替 → 反映」の
//! 一本道を、本物の CLI を起こさずに固定できる。
//!
//! 単体テストで押さえているのは変換だけ（`session::permission` / `session::lifecycle`）。
//! ここで見るのは**継ぎ目**にあたる。

mod common;

use agentdashboard_core::config::Config;
use protocol::{PermissionMode, ws::ServerMessage};
use std::path::PathBuf;
use std::time::Duration;

/// 起動時に指定したモードで claude が起動し、カードにも載ること。
#[tokio::test]
async fn 起動モードが起動引数とカードの両方に載る() {
    let manager = common::manager();
    let session = manager
        .spawn_with_mode(
            &common::work_dir(),
            Some(PermissionMode::new("acceptEdits")),
        )
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    watcher.wait_for(testkit::fake_claude::READY_MARKER).await;

    assert_eq!(
        session.meta().permission_mode,
        Some(PermissionMode::new("acceptEdits")),
        "起動時の指定が初期値として載ること"
    );

    // 子プロセス自身に起動引数を報告させる。親が組み立てた値を見るだけだと、
    // 途中で落ちる経路を見落とす
    common::send_line(&session, "dump");
    watcher
        .wait_for(testkit::fake_claude::DUMP_END_MARKER)
        .await;
    assert!(
        watcher.seen().contains("--permission-mode"),
        "実際の起動引数:\n{}",
        watcher.seen()
    );
    assert!(watcher.seen().contains("acceptEdits"));
}

/// 指定なしのときは CLI に何も渡さない（利用者の `permissions.defaultMode` を尊重する）。
#[tokio::test]
async fn 指定なしでは起動引数を付けずカードも不明のまま始まる() {
    let manager = common::manager();
    let session = manager
        .spawn_with_mode(&common::work_dir(), None)
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    watcher.wait_for(testkit::fake_claude::READY_MARKER).await;

    assert_eq!(
        session.meta().permission_mode,
        None,
        "指定していないなら「分からない」から始まる"
    );

    common::send_line(&session, "dump");
    watcher
        .wait_for(testkit::fake_claude::DUMP_END_MARKER)
        .await;
    assert!(
        !watcher.seen().contains("--permission-mode"),
        "manual を勝手に補ってはいけない:\n{}",
        watcher.seen()
    );
}

/// 端末のフッタを読んで、起動直後の「分からない」を埋めること。
///
/// `SessionStart` フックは `permission_mode` を運ばない（設計§11）ので、
/// **フッタを読まない限り1ターン目まで分からない**。
#[tokio::test]
async fn フッタを読んでモードが埋まる() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;
    assert_eq!(session.meta().permission_mode, None);

    manager.sweep_once();

    assert_eq!(
        session.meta().permission_mode,
        Some(PermissionMode::new("default")),
        "擬似 claude が出したフッタから読めること"
    );
}

/// フックが運んできた値で上書きされること（起動後は CLI が正）。
#[tokio::test]
async fn フックの値でカードが更新される() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(
        &session,
        &mut watcher,
        "PreToolUse",
        r#"{"permission_mode":"plan"}"#,
    )
    .await;

    assert_eq!(
        session.meta().permission_mode,
        Some(PermissionMode::new("plan"))
    );
}

/// 値が変わらないフックでカード全体を送り直さないこと。
///
/// フックはツールコールのたびに飛んでくるので、毎回配信すると無駄が大きい。
#[tokio::test]
async fn 同じモードのフックでは配信しない() {
    let server = common::TestServer::start().await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    // 1回目でモードが確定する
    common::fire_hook(
        &session,
        &mut watcher,
        "PreToolUse",
        r#"{"permission_mode":"acceptEdits"}"#,
    )
    .await;

    let mut events = common::EventWatcher::attach(&server.manager);
    common::fire_hook(
        &session,
        &mut watcher,
        "PostToolUse",
        r#"{"permission_mode":"acceptEdits"}"#,
    )
    .await;

    // 2回目は状態の差分（status）だけが流れ、カード全体は流れない
    let message = events
        .wait_for("状態の差分", |message| {
            matches!(message, ServerMessage::Status { .. })
                || matches!(message, ServerMessage::SessionUpsert { .. })
        })
        .await;
    assert!(
        matches!(message, ServerMessage::Status { .. }),
        "モードが変わっていないのにカード全体を送り直している: {message:?}"
    );
}

/// **要件が名指しで心配している点**：1つのモードを変えても、他のカードは変わらない。
#[tokio::test]
async fn 片方のモードを変えても他のカードは変わらない() {
    let server = common::TestServer::start().await;
    let (first, mut first_watcher) = common::start_session(&server.manager).await;
    let (second, _second_watcher) = common::start_session(&server.manager).await;

    // 2本目は起動直後のまま（フッタも読ませない）
    let before = second.meta();

    common::fire_hook(
        &first,
        &mut first_watcher,
        "Stop",
        r#"{"permission_mode":"bypassPermissions"}"#,
    )
    .await;

    assert_eq!(
        first.meta().permission_mode,
        Some(PermissionMode::new("bypassPermissions"))
    );
    assert_eq!(
        second.meta().permission_mode,
        before.permission_mode,
        "隣のセッションのモードが連動してはいけない"
    );
    assert_ne!(first.card_id, second.card_id);
}

/// 画面からの切替が実際に着くこと（Shift+Tab を送って読むまで）。
#[tokio::test]
async fn 巡回に入っているモードへは切り替えられる() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;
    manager.sweep_once();

    let reached = session
        .switch_permission_mode(&PermissionMode::new("plan"))
        .await
        .expect("巡回に入っているので着けること");

    assert_eq!(reached, PermissionMode::new("plan"));
    assert_eq!(
        session.meta().permission_mode,
        Some(PermissionMode::new("plan")),
        "着いた結果がカードにも載ること"
    );
}

/// 巡回に入らないモードは、一巡したことを検知して**黙らずに**失敗すること。
#[tokio::test]
async fn 巡回に入らないモードは理由つきで失敗する() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;
    manager.sweep_once();

    // dontAsk は起動時にしか選べない（設計§11）
    let error = session
        .switch_permission_mode(&PermissionMode::new("dontAsk"))
        .await
        .expect_err("到達できないこと");

    let message = error.to_string();
    assert!(
        message.contains("dontAsk") && message.contains("切り替えられません"),
        "理由が分かる文になっていない: {message}"
    );
    // 押した結果いまどこに居るかは分かるようにしておく
    assert!(session.meta().permission_mode.is_some());
}

/// 既にそのモードなら、キーを1つも送らずに終わること。
#[tokio::test]
async fn 同じモードへの切替では何も送らない() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;
    manager.sweep_once();

    let reached = session
        .switch_permission_mode(&PermissionMode::new("default"))
        .await
        .expect("いまのモードなので着いている扱い");
    assert_eq!(reached, PermissionMode::new("default"));
}

/// 全承認をスキップで起動したときの確認に、こちらで答えること（利用者の判断）。
///
/// 既定の選択肢は「いいえ（終了する）」なので、**選択肢を読んで番号を送る**。
/// 決め打ちで確定を送っていると、ここでセッションが終わって落ちる。
#[tokio::test]
async fn 全承認スキップの確認に自動で答える() {
    let manager = common::manager();
    let session = manager
        .spawn_with_mode(
            &common::work_dir(),
            Some(PermissionMode::new("bypassPermissions")),
        )
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);

    watcher
        .wait_for(testkit::fake_claude::BYPASS_ACCEPTED_MARKER)
        .await;
    watcher.wait_for("bypass permissions on").await;

    manager.sweep_once();
    assert_eq!(
        session.meta().permission_mode,
        Some(PermissionMode::new("bypassPermissions"))
    );
}

/// 設定は読めて、書き換えるとファイルへ残り、その場で反映されること（設計§7）。
#[tokio::test]
async fn 設定は読み書きできてファイルに残る() {
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-settings-api-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("置き場所を作れること");
    let path: PathBuf = dir.join("config.toml");
    std::fs::write(&path, "# 利用者が書いたコメント\nport = 8787\n").expect("書き出せること");

    let server = common::TestServer::start_with_settings(Config::default(), path.clone()).await;

    let (status, body) = server.get("/api/settings").await;
    assert_eq!(status, 200);
    assert!(
        body.contains("\"always_bypass_permissions\":false"),
        "既定はスキップしない側であること: {body}"
    );
    // `--help` から読んだモードの一覧が届くこと（擬似 claude も choices を出す）
    assert!(body.contains("bypassPermissions"), "{body}");

    let (status, body) = server
        .put("/api/settings", r#"{"always_bypass_permissions":true}"#)
        .await;
    assert_eq!(status, 200);
    assert!(
        body.contains("\"always_bypass_permissions\":true"),
        "{body}"
    );

    // その場で反映されること（次の起動を待たせない）
    let (_, body) = server.get("/api/settings").await;
    assert!(
        body.contains("\"always_bypass_permissions\":true"),
        "{body}"
    );

    // ファイルにも残り、利用者が書いたコメントが消えないこと
    let written = std::fs::read_to_string(&path).expect("読み直せること");
    assert!(written.contains("# 利用者が書いたコメント"), "{written}");
    assert!(
        written.contains("always_bypass_permissions = true"),
        "{written}"
    );
    assert!(written.contains("port = 8787"), "{written}");

    let _ = std::fs::remove_dir_all(dir);
}

/// 見張りの相乗りが、停滞の判定を邪魔しないこと。
///
/// フッタの読み取りを1秒周期の見張りへ足したので、**元からあった判定が
/// そのまま動く**ことを確かめておく。
#[tokio::test]
async fn フッタの読み取りを足しても停滞の判定は動く() {
    let config = Config {
        stalled_threshold_secs: 1,
        ..Config::default()
    };
    // フックを本当に届かせたいので、受信口まで立てる
    let server = common::TestServer::start_with(config).await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    common::fire_hook(&session, &mut watcher, "UserPromptSubmit", "").await;
    common::wait_for_status(&session, protocol::SessionStatus::Working).await;

    tokio::time::sleep(Duration::from_millis(1_100)).await;
    server.manager.sweep_once();

    assert_eq!(session.status(), protocol::SessionStatus::Stalled);
    // モードも同じ周回で読めていること
    assert_eq!(
        session.meta().permission_mode,
        Some(PermissionMode::new("default"))
    );
}

/// Composer の経路（`send_instruction`）が擬似 claude に**1つの行として**届くこと。
///
/// 権限モードの実装で擬似 claude の入力の読み方を行単位からバイト単位へ変えた
/// （Shift+Tab は改行を伴わないため）。それまでは端末の行編集が
/// `Ctrl+U` と括弧付き貼り付けを処理してくれていたので、**擬似 claude 側は
/// 何もしなくてよかった**。読み方を変えた以上、そこを自分で扱えていることを
/// 固定しておかないと、E2E でしか気づけない。
#[tokio::test]
async fn 指示は貼り付けの記号を落として1行として届く() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    session
        .send_instruction("こんにちは")
        .await
        .expect("指示を送れること");

    watcher.wait_for("received: こんにちは").await;

    // 端末のエコー（`^U^[[200~…`）には合図が出る。それは行編集の働きで本文ではない。
    // 見るのは**擬似 claude が受け取った行**のほう
    let received: Vec<&str> = watcher
        .seen()
        .lines()
        .filter(|line| line.contains("received: "))
        .collect();
    assert_eq!(
        received,
        ["[fake-claude] received: こんにちは"],
        "貼り付けの合図が本文へ紛れ込んでいる:\n{}",
        watcher.seen()
    );
}

/// 複数行の指示は、貼り付けの中の改行がそのまま行の区切りになること。
#[tokio::test]
async fn 複数行の指示は行ごとに届く() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    session
        .send_instruction("1行目\n2行目")
        .await
        .expect("指示を送れること");

    watcher.wait_for("received: 1行目").await;
    watcher.wait_for("received: 2行目").await;
}

/// 自己修復の修復セッションが通る道を変えていないこと（設計§17 の約束）。
///
/// `spawn_with_args` は修復セッションが使う口で、`bypassPermissions` と
/// `--setting-sources project,local` を**組で**渡している。権限モードの機能を足した
/// ついでにここへ手が入ると、無人で走る機能の爆発半径が変わる。
///
/// あわせて、**確認の画面には修復セッションでも答えられる**ことを見る。無人で走る以上、
/// ここで止まると誰も気づかないまま待ち続けることになる。
#[tokio::test]
async fn 修復セッションの起動引数は変わっていない() {
    let manager = common::manager();
    let args: Vec<String> = [
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "project,local",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();

    let session = manager
        .spawn_with_args(&common::work_dir(), &args)
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);

    // 確認の画面に答えられている（答えないと起動が完了しない）
    watcher
        .wait_for(testkit::fake_claude::BYPASS_ACCEPTED_MARKER)
        .await;
    watcher.wait_for(testkit::fake_claude::READY_MARKER).await;

    common::send_line(&session, "dump");
    watcher
        .wait_for(testkit::fake_claude::DUMP_END_MARKER)
        .await;

    let argv: Vec<&str> = watcher
        .seen()
        .lines()
        .filter_map(|line| line.strip_prefix(testkit::fake_claude::ARGV_PREFIX))
        .collect();
    assert_eq!(
        argv.iter()
            .filter(|arg| **arg == "--permission-mode")
            .count(),
        1,
        "モードの指定が増えている（渡した引数に足してはいけない）: {argv:?}"
    );
    assert!(argv.contains(&"bypassPermissions"), "{argv:?}");
    assert!(argv.contains(&"--setting-sources"), "{argv:?}");
    assert!(argv.contains(&"project,local"), "{argv:?}");
}
