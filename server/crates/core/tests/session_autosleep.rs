//! 入力待ちが続いたカードを自動でスリープする（自動スリープ テスト計画フェーズ2）。
//!
//! **判定そのもの**（どの状態を寝かせてよいか・時間の境界・`0` で止まること）は
//! `session_host_core::state` の表駆動で押さえてある。ここで見るのは**撃つ側**——
//! 見張りの1周が実際にカードを落とすか、1周の枚数を守るか、落としたあと起こし直せるか。
//!
//! # ここに置いてある理由
//!
//! **フックの受信口が要る。** 対象は `WaitingInput` だけなので、カードをその状態へ
//! 連れて行くには本物のフックを1件通すしかない——`session-host-core` 側のテストには
//! 受信口が無く、状態が `Starting` のまま動かない（実際に書いてみて踏んだ）。
//!
//! 擬似 claude を相手にするので**課金しない**。
//!
//! # しきい値を1秒にして実時間を待つ
//!
//! `last_activity_at` を外から動かす道が無い（`Session` の中に閉じている）ので、
//! **設定のほうを短くして本物の時間を待つ**。既定の2時間をテストのために外へ出す
//! 必要は無い——**設定キーであること自体が、この試験の前提でもある。**

#![allow(non_snake_case)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use agentdashboard_core::config::Config;
use protocol::{ClaudeSessionId, SessionStatus};
use session_host_core::session::Session;

/// しきい値。**1秒**にして、下の待ちで確実に越える。
const IDLE_SECS: u64 = 1;

/// しきい値を確実に越えるまで待つ。
///
/// **余裕を持たせてあるのは、境界そのものを見る試験ではないから。** 境界は
/// `state` 側の `自動スリープは時間が来るまで寝かせない` が1ミリ秒単位で見ている。
async fn 越えるまで待つ() {
    tokio::time::sleep(Duration::from_millis(1_400)).await;
}

/// 撃たれた相手が `Ended` へ変わるのを待つ。
///
/// `kill` は signal を送るだけで、状態が変わるのは擬似ターミナルの終了が届いてからである。
async fn 落ちきるまで待つ() {
    tokio::time::sleep(Duration::from_millis(700)).await;
}

fn 設定(idle_secs: u64) -> Config {
    Config {
        auto_sleep_idle_secs: idle_secs,
        ..Config::default()
    }
}

/// カードを「作業が終わって入力待ち」の状態にする。
async fn 入力待ちにする(server: &common::TestServer) -> Arc<Session> {
    let (session, mut watcher) = common::start_session(&server.manager).await;
    // **`Stop` は「そのターンが終わった」**——要望の「作業完了して入力待ち」そのもの
    common::fire_hook(&session, &mut watcher, "Stop", "").await;
    common::wait_for_status(&session, SessionStatus::WaitingInput).await;
    session
}

#[tokio::test]
async fn 入力待ちが続いたカードは自動で寝る() {
    let server = common::TestServer::start_with(設定(IDLE_SECS)).await;
    let session = 入力待ちにする(&server).await;

    越えるまで待つ().await;
    server.manager.sweep_once();

    // **人が押したときとまったく同じ形になる**（`Ended { ok: true }` ＝画面の「スリープ」）。
    // ここが `ok: false` になると、画面には「異常終了」と出てしまう
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;
}

/// 起こしたばかりのカードを、見張りが巻き込まないこと。
///
/// # しきい値そのものは、ここでは確かめられない
///
/// **この試験は「なぜ寝なかったか」を区別できない。** カードを `WaitingInput` へ
/// 連れて行くには `fire_hook` を通すしかなく、その中の `send_line` が `write_input` を
/// 呼ぶので、**打鍵の守りが先に効いてしまう**（`last_input_at` が今になる）。
/// この土台では、しきい値と打鍵の守りは**常に同時に動く**ので切り分けようがない。
///
/// **しきい値を見ているのは `state` 側の `自動スリープは時間が来るまで寝かせない`** で、
/// あちらは純関数を直に叩くので境界を1ミリ秒単位で押さえられる（わざと潰すと落ちる
/// ことも確かめてある）。**ここに残してあるのは、見張りの1周が起こしたてのカードを
/// 巻き込まないことの通し確認**である。
#[tokio::test]
async fn 起こしたてのカードは寝ない() {
    let server = common::TestServer::start_with(設定(IDLE_SECS)).await;
    let session = 入力待ちにする(&server).await;

    // **待たずに**1周回す
    server.manager.sweep_once();
    // **落ちきる時間を置いてから確かめる。** `kill` は signal を送るだけなので、
    // 直後はまだ `WaitingInput` に見える——置かないと**寝かせていても通ってしまう**
    落ちきるまで待つ().await;

    assert_eq!(
        session.status(),
        SessionStatus::WaitingInput,
        "しきい値を越えていないのに寝かせた"
    );
}

