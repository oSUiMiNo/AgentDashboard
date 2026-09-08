//! **届いたことを確かめてから確定する**送信（ブランチ設計§3-7）。
//!
//! # なぜ実物の PTY で確かめるのか
//!
//! この仕組みの危ういところは**照合そのもの**である——書いた本文が、端末の echo として
//! 本当に現れるか。ここを模型で置き換えると、**照合が効かないまま緑になる**。
//!
//! 2026-09-08 に実機で踏んだ形はこうだった：呼び戻した直後の席へ `/branch` を撃ったが、
//! TUI がまだ後処理を描いており、**エラーも出ないまま消えた**。段取りは7分待ち続けた。

mod common;

use std::time::Duration;
use testkit::fake_claude;

/// 本文が echo として現れたら、確定まで進んで**命令が効く**。
///
/// **確定が届いたことまで見る。** echo を確かめただけで終えると、「入力欄に文字は
/// 入ったが送られていない」形を見逃す。
#[tokio::test]
async fn 届いたことを確かめてから確定する() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    session
        .send_command_confirmed("dump")
        .await
        .expect("届いたことを確かめて送れること");

    // 命令が実際に走った印。ここまで来て初めて「確定も届いた」と言える
    watcher.wait_for(fake_claude::DUMP_END_MARKER).await;
}

/// **端末が描いている最中に頼んでも、最終的に届く。**
///
/// これが 2026-09-08 の事故の芯である。状態は「入力待ち」でも、端末が動いている間に
/// 書いた文字は消える。
///
/// # 何を保証しているのか（壊し方を当てて分かったこと）
///
/// **静けさを待つ段を外しても、この試験は落ちない**（2026-09-08 に実際に外して確かめた。
/// 0.8秒が3.5秒になるだけで通る）。**保証しているのは「確かめて撃ち直す」ほう**であり、
/// 静けさは**無駄な撃ち直しを減らす近道**にすぎない。
///
/// **そう分かったので、試験の名前を実態へ合わせてある。** 「静けさを待つことの試験」と
/// 名乗らせたままにすると、次に読む人が**効いていないものを効いていると信じる**。
#[tokio::test]
async fn 描いている最中に頼んでも最終的に届く() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    // 端末を長めに描かせる（8MiB）
    common::send_line(&session, "flood 8388608");
    // 描き始めたのを見てから頼む
    watcher.wait_for("0123456789abcdef").await;

    session
        .send_command_confirmed("dump")
        .await
        .expect("描き終わってから送れること");

    // **測るのはリング（端末が実際に書いた中身）であって、見張り役ではない。**
    // 見張り役は受信が遅れるので、そちらで測ると「まだ届いていない」だけの状態を
    // 「まだ描いている」と読み違える（最初にこれで落とした）
    let 端末が書いたもの = session.scrollback_since(0, 16 * 1024 * 1024);
    assert!(
        端末が書いたもの.contains(fake_claude::FLOOD_END_MARKER),
        "端末が描き終わる前に撃っている（静けさを待っていない）"
    );

    watcher.wait_for(fake_claude::DUMP_END_MARKER).await;
}

/// 普通の送信は**確かめない**（§3-7-3）。
///
/// **人が押した送信の振る舞いを変えていないこと**を固定する。届かなければ画面を見て
/// いる本人が気づくので、機械が確かめる意味が薄く、本文が自由な文字列なので照合も揺れる。
#[tokio::test]
async fn 普通の送信は確かめずにそのまま送る() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    let 始め = std::time::Instant::now();
    session
        .send_instruction("dump")
        .await
        .expect("そのまま送れること");
    let かかった = 始め.elapsed();

    watcher.wait_for(fake_claude::DUMP_END_MARKER).await;

    // **静けさ（400ms）も echo の待ち（刻み 100ms）も挟んでいないこと。**
    // 挟んでいれば、人が押すたびにその時間だけ待たされる
    assert!(
        かかった < Duration::from_millis(300),
        "普通の送信に確かめの待ちが混ざっている（{かかった:?}）"
    );
}
