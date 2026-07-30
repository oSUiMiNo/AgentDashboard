//! モデル切替の通し（テスト計画フェーズ3）。
//!
//! 擬似 claude を相手にするので**毎回走らせられる**。要件が名指しで心配している
//! 「1つ切り替えたら他も連動する」を、ここで固定する。
//!
//! # 本物の `~/.claude/settings.json` は触らない
//!
//! グローバル既定の扱いを見るテストなので、対象を間違えると**利用者の設定が壊れる**。
//! すべて `common::server_with_fake_global` を通し、一時ファイルを相手にする。

// テスト名は日本語で書く。`statusLine` のように英大文字が混ざると snake_case 判定に
// 引っかかるだけで実害はないため、このファイルに限って許可する
// （`selfheal.rs` / `transcript.rs` と同じ扱い）
#![allow(non_snake_case)]

mod common;

use agentdashboard_core::{claude_settings::ClaudeSettings, config::Config};
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

#[test]
fn 設定を明示しないテストでも本物のグローバル設定を指さない() {
    // **書き込みは塞いだが、読み込みが塞がれていなかった**（コードレビュー C-2）。
    // 既定の入口は `ClaudeSettings::discover()`＝利用者の本物のファイルへ落ちるので、
    // 設定を明示しないテストは開発者の `model` を擬似 claude へ注入していた。
    // 設定ファイルを持たない CI とは違う経路を通ることになる
    let manager = common::manager();
    let path = manager.claude_settings().path().to_path_buf();

    assert!(
        path.starts_with(std::env::temp_dir()),
        "使い捨ての置き場所を指すこと。実際: {}",
        path.display()
    );
    // 名指しで避けたい相手はこれ。`$HOME` そのものを見て判定すると、HOME が `/` の
    // コンテナでは一時領域まで巻き込んでしまう
    assert_ne!(
        path,
        ClaudeSettings::discover().path(),
        "利用者の本物の設定を指してはいけない"
    );
    // 指すだけで作らない。読めなければ何もしないのが claude_settings の約束で、
    // 「グローバル既定は指定なし」の状態がそのまま再現される
    assert!(!path.exists(), "利用者の設定ファイルを生やしてはいけない");
}

