//! モデル切替の通し（テスト計画フェーズ3）。
//!
//! 擬似 claude を相手にするので**毎回走らせられる**。要件が名指しで心配している
//! 「1つ切り替えたら他も連動する」を、ここで固定する。
//!
//! # 本物の `~/.claude/settings.json` は触らない
//!
//! グローバル既定の扱いを見るテストなので、対象を間違えると**利用者の設定が壊れる**。
//! すべて `common::server_with_fake_global` を通し、一時ファイルを相手にする。

mod common;

use agentdashboard_core::config::Config;
use protocol::ModelId;

/// テスト用の設定。
///
/// `refreshInterval` を最小の1秒にする。**モデル変更は statusLine の契機に入っていない**
/// （設計§11 前提6）ので、切り替えた結果が確定するまでの時間はこの値で決まる。
/// 既定の3秒のままだとテスト1本ごとに数秒待つことになる。
fn refresh_config() -> Config {
    Config {
        status_line_refresh_secs: 1,
        ..Config::default()
    }
}

/// 擬似のグローバル設定。実物にありがちなキーを一緒に置き、巻き込まれないことを見る。
const GLOBAL: &str = r#"{
  "permissions": { "defaultMode": "auto" },
  "model": "claude-fable-5[1m]",
  "effortLevel": "xhigh"
}
"#;

