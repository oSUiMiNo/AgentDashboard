//! ターミナル出力の配信まわりの検証。
//!
//! 消化するテスト計画の項目:
//!
//! - フェーズ2「コアレッシング」のうち **停止中は PTY 読み取りが止まり resume で再開する**
//!   （時間窓による合流そのものは `session::coalesce_stream` の単体テストで確認している）
//! - フェーズ2「リングバッファ」
//! - フェーズ6「大量出力」のサーバ側（ブラウザ側は Playwright の E2E が担当）

mod common;

use common::Watcher;
use protocol::frame::{self, FrameKind};
use session_host_core::config::SessionHostConfig;
use std::time::Duration;
use testkit::fake_claude;
use tokio::sync::broadcast;

/// 1MiB のスクロールバックと待ち行列を確実に溢れさせる量。
const LARGE_FLOOD: usize = 32 * 1024 * 1024;

#[tokio::test]
async fn 停止中はptyの読み取りが止まり再開で続きが流れる() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    common::send_line(&session, &format!("flood {LARGE_FLOOD}"));

    // 出力が始まったのを見てから止める
    watcher.wait_for("0123456789abcdef").await;
    session.set_client_pause(7, true);
    assert!(session.is_paused());
    assert!(
        !watcher.contains(fake_claude::FLOOD_END_MARKER),
        "止める前に出力が終わってしまった。LARGE_FLOOD を増やすこと"
    );

    // 止めた時点でまだ配信途中だった分を吸い切る
    watcher.drain_quiet_for(Duration::from_millis(300)).await;
    let settled = watcher.total_bytes;

    // 止まっている間は増えない（＝読み取り自体が止まっている）
    tokio::time::sleep(Duration::from_millis(300)).await;
    watcher.drain_quiet_for(Duration::from_millis(100)).await;
    assert_eq!(
        watcher.total_bytes, settled,
        "停止中なのに出力が増えている（読み取りが止まっていない）"
    );
    assert!(!watcher.contains(fake_claude::FLOOD_END_MARKER));

    // 再開すれば続きが流れ、最後まで届く（捨てていない）
    session.set_client_pause(7, false);
    assert!(!session.is_paused());
    watcher.wait_for(fake_claude::FLOOD_END_MARKER).await;
    assert!(watcher.total_bytes > settled);

    session.kill();
}

#[tokio::test]
async fn 停止要求は全クライアントが取り下げるまで解除されない() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;

    session.set_client_pause(1, true);
    session.set_client_pause(2, true);
    assert!(session.is_paused());

    session.set_client_pause(1, false);
    assert!(session.is_paused(), "まだ 2 が停止を求めている");

    // 切断時の取り下げでも解除される
    session.release_client(2);
    assert!(!session.is_paused());

    session.kill();
}

#[tokio::test]
async fn 後から開いた端末にはスクロールバックが最初に届く() {
    let manager = common::manager();
    let (session, mut first) = common::start_session(&manager).await;

    common::send_line(&session, "こんにちは");
    first
        .wait_for(&format!("{}こんにちは", fake_claude::RECEIVED_PREFIX))
        .await;

    // 別のブラウザタブが同じセッションを開いた状況
    let later = Watcher::attach(&session);
    assert_eq!(later.snapshots, 1, "1発のスナップショットで復元されること");
    assert!(
        later.contains(fake_claude::READY_MARKER),
        "起動時の出力から復元されること"
    );
    assert!(later.contains("こんにちは"));

    session.kill();
}

#[tokio::test]
async fn スクロールバックは上限を超えず末尾が残る() {
    let config = SessionHostConfig {
        pty_ring_buffer: 64 * 1024,
        ..SessionHostConfig::default()
    };
    let manager = common::manager_with(config);
    let (session, mut watcher) = common::start_session(&manager).await;

    common::send_line(&session, &format!("flood {}", 1024 * 1024));
    watcher.wait_for(fake_claude::FLOOD_END_MARKER).await;

    let framed = session.snapshot_frame();
    let frame = frame::decode(&framed).expect("フレームを分解できること");

    assert_eq!(frame.kind, FrameKind::PtySnapshot);
    assert_eq!(frame.card_id, session.card_id);
    assert_eq!(
        frame.payload.len(),
        64 * 1024,
        "上限ちょうどまでで打ち止めになること"
    );
    assert!(
        String::from_utf8_lossy(frame.payload).contains(fake_claude::FLOOD_END_MARKER),
        "古い方から捨てて直近が残ること"
    );

    session.kill();
}

#[tokio::test]
async fn 大量出力でもサーバ側のメモリが有界に保たれる() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    common::send_line(&session, &format!("flood {LARGE_FLOOD}"));
    watcher.wait_for(fake_claude::FLOOD_END_MARKER).await;

    assert_eq!(
        watcher.lagged, 0,
        "受信し続けている購読者は取りこぼさないこと"
    );
    assert!(
        watcher.total_bytes >= LARGE_FLOOD,
        "捨てずに全部届くこと: {} バイト",
        watcher.total_bytes
    );

    // 保持しているのはスクロールバックの上限ぶんだけ（＝出力量に比例して太らない）
    let framed = session.snapshot_frame();
    let payload_len = frame::decode(&framed)
        .expect("フレームを分解できること")
        .payload
        .len();
    assert_eq!(
        payload_len,
        SessionHostConfig::default().pty_ring_buffer,
        "保持量が設定の上限に収まっていること"
    );

    session.kill();
}

#[tokio::test]
async fn 受信しない購読者は取りこぼしを検知できスナップショットで作り直せる() {
    // 遅いクライアントへの対処そのものの確認はテスト計画フェーズ6（計画フェーズ4）だが、
    // 検知とスナップショットによる復帰の土台がここで成立していることを確かめておく
    let manager = common::manager();
    let (session, mut active) = common::start_session(&manager).await;

    // 購読するだけで一切受け取らないクライアント
    let (_snapshot, mut idle) = session.subscribe_with_snapshot();

    common::send_line(&session, &format!("flood {LARGE_FLOOD}"));
    active.wait_for(fake_claude::FLOOD_END_MARKER).await;

    let err = idle
        .recv()
        .await
        .expect_err("待ち行列に上限があるので取りこぼしが起きること");
    assert!(
        matches!(err, broadcast::error::RecvError::Lagged(_)),
        "実際: {err:?}"
    );

    // 取りこぼした側は、今の画面をまるごと送り直すことで復帰できる
    let framed = session.snapshot_frame();
    let frame = frame::decode(&framed).expect("フレームを分解できること");
    assert_eq!(frame.kind, FrameKind::PtySnapshot);
    assert!(
        String::from_utf8_lossy(frame.payload).contains(fake_claude::FLOOD_END_MARKER),
        "作り直しに使うのは最新の画面であること"
    );

    session.kill();
}
