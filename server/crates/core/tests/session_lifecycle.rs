//! PTY ライフサイクルの検証（テスト計画フェーズ2「PTYライフサイクル」）。
//!
//! 起動 → 出力の読み取り → 入力の書き込み → リサイズ → 終了（正常/異常）→ EOF までを、
//! 擬似 claude を相手に通しで確かめる。設計§6/§14 の portable-pty 実装規約が実際に
//! 成立していること（特に slave 先行ドロップで読み取りスレッドが確実に終わること）も
//! ここで担保する。

mod common;

use agentdashboard_core::session::pty::PtyProcess;
use portable_pty::{CommandBuilder, PtySize};
use protocol::SessionStatus;
use testkit::fake_claude;
use tokio::{sync::mpsc, time::timeout};

fn test_size() -> PtySize {
    PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tokio::test]
async fn 起動して入出力とリサイズができ正常終了で_ended_になる() {
    let manager = common::manager();
    let (session, mut watcher) = common::start_session(&manager).await;

    // 起動直後はフックがまだ無いので、設計§5 の定義どおり Starting のまま
    assert_eq!(session.status(), SessionStatus::Starting);
    assert!(watcher.contains(fake_claude::READY_MARKER));

    common::send_line(&session, "こんにちは");
    watcher
        .wait_for(&format!("{}こんにちは", fake_claude::RECEIVED_PREFIX))
        .await;

    session.resize(120, 40).expect("リサイズできること");

    common::send_line(&session, "exit");
    watcher.wait_for(fake_claude::BYE_MARKER).await;
    common::wait_for_status(&session, SessionStatus::Ended { ok: true }).await;

    // 一覧に載る情報も終了を反映していること
    let meta = session.meta();
    assert_eq!(meta.status, SessionStatus::Ended { ok: true });
    assert!(meta.claude_session_id.is_some());
}

#[tokio::test]
async fn killした場合は異常終了として_ended_になる() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;

    session.kill();
    common::wait_for_status(&session, SessionStatus::Ended { ok: false }).await;
}

#[tokio::test]
async fn 停止中のセッションをkillしても終了を検知できる() {
    // 読み取りを止めたまま kill すると、読み取りスレッドが待ったまま残りうる。
    // 起こしてから殺す順序になっているかの確認
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;

    session.set_client_pause(1, true);
    assert!(session.is_paused());

    session.kill();
    common::wait_for_status(&session, SessionStatus::Ended { ok: false }).await;
}

#[tokio::test]
async fn 異常終了の終了コードを取得できる() {
    let (chunks_tx, _chunks_rx) = mpsc::channel(8);

    let mut command = CommandBuilder::new(common::fake_claude());
    command.arg("--exit-code");
    command.arg("42");

    let (process, exit_rx) =
        PtyProcess::spawn(command, test_size(), chunks_tx).expect("PTY を開けること");

    let exit = timeout(common::TIMEOUT, exit_rx)
        .await
        .expect("時間内に終了すること")
        .expect("終了状態が届くこと");

    assert!(!exit.ok, "異常終了として扱われること");
    assert_eq!(exit.code, 42, "終了コードが伝わること");
    drop(process);
}

#[tokio::test]
async fn 子プロセスが終わると読み取りスレッドが畳まれて待ち行列が閉じる() {
    // slave を先に落としているおかげで、子が終われば master 側の読み取りも必ず終わる。
    // 送信側（＝読み取りスレッド）が消えると待ち行列が閉じるので、それを終了の証拠にする
    let (chunks_tx, mut chunks_rx) = mpsc::channel(8);

    let (process, exit_rx) = PtyProcess::spawn(
        CommandBuilder::new(common::fake_claude()),
        test_size(),
        chunks_tx,
    )
    .expect("PTY を開けること");

    process
        .write_input(b"exit\r")
        .expect("端末へ書き込めること");

    let exit = timeout(common::TIMEOUT, exit_rx)
        .await
        .expect("時間内に終了すること")
        .expect("終了状態が届くこと");
    assert!(exit.ok);

    while timeout(common::TIMEOUT, chunks_rx.recv())
        .await
        .expect("待ち行列が時間内に閉じること")
        .is_some()
    {
        // 残っている出力を読み切る。送信側が畳まれれば None が返って抜ける
    }
}

#[tokio::test]
async fn 存在しない作業ディレクトリでは起動せずエラーを返す() {
    let manager = common::manager();
    let err = manager
        .spawn("/存在しないはずのディレクトリ/agentdashboard")
        .expect_err("エラーになること");
    assert!(
        err.to_string().contains("作業ディレクトリが存在しません"),
        "実際: {err}"
    );
    assert!(manager.list().is_empty(), "カードは作られないこと");
}

#[tokio::test]
async fn archiveでカードが一覧から消える() {
    let manager = common::manager();
    let (session, _watcher) = common::start_session(&manager).await;
    assert_eq!(manager.list().len(), 1);

    manager.archive(session.card_id).expect("消せること");
    assert!(manager.list().is_empty());
    assert!(manager.get(session.card_id).is_none());
}