#[tokio::test]
async fn 起動直後はモデルが不明で始まる() {
    // 権限モードと違い、起動引数から埋められる値が無い（設計§4）。
    // ここで推測して埋めると、CLI が名乗る前に画面が嘘をつく
    let (_path, server) =
        common::server_with_fake_global("unknown-at-start", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let session = manager
        .spawn(&common::work_dir())
        .expect("セッションを起動できること");

    assert_eq!(session.meta().model, None);
    assert_eq!(session.meta().model_label, None);
    assert_eq!(session.meta().model_requested, None);
}

#[tokio::test]
async fn 覚えている利用者の既定が注入されて初期値になる() {
    // 設計§6 の主の仕掛け。これが効いていれば、他のセッションで切り替えられても
    // 新しく起こしたセッションは利用者の既定で始まる（要件が心配している経路3）
    let (_path, server) =
        common::server_with_fake_global("inject-default", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, mut watcher) = common::start_session(manager).await;

    common::send_line(&session, "dump");
    watcher
        .wait_for(testkit::fake_claude::DUMP_END_MARKER)
        .await;
    assert!(
        watcher.seen().contains("--settings"),
        "実際の起動引数:\n{}",
        watcher.seen()
    );

    // 擬似 claude は注入設定の model を初期値として名乗る
    common::wait_for_model(&session, "claude-fable-5[1m]").await;
}

#[tokio::test]
async fn statusLineから届いた値がカードに載る() {
    let (_path, server) = common::server_with_fake_global("report", GLOBAL, refresh_config()).await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    common::wait_for_model(&session, "claude-fable-5[1m]").await;
    assert_eq!(
        session.meta().model_label.as_deref(),
        Some("claude-fable-5[1m]"),
        "表示名も一緒に載ること"
    );
}

#[tokio::test]
async fn 画面から切り替えると確定してカードが更新される() {
    let (_path, server) = common::server_with_fake_global("switch", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, _watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    manager
        .switch_model(&session, &ModelId::new("opus"))
        .await
        .expect("切り替えられること");

    // 送った値は別名、CLI が名乗るのはフルID。一致しないのが正しい
    common::wait_for_model(&session, "claude-opus-5").await;
    assert_eq!(session.meta().model_label.as_deref(), Some("Opus 5"));
    assert_eq!(
        session.meta().model_requested,
        None,
        "確定したら楽観更新は落ちること"
    );
}

#[tokio::test]
async fn 切り替えた別名の解決先を覚える() {
    // 設計§12。選択肢へ版番号を併記するための実測は、この瞬間にしか取れない
    let (_path, server) = common::server_with_fake_global("learn", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, _watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    assert_eq!(
        manager.aliases().resolve(&ModelId::new("sonnet")),
        None,
        "まだ選んでいない別名は覚えていない（推測で埋めない）"
    );

    manager
        .switch_model(&session, &ModelId::new("sonnet"))
        .await
        .expect("切り替えられること");
    common::wait_for_model(&session, "claude-sonnet-5").await;

    assert_eq!(
        manager.aliases().resolve(&ModelId::new("sonnet")),
        Some(ModelId::new("claude-sonnet-5"))
    );
    let seen = manager.aliases().all();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].display_name, "Sonnet 5", "版番号入りで覚えること");
}

#[tokio::test]
async fn 同じモデルを選んだときは送らない() {
    let (_path, server) = common::server_with_fake_global("noop", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, mut watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    manager
        .switch_model(&session, &ModelId::new("opus"))
        .await
        .expect("切り替えられること");
    common::wait_for_model(&session, "claude-opus-5").await;
    watcher
        .drain_quiet_for(std::time::Duration::from_millis(300))
        .await;
    let before = watcher
        .seen()
        .matches(testkit::fake_claude::MODEL_SET_PREFIX)
        .count();

    // 解決先が一致しているので、2回目は送らない（無駄に確認画面を出させない）
    manager
        .switch_model(&session, &ModelId::new("opus"))
        .await
        .expect("何も起きずに戻ること");
    watcher
        .drain_quiet_for(std::time::Duration::from_millis(300))
        .await;

    assert_eq!(
        watcher
            .seen()
            .matches(testkit::fake_claude::MODEL_SET_PREFIX)
            .count(),
        before,
        "2回目は送られていないこと"
    );
}

#[tokio::test]
async fn 片方を切り替えても他のカードのモデルは変わらない() {
    // **要件が名指しで心配している点**（経路1）。値をカードの外に置いた瞬間に壊れる
    let (_path, server) =
        common::server_with_fake_global("independent", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (first, _w1) = common::start_session(manager).await;
    let (second, _w2) = common::start_session(manager).await;
    common::wait_for_model(&first, "claude-fable-5[1m]").await;
    common::wait_for_model(&second, "claude-fable-5[1m]").await;

    manager
        .switch_model(&first, &ModelId::new("haiku"))
        .await
        .expect("切り替えられること");
    common::wait_for_model(&first, "claude-haiku-4-5-20251001").await;

    assert_eq!(
        second.meta().model,
        Some(ModelId::new("claude-fable-5[1m]")),
        "もう片方は動かないこと"
    );
    assert_eq!(second.meta().model_requested, None);
}

#[tokio::test]
async fn 切り替えたあとに起こしたセッションは元の既定で始まる() {
    // **要件が心配している連動のもう1つの顔**（経路3）。走行中のセッションを
    // 見ているだけでは絶対に気づけないので、手順として明示的に踏む
    let (path, server) =
        common::server_with_fake_global("new-session", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (first, _w1) = common::start_session(manager).await;
    common::wait_for_model(&first, "claude-fable-5[1m]").await;

    manager
        .switch_model(&first, &ModelId::new("haiku"))
        .await
        .expect("切り替えられること");
    common::wait_for_model(&first, "claude-haiku-4-5-20251001").await;

    // 注入する値の出どころ。ここが汚れていると、次に起こすセッションが巻き込まれる
    assert_eq!(
        common::global_model(&path).as_deref(),
        Some("claude-fable-5[1m]"),
        "グローバル既定が元のままであること"
    );

    let (second, _w2) = common::start_session(manager).await;
    common::wait_for_model(&second, "claude-fable-5[1m]").await;
    assert_eq!(
        first.meta().model,
        Some(ModelId::new("claude-haiku-4-5-20251001")),
        "先に切り替えたほうは変わらないこと"
    );
}

#[tokio::test]
async fn 切替のあともグローバル設定に余計な書き込みをしない() {
    // 擬似 claude は本物と違ってグローバル設定を汚さない（汚す先は利用者の HOME に
    // あり、テストから安全に差し替えられないため）。
    // **ここで見るのは「ダッシュボード自身が余計に書かないこと」**で、
    // 汚れたときの回復そのものは claude_settings の単体テストと
    // テスト計画フェーズ4（実CLI）が受け持つ
    let (path, server) = common::server_with_fake_global("restore", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, _watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    manager
        .switch_model(&session, &ModelId::new("opus"))
        .await
        .expect("切り替えられること");
    common::wait_for_model(&session, "claude-opus-5").await;

    let after = std::fs::read_to_string(&path).expect("読めること");
    assert_eq!(after, GLOBAL, "触っていないバイトが1つも動いていないこと");
    assert!(
        !server.manager.claude_settings().is_broken(),
        "回復の失敗状態にも入っていないこと"
    );
}

#[tokio::test]
async fn 会話が進んでいると確認に答えてから切り替わる() {
    // 設計§11 前提2 で実測した「Switch model?」の番号選択。
    // **画面を読んでから送る**という原則が働いていることを見る
    let (_path, server) =
        common::server_with_fake_global("confirm", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, mut watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    // 1往復させて「会話が進んだ」状態を作る
    common::send_line(&session, "こんにちは");
    watcher
        .wait_for(&format!(
            "{}こんにちは",
            testkit::fake_claude::RECEIVED_PREFIX
        ))
        .await;

    manager
        .switch_model(&session, &ModelId::new("haiku"))
        .await
        .expect("確認に答えて切り替えられること");
    common::wait_for_model(&session, "claude-haiku-4-5-20251001").await;

    // `seen()` をそのまま見ると、まだ受け取っていないフレームを取りこぼす。
    // 確認画面が出たことは**待って**確かめる
    watcher.wait_for("Switch model?").await;
}

#[tokio::test]
async fn 表に無いモデルを指定しても運べる() {
    // 列挙型にしなかった理由そのもの。利用者が端末でフルIDを打つ場面も同じ経路
    let (_path, server) =
        common::server_with_fake_global("unknown-model", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, _watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    manager
        .switch_model(&session, &ModelId::new("claude-opus-4-6"))
        .await
        .expect("知らない値でも送れること");
    common::wait_for_model(&session, "claude-opus-4-6").await;
}

#[tokio::test]
async fn statusLineを切るとモデルは不明のままになる() {
    // config.toml の逃げ道（設計§4）。切ったときに hooks の注入まで壊れていないことも見る
    let config = Config {
        inject_status_line: false,
        status_line_refresh_secs: 1,
        ..Config::default()
    };
    let (_path, server) = common::server_with_fake_global("no-statusline", GLOBAL, config).await;
    let (session, mut watcher) = common::start_session(&server.manager).await;

    // フックは今までどおり動く
    common::fire_hook(&session, &mut watcher, "SessionStart", "").await;
    assert!(
        session.meta().hooks_seen,
        "フックの注入は影響を受けないこと"
    );

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(session.meta().model, None, "モデルは不明のまま");
}
