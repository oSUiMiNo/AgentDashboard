//! 統合テスト共通のヘルパ。
//!
//! 本物の claude ではなく擬似 claude（`fake-claude`）を起動して、PTY からブラウザへ届く
//! までの経路をそのまま動かす。実 CLI を使う統合テストはテスト計画フェーズ4（計画フェーズ2）
//! の担当で、ここでは扱わない。

#![allow(dead_code)]

use agentdashboard_core::{
    config::Config,
    session::{Session, SessionManager},
};
use bytes::Bytes;
use protocol::{
    SessionStatus,
    frame::{self, FrameKind},
};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    sync::broadcast,
    time::{Instant, timeout},
};

/// テストが待つ上限。CI の遅い環境でも足りる程度に長く取る。
pub const TIMEOUT: Duration = Duration::from_secs(20);

/// 受信テキストのうち手元に残す末尾の長さ。
///
/// 大量出力のテストでは数十MBが流れるため、全部を文字列に貯めると無駄に太る。
/// 目印は必ず出力の末尾側に現れるので、末尾だけ見れば足りる。
const TAIL_LIMIT: usize = 64 * 1024;

pub fn fake_claude() -> PathBuf {
    testkit::fake_claude::path()
}

pub fn manager_with(config: Config) -> Arc<SessionManager> {
    SessionManager::with_program(
        Arc::new(config),
        fake_claude().to_string_lossy().into_owned(),
    )
}

pub fn manager() -> Arc<SessionManager> {
    manager_with(Config::default())
}

/// 起動する作業ディレクトリ。擬似 claude は中身を見ないので一時ディレクトリで足りる。
pub fn work_dir() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

/// ターミナル出力を購読して、届いたフレームを解釈しながら溜めていく。
///
/// ブラウザ側の [`TerminalPane`] がやることの最小版にあたる。スナップショット
/// （フレーム種別 `0x03`）を受け取ったら画面を作り直す、という挙動も再現している。
pub struct Watcher {
    receiver: broadcast::Receiver<Bytes>,
    tail: String,
    /// 受け取った payload の総バイト数
    pub total_bytes: usize,
    /// 通常の出力フレームの数
    pub output_frames: usize,
    /// スナップショットフレームの数
    pub snapshots: usize,
    /// 取りこぼしたフレーム数（遅いクライアントの検知）
    pub lagged: u64,
}

impl Watcher {
    pub fn attach(session: &Session) -> Self {
        let (snapshot, receiver) = session.subscribe_with_snapshot();
        let mut watcher = Self {
            receiver,
            tail: String::new(),
            total_bytes: 0,
            output_frames: 0,
            snapshots: 0,
            lagged: 0,
        };
        watcher.absorb(&snapshot);
        watcher
    }

    fn absorb(&mut self, framed: &Bytes) {
        let frame = frame::decode(framed).expect("フレームを分解できること");
        match frame.kind {
            FrameKind::PtySnapshot => {
                // 画面を作り直す指示。それまでに見た内容は捨てる
                self.tail.clear();
                self.snapshots += 1;
            }
            FrameKind::PtyOutput => self.output_frames += 1,
            FrameKind::PtyInput => panic!("サーバから入力フレームが届くことはない"),
        }
        self.total_bytes += frame.payload.len();

        // 擬似 claude の出力は ASCII のみなので、文字境界を気にせず素朴に扱ってよい
        self.tail.push_str(&String::from_utf8_lossy(frame.payload));
        if self.tail.len() > TAIL_LIMIT {
            let cut = self.tail.len() - TAIL_LIMIT;
            self.tail.drain(..cut);
        }
    }

    pub fn seen(&self) -> &str {
        &self.tail
    }

    pub fn contains(&self, marker: &str) -> bool {
        self.tail.contains(marker)
    }

    /// 目印が現れるまで受信を続ける。
    pub async fn wait_for(&mut self, marker: &str) {
        let deadline = Instant::now() + TIMEOUT;
        while !self.tail.contains(marker) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let received = timeout(remaining, self.receiver.recv()).await;
            match received {
                Ok(Ok(framed)) => self.absorb(&framed),
                Ok(Err(broadcast::error::RecvError::Lagged(count))) => self.lagged += count,
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    panic!(
                        "配信が閉じられました。{marker:?} を待っていました。実際の末尾:\n{}",
                        self.tail
                    )
                }
                Err(_) => panic!(
                    "{TIMEOUT:?} 以内に {marker:?} が現れませんでした。実際の末尾:\n{}",
                    self.tail
                ),
            }
        }
    }

    /// 指定した時間だけ受信を続け、その間に何も届かなくなったら止める。
    ///
    /// 「止めた後にもう流れてこないこと」を確かめる用。
    pub async fn drain_quiet_for(&mut self, quiet: Duration) {
        loop {
            match timeout(quiet, self.receiver.recv()).await {
                Ok(Ok(framed)) => self.absorb(&framed),
                Ok(Err(broadcast::error::RecvError::Lagged(count))) => self.lagged += count,
                Ok(Err(broadcast::error::RecvError::Closed)) => return,
                // 指定時間なにも届かなかった＝落ち着いた
                Err(_) => return,
            }
        }
    }
}

/// セッションが目的の状態になるまで待つ。
pub async fn wait_for_status(session: &Session, expected: SessionStatus) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let status = session.status();
        if status == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{TIMEOUT:?} 以内に {expected:?} になりませんでした。実際: {status:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 擬似 claude が起動しきるまで待って、監視役を返す。
pub async fn start_session(manager: &Arc<SessionManager>) -> (Arc<Session>, Watcher) {
    let session = manager
        .spawn(&work_dir())
        .expect("セッションを起動できること");
    let mut watcher = Watcher::attach(&session);
    watcher.wait_for(testkit::fake_claude::READY_MARKER).await;
    (session, watcher)
}

/// 端末へ1行送る。改行は端末の作法にあわせて CR を使う。
pub fn send_line(session: &Session, line: &str) {
    session
        .write_input(format!("{line}\r").as_bytes())
        .expect("端末へ書き込めること");
}