#[tokio::test]
async fn 打っている最中のカードは寝ない() {
    // **送信していない打鍵はフックを起こさない**ので、`last_activity_at` は1ミリ秒も
    // 進まない。そのままだと「1時間58分置いたカードを開き、**送らずに長い指示を
    // 打っている最中に**しきい値を越えて殺される」が起きる。
    //
    // **打ちかけの入力は端末の中にしか無いので、消えると戻らない。**
    let server = common::TestServer::start_with(設定(IDLE_SECS)).await;
    let session = 入力待ちにする(&server).await;

    越えるまで待つ().await;
    // **送らずに打っただけ。** 改行を入れていないのでフックは飛ばない
    session
        .write_input("途中まで書いた指示".as_bytes())
        .expect("端末へ書けること");
    server.manager.sweep_once();
    落ちきるまで待つ().await;

    assert_eq!(
        session.status(),
        SessionStatus::WaitingInput,
        "打っている最中に寝かせた（打ちかけの入力が消える）"
    );
}

#[tokio::test]
async fn 機能を止めると寝ない() {
    // **勝手に人のセッションを落とす機能なので、切れる口が本当に効くことを見る。**
    // 判定側の検査（`自動スリープはゼロで機能ごと止まる`）と対で、設定の配線まで通す
    let server = common::TestServer::start_with(設定(0)).await;
    let session = 入力待ちにする(&server).await;

    越えるまで待つ().await;
    server.manager.sweep_once();
    落ちきるまで待つ().await;

    assert_eq!(
        session.status(),
        SessionStatus::WaitingInput,
        "0 なのに寝かせた（止める口が塞がっている）"
    );
}

#[tokio::test]
async fn 一度に落とすのは一周の上限まで() {
    // **しきい値を超えるカードは同時に何枚も現れる**（夜のあいだに溜まる）。
    // 一斉に落とすとその瞬間に大量のプロセスが死ぬので、1周ぶんを絞る。
    //
    // **上限より1枚多く用意する**のが要点——ちょうどの枚数だと、絞れているのか
    // 全部落ちているのか見分けが付かない。
    let server = common::TestServer::start_with(設定(IDLE_SECS)).await;
    let mut sessions = Vec::new();
    for _ in 0..3 {
        sessions.push(入力待ちにする(&server).await);
    }

    越えるまで待つ().await;
    server.manager.sweep_once();
    落ちきるまで待つ().await;

    let 寝た = |sessions: &[Arc<Session>]| {
        sessions
            .iter()
            .filter(|s| matches!(s.status(), SessionStatus::Ended { .. }))
            .count()
    };
    assert_eq!(
        寝た(&sessions),
        2,
        "1周の上限を守っていない（3枚とも落ちていないか）"
    );
}

#[tokio::test]
async fn 撃ち終えた相手で次の周の枠を埋めない() {
    // **`kill` は signal を送るだけで、状態が `Ended` に変わるのは擬似ターミナルの
    // 終了が届いてからである。** その隙間、そのカードはまだ `WaitingInput` に見える。
    //
    // 見張りは1秒ごとに回るので、**隙間のあいだに次の周が来る**。弾かないと
    // 撃ち終えた相手をもう一度数えてしまい、**1周の枠をそれで使い切って、後ろに
    // 並んでいるカードがいつまでも寝ない。**
    //
    // # 2回の周を、待たずに続けて回すのが要点
    //
    // **間に待ちを入れると、この試験は守りが無くても通ってしまう**——撃たれた側が
    // 先に `Ended` へ変わり、そもそも枠を食わなくなるからである（最初にそう書いて、
    // わざと守りを外しても落ちないことで気づいた）。**隙間を再現して初めて検査になる。**
    let server = common::TestServer::start_with(設定(IDLE_SECS)).await;
    let mut sessions = Vec::new();
    for _ in 0..3 {
        sessions.push(入力待ちにする(&server).await);
    }

    越えるまで待つ().await;
    server.manager.sweep_once();
    // **待たない。** 撃った直後＝まだ `WaitingInput` に見えているうちに次の周を回す
    server.manager.sweep_once();
    落ちきるまで待つ().await;

    let 寝た = sessions
        .iter()
        .filter(|s| matches!(s.status(), SessionStatus::Ended { .. }))
        .count();
    assert_eq!(
        寝た, 3,
        "3枚とも寝ていない（撃ち終えた相手で2周目の枠を埋めている）"
    );
}

