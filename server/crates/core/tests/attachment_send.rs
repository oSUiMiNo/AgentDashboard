//! 添付を付けた指示が、確定を待たせてから送られること（画像添付 テスト計画フェーズ4）。
//!
//! 相手は擬似 claude なので**課金なしで毎回走らせられる**。擬似 claude は本物と同じく、
//! 貼り付けの中に行末が画像の拡張子の行を見つけると、**確定より前に**入力欄へ
//! `[Image #N]` のチップを出す（設計§1-1 の実測に合わせてある）。
//!
//! ここで見るのは**継ぎ目**である。本文へパスを混ぜる形は `session::input` の単体テストが、
//! 印の数え方は同じく `count_image_marks` の単体テストが押さえている。こちらが確かめるのは
//! 「印が出るまで確定を書かない」「出たらすぐ書く」「出なければ断る」という**順序**のほう。
//!
//! # なぜ順序を見るのか
//!
//! claude 側の添付はディスクから読んで縮める非同期の処理で、既定の待ち（30ms）では
//! 間に合わない。間に合わないまま確定すると **パスの文字列だけが送られる**——利用者から
//! 見れば「送ったのに画像が届いていない」形で、完了条件がいちばん嫌っているものになる。

mod common;

use session_host_core::config::SessionHostConfig;
use std::time::{Duration, Instant};

/// 印を待つ上限を**縮めた**セッション。
///
/// # なぜ縮めるのか
///
/// 「印が出ないこと」を確かめる道は、**上限を待ち切ってからでないと入れない**。
/// 既定の5秒のままだと、その間ずっと枠を握って**時間に敏感な別のテストを落とす**
/// ——実際に `a2s::約束を積めないときは理由が残って畳まれる` と
/// `cli_term::キーは並べた順に届き確定はcrとして効く` が並列時だけ落ちた。
///
/// **上限の値そのものは、ここでは確かめていない。** 既定が5秒であることは
/// `config` の雛形検査（`雛形は全キーを網羅し既定値と一致する`）が見ている。
/// ここで見たいのは**上限に達したときの振る舞い**なので、値は短くてよい。
fn 短い上限() -> std::sync::Arc<session_host_core::session::SessionManager> {
    common::manager_with(SessionHostConfig {
        attachment_mark_wait_ms: 300,
        ..Default::default()
    })
}

/// 擬似 claude が画像として拾う名前。**行末が拡張子**でないと拾われない（設計§6-1）。
fn 画像パス(name: &str) -> String {
    format!("/tmp/{name}.png")
}

/// 添付を付けると、印が出てから確定が送られること。
///
/// # なぜ本文を空にするのか
///
/// 擬似 claude は**貼り付けの中の改行も行の区切りとして扱う**（複数行の指示が行ごとに
/// 届く、という既存の振る舞い）。本文を付けると、その改行の時点で `received:` が出て
/// しまい、**確定より前に出た `received:`** と区別が付かない。本文を空にすれば断片は
/// パス1つだけになり、`received:` は**確定の CR でしか出ない**。
#[tokio::test]
async fn 添付を付けた指示は印が出てから確定される() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    let path = 画像パス("a");
    session
        .send_instruction_with("", std::slice::from_ref(&path))
        .await
        .expect("印が出るので送れること");

    watcher.wait_for(&format!("received: {path}")).await;

    // 印が**先に**出ていること。あとから出たのでは「待った」ことにならない
    let seen = watcher.seen();
    let 印の位置 = seen.find("[Image #").expect("印が出ていること");
    let 確定の位置 = seen
        .find(&format!("received: {path}"))
        .expect("行が届いていること");
    assert!(印の位置 < 確定の位置, "確定が印より先に出ている:\n{seen}");
}

/// 添付が複数あるときは、**枚数ぶん**の印が出るまで待つこと。
///
/// 1枚でも欠けたまま確定すると、欠けたぶんはパスの文字列として送られる。
#[tokio::test]
async fn 添付の枚数ぶん印が出るまで待つ() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    let attachments = vec![画像パス("a"), 画像パス("b"), 画像パス("c")];
    session
        .send_instruction_with("3枚見て", &attachments)
        .await
        .expect("印が出るので送れること");

    // **最後の断片**が届くのを待つ。擬似 claude は貼り付けの中の改行でも行を出すので、
    // 本文で待つと**確定より前**に返ってしまい、印がまだ出ていない時点で数えることになる
    watcher
        .wait_for(&format!("received: {}", 画像パス("c")))
        .await;

    let seen = watcher.seen();
    let 印の数 = seen.matches("[Image #").count();
    assert_eq!(印の数, 3, "印が枚数ぶん出ていない:\n{seen}");
}