#[test]
fn 明示された設定のパスはそのまま使われる() {
    // 使い捨てへ逃がす仕掛けが、テストが自分で用意したファイルを横取りしないこと
    let expected = std::env::temp_dir().join("agentdashboard-explicit-global.json");
    let manager = common::manager_with(Config {
        claude_settings_path: Some(expected.clone()),
        ..Config::default()
    });
    assert_eq!(manager.claude_settings().path(), expected);
}

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
async fn 前の切替で出た確認の残骸には答えない() {
    // **端末へ余計なものを送らないための1本。** 確認ダイアログはスクロールバックへ
    // 残り続けるので、末尾から探すと2回目以降の切替で残骸に一致する。確認は出て
    // いないので入力欄は空のままで、そこへ送った `1` は**本物への指示として確定される**。
    let (_path, server) =
        common::server_with_fake_global("stale-confirm", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, mut watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    // 1回切り替えて、確認ダイアログをスクロールバックへ残す
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
    watcher.wait_for("Switch model?").await;

    // ここから「送ったが確認は出なかった」場面を作る。擬似 claude は会話が進んで
    // いる限り毎回ダイアログを出すので通しの経路では作れず、`switch_model` が
    // 送信後に行うことだけを取り出して呼ぶ
    let mark = session.scrollback_mark();
    session.settle_model_switch(mark).await;

    // 番号待ちでないときに `1` が届けば、擬似 claude は普通の入力として echo する。
    // 直す前のコードなら、ここに必ず現れる
    watcher
        .drain_quiet_for(std::time::Duration::from_millis(300))
        .await;
    assert!(
        !watcher
            .seen()
            .contains(&format!("{}1", testkit::fake_claude::RECEIVED_PREFIX)),
        "残骸に反応して端末へ 1 を送ってはいけない。実際の画面:\n{}",
        watcher.seen()
    );
}

#[tokio::test]
async fn 改行を含む切替先は端末へ届く前に弾かれる() {
    // `/model <値>` は入力欄へ貼られて CR で確定される。改行が残ると**続きが
    // 本物への指示として送信される**ので、送る前に弾く
    let (_path, server) =
        common::server_with_fake_global("invalid-target", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, mut watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    let error = manager
        .switch_model(&session, &ModelId::new("sonnet\n悪意ある指示"))
        .await
        .expect_err("受け取ってはいけない値");
    assert!(
        error.to_string().contains("受け取れませんでした"),
        "理由が画面に出せる形であること。実際: {error}"
    );

    watcher
        .drain_quiet_for(std::time::Duration::from_millis(300))
        .await;
    assert!(
        !watcher.seen().contains("悪意ある指示"),
        "端末へ1バイトも届いていないこと。実際の画面:\n{}",
        watcher.seen()
    );
    assert_eq!(
        session.meta().model_requested,
        None,
        "送っていないので楽観更新も立たないこと"
    );
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

#[tokio::test]
async fn 確定が来なければ楽観更新は取り消される() {
    // **画面が嘘をつき続けないための歯止め**（設計§5）。CLI が切替を拒否すると
    // 確定は永久に届かないので、要求値を出したままにすると「切り替わった」と
    // 見せ続けることになる。
    //
    // statusLine を切って「確定が絶対に来ない」状況を作る。
    // 15秒待つので、このファイルでいちばん遅いテストになる
    let config = Config {
        inject_status_line: false,
        ..Config::default()
    };
    let (_path, server) = common::server_with_fake_global("give-up", GLOBAL, config).await;
    let (session, _watcher) = common::start_session(&server.manager).await;

    // 確定が来ないので、モデルは不明のまま
    assert_eq!(session.meta().model, None);

    server
        .manager
        .switch_model(&session, &ModelId::new("opus"))
        .await
        .expect("送ること自体は成功する");

    // 取り消されて、切替前の表示（ここでは「不明」）へ戻っていること
    assert_eq!(
        session.meta().model_requested,
        None,
        "楽観更新が残り続けると、切り替わったと嘘をつき続けることになる"
    );
    assert_eq!(session.meta().model, None);
}

#[tokio::test]
async fn 画面が読めないときは送らずに理由を返す() {
    // 送る前に端末を確かめる、という原則（設計§5）。このPJTは画面を見ずにキーを送って
    // 別の相手に吸われる事故を2回実測している。
    //
    // 起動直後、擬似 claude がフッタを書く前を狙う。**ready を待たない**のが要点
    let (_path, server) =
        common::server_with_fake_global("unreadable", GLOBAL, refresh_config()).await;
    let session = server
        .manager
        .spawn(&common::work_dir())
        .expect("セッションを起動できること");

    let error = server
        .manager
        .switch_model(&session, &ModelId::new("opus"))
        .await
        .expect_err("画面が読めないので送らないこと");

    // 黙って諦めない。理由がそのまま画面に出せる文であること
    let message = error.to_string();
    assert!(
        message.contains("ターミナル"),
        "利用者が次に何を見ればよいか分かる文であること。実際: {message}"
    );
    assert_eq!(
        session.meta().model_requested,
        None,
        "送っていないので楽観更新も立たないこと"
    );
}

#[tokio::test]
async fn 起動引数でモデルを指定したときは注入しない() {
    // 両方で指定すると、本物の CLI は起動しきらずに入力を受け付ける状態へ入らない
    // （自己修復の見直しセッションが実機で 180 秒待って落ちた）
    let (_path, server) =
        common::server_with_fake_global("explicit-model", GLOBAL, refresh_config()).await;
    let session = server
        .manager
        .spawn_with_args(
            &common::work_dir(),
            &["--model".to_string(), "sonnet".to_string()],
        )
        .expect("セッションを起動できること");
    let mut watcher = common::Watcher::attach(&session);
    watcher.wait_for(testkit::fake_claude::READY_MARKER).await;

    let settings = std::fs::read_to_string(
        std::env::temp_dir()
            .join("agentdashboard")
            .join(session.card_id.to_string())
            .join("settings.json"),
    )
    .expect("注入した設定を読めること");
    let value: serde_json::Value = serde_json::from_str(&settings).unwrap();
    assert!(
        value.get("model").is_none(),
        "起動引数で指定しているので注入してはいけない: {settings}"
    );
    // statusLine のほうは注入されたままであること（モデルの取得は生きている）
    assert!(value.get("statusLine").is_some());
    assert_eq!(
        session.model_alias(),
        Some(ModelId::new("sonnet")),
        "起動引数で指定した値が、起動時に効いている別名になること"
    );
}

#[tokio::test]
async fn 解決先が同じでも別名が違えば送る() {
    // **B-2。** `opus` と `opus[1m]` はどちらも `claude-opus-5` へ落ちる。解決先だけで
    // 比べると「もう目的のモデル」と判定され、**エラーも出さずに無視される**。
    // 利用者から見ると「選んでも戻る」になる。
    //
    // グローバル既定を `opus[1m]` にして起こすと、効いている別名がそれになる。
    // 移動先の `opus` は「以前に選んだことがある」状態を作るために覚えさせておく
    let (_path, server) = common::server_with_fake_global(
        "alias-move",
        r#"{ "model": "opus[1m]" }"#,
        refresh_config(),
    )
    .await;
    let manager = &server.manager;
    manager.aliases().learn(
        &ModelId::new("opus"),
        &ModelId::new("claude-opus-5"),
        "Opus 5",
    );

    let (session, mut watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-opus-5").await;
    assert_eq!(
        session.model_alias(),
        Some(ModelId::new("opus[1m]")),
        "注入した既定が、起動時に効いている別名になること"
    );

    manager
        .switch_model(&session, &ModelId::new("opus"))
        .await
        .expect("切り替えられること");

    watcher
        .drain_quiet_for(std::time::Duration::from_millis(300))
        .await;
    assert!(
        watcher
            .seen()
            .contains(&format!("{}opus", testkit::fake_claude::MODEL_SET_PREFIX)),
        "別名が違うので送られること。実際の画面:\n{}",
        watcher.seen()
    );
    assert_eq!(
        session.model_alias(),
        Some(ModelId::new("opus")),
        "効いている別名が入れ替わること"
    );
}

#[tokio::test]
async fn 名乗る値が変わらない切替でも確定する() {
    // B-2 の組は**定義からして同じフルIDへ落ちる**ので、切り替わっても名乗りが動かない。
    // 「値が動いたか」だけを見ていると確定に気づけず、楽観更新が15秒残って
    // 「切替中…」が出たまま元へ戻る
    let (_path, server) = common::server_with_fake_global(
        "quiet-confirm",
        r#"{ "model": "opus[1m]" }"#,
        refresh_config(),
    )
    .await;
    let manager = &server.manager;
    let (session, _watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-opus-5").await;

    let mark = session
        .request_model(&ModelId::new("opus"), None)
        .await
        .expect("送れること")
        .expect("別名が違うので送られること");
    assert!(
        session.settle_model_switch(mark).await,
        "名乗りが変わらなくても、要求と辻褄が合えば確定とみなすこと"
    );
    assert_eq!(session.meta().model, Some(ModelId::new("claude-opus-5")));
    assert_eq!(session.meta().model_requested, None);
}

#[tokio::test]
async fn 特定のモデルを指さない別名は覚えない() {
    // **C-1。** 要求中にモデルが動いたからといって、それが要求の結果とは限らない
    // （CLI は利用制限のフォールバックでも変える）。`opusplan` はモードであって
    // 特定のモデル1つを指さないので、1回の実測で対応を決めると嘘になる
    let (_path, server) =
        common::server_with_fake_global("no-learn", GLOBAL, refresh_config()).await;
    let manager = &server.manager;
    let (session, _watcher) = common::start_session(manager).await;
    common::wait_for_model(&session, "claude-fable-5[1m]").await;

    manager
        .switch_model(&session, &ModelId::new("opusplan"))
        .await
        .expect("切り替えられること");
    common::wait_for_model(&session, "claude-opus-5").await;

    assert_eq!(
        manager.aliases().resolve(&ModelId::new("opusplan")),
        None,
        "名乗りが別名を説明しないので覚えないこと"
    );
    assert!(
        manager.aliases().all().is_empty(),
        "実測: {:?}",
        manager.aliases().all()
    );
}