#[tokio::test]
async fn 自動で寝たカードも起こし直せる() {
    // **このイシューは実質「起こし直しを増やす工事」である。** 増える先が通れることを、
    // ここで1本だけ通しておく（土台＝`v0.1.135` が効いていることの確認でもある）。
    let server = common::TestServer::start_with(設定(IDLE_SECS)).await;
    let session = 入力待ちにする(&server).await;
    let card_id = session.card_id;

    越えるまで待つ().await;
    server.manager.sweep_once();
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    let in_flight = server
        .manager
        .begin_revive(card_id, None)
        .expect("印が立つこと");
    let revived = server
        .manager
        .revive(in_flight, &common::work_dir(), None, ClaudeSessionId::new())
        .await
        .expect("自動で寝たカードを起こし直せること");

    assert_eq!(revived.card_id, card_id, "同じカードで起き直っていない");
}

/// 開けるまで答えない Windows 側（メモリの測り。寝ているカードばかりなのに、メモリ不足で
/// セッションを起こせない 設計§25）。
#[derive(Debug, Default)]
struct 止める外 {
    開いた: std::sync::Mutex<bool>,
    合図: std::sync::Condvar,
}

impl 止める外 {
    fn 開ける(&self) {
        *self.開いた.lock().expect("ロックが壊れていない") = true;
        self.合図.notify_all();
    }
}

impl session_host_core::memory_watch::OutsideProbe for 止める外 {
    fn read(&self) -> session_host_core::memory_watch::Outside {
        let mut 開いた = self.開いた.lock().expect("ロックが壊れていない");
        while !*開いた {
            開いた = self.合図.wait(開いた).expect("ロックが壊れていない");
        }
        session_host_core::memory_watch::Outside {
            host_free_mb: Some(4_100),
            vmmem_mb: Some(4_300),
            error: None,
        }
    }
}

/// 落ちても門を開ける（閉じたままだと測りの糸が待ち続け、試験のプロセスが終われない）。
struct 門を開けて去る(Arc<止める外>);

impl Drop for 門を開けて去る {
    fn drop(&mut self) {
        self.0.開ける();
    }
}

#[tokio::test]
async fn 自動で寝かせても測りを待たない() {
    // 寝かせる前後でメモリを測る（設計§25）。Windows を聞くのは 1〜27 秒かかるので、
    // **見張りの1周がその答えを待つと、その間ほかのカードの見張りも止まる**
    use session_host_core::memory_watch::{Event, MemoryWatch, Step};
    let server = common::TestServer::start_with(設定(IDLE_SECS)).await;
    let 外 = Arc::new(止める外::default());
    let _札 = 門を開けて去る(Arc::clone(&外));
    let watch = MemoryWatch::new(
        Arc::new(session_host_core::memory_watch::ProcInside),
        Some(Arc::clone(&外) as Arc<dyn session_host_core::memory_watch::OutsideProbe>),
    );
    let mut rx = watch.subscribe();
    server.manager.set_memory_watch(watch);
    let session = 入力待ちにする(&server).await;

    越えるまで待つ().await;
    let manager = Arc::clone(&server.manager);
    tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || manager.sweep_once()),
    )
    .await
    .expect("★見張りの1周が、寝かせる前の測りの Windows の答えを待った")
    .expect("落ちていない");
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    外.開ける();
    let before = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("★寝かせた前後の測りが来ない")
        .expect("知らせを受けられること");
    assert_eq!(
        (before.step, before.event, before.card_id),
        (Step::Before, Event::SessionSleep, Some(session.card_id)),
        "★自動で寝かせた出来事として測っていない: {before:?}"
    );
}