/// 印が出たら、**上限（5秒）を待たずに**すぐ確定すること。
///
/// 上限まで待つ作りだと、添付を付けるたびに5秒待たされる。「出たら進む」ことは
/// 速さの話ではなく、**待ちの上限を長く取れる根拠**でもある——すぐ帰れるからこそ、
/// 遅い機械のために上限を厚くしておける。
#[tokio::test]
async fn 印が出たら上限を待たずに確定する() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    let 始め = Instant::now();
    session
        .send_instruction_with("見て", &[画像パス("a")])
        .await
        .expect("印が出るので送れること");
    let かかった = 始め.elapsed();

    watcher.wait_for("received: 見て").await;
    assert!(
        かかった < Duration::from_secs(3),
        "上限まで待っている（{かかった:?}）。出たらすぐ確定すること"
    );
}

/// 印が出なければ、**確定を送らず・断り・端末側の入力欄を畳む**こと（設計§7-2・§21 読み替え3）。
///
/// # なぜ1本にまとめてあるのか
///
/// この道は**上限を待ち切ってからでないと入れない**ので、分けるとその回数だけ枠を握る。
/// 壊し方を当てたときも3本は必ず一緒に落ちたので、分けて得られるものが無い。
/// あわせて上限そのものも縮めてある（[`短い上限`]）。
///
/// # 3つを一度に見る
///
/// 1. **確定を送らない**——パスの文字列だけが本文として送られる結末にしない
/// 2. **断り文が、もう一度押してよいかを言う**——「画像を添付できませんでした」で終わらせない
/// 3. **端末側の入力欄を畳む**——`Ctrl+U` はチップを消さないので、残すと次の送信で積み上がる
#[tokio::test]
async fn 印が出なければ確定を送らず断って入力欄を畳む() {
    let manager = 短い上限();
    let (session, mut watcher) = common::start_session(&manager).await;

    // 拡張子が画像でないので、擬似 claude は印を出さない
    let err = session
        .send_instruction_with("見て", &["/tmp/notanimage.txt".to_string()])
        .await
        .expect_err("印が出ないので断ること");

    // 1. 確定が送られていないこと。送られていれば擬似 claude が行を受け取っている
    assert!(
        !watcher.seen().contains("received: 見て"),
        "断ったのに確定が送られている:\n{}",
        watcher.seen()
    );

    // 2. 断り文が、次にどうすればよいかを言っていること
    let 文 = format!("{err:#}");
    assert!(文.contains("印"), "何が起きたかを言っていない: {文}");
    assert!(
        文.contains("確定は送っていません"),
        "確定を送っていないことを言っていない: {文}"
    );
    assert!(
        文.contains("もう一度送れます") || 文.contains("二重に添付されます"),
        "次にどうすればよいかを言っていない: {文}"
    );

    // 3. 端末側の入力欄が畳まれていること。
    //    擬似 claude は `Esc` を2回受けると畳んだことを言う（本物は黙って消えるだけなので、
    //    PTY の外から観測する口がここにしか無い）
    watcher
        .wait_for(testkit::fake_claude::CANCELLED_MARKER)
        .await;
}

/// 添付が0枚なら、**待ちが1msも入らない**こと（設計§14）。
///
/// 添付を使わない送信を巻き添えにしないための約束。ここが崩れると、画像と関係のない
/// 指示まで遅くなる。書くバイト列が変わらないことは `session::input` の単体テストが
/// 見ているので、こちらは**時間**を見る。
#[tokio::test]
async fn 添付が無い送信は待たされない() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    let 始め = Instant::now();
    session
        .send_instruction("こんにちは")
        .await
        .expect("指示を送れること");
    let かかった = 始め.elapsed();

    watcher.wait_for("received: こんにちは").await;

    // 印を1回でも覗きに行くと、刻み（200ms）ぶんは必ず待つことになる。
    // **覗きもしない**ことを、その刻みより短いことで示す
    assert!(
        かかった < Duration::from_millis(200),
        "添付0枚なのに待っている（{かかった:?}）"
    );
}
