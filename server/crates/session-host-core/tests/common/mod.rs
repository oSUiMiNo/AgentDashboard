//! セッションを相手にする統合テストの共通ヘルパ。
//!
//! 本物の claude ではなく擬似 claude（`fake-claude`）を起動して、PTY の実物を通す。
//! 実 CLI を使う統合テストはテスト計画フェーズ4 の担当で、ここでは扱わない。
//!
//! # ここに置いてある理由
//!
//! PTY・フック・状態の導出はセッションホスト側に閉じている（セルフホスト化設計§2-2）ので、
//! それを確かめるハーネスも**サーバ側を1行も持たずに**成立する。この分け方そのものが
//! 「閉じている」ことの確認になっている。
//!
//! ブラウザ配信まで通すテスト（`agentdashboard-core` 側）は、このファイルを
//! `#[path]` で読み込んだうえで、待ち受けるサーバのぶんを足している。**同じ内容を
//! 2つ持つと片方だけが古くなる**ので、コピーはしない。

#![allow(dead_code)]

use bytes::Bytes;
use protocol::{
    SessionStatus,
    frame::{self, FrameKind},
};
use session_host_core::{
    claude_settings::ClaudeSettings,
    config::SessionHostConfig,
    events::LocalEventBus,
    model_aliases::ModelAliases,
    session::{Session, SessionManager},
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

/// フックが叩く実行ファイル（ビルド済みの `agentdashboard`）。
///
/// 本番では `std::env::current_exe()` が自分自身を指すが、統合テストでは
/// ライブラリとして動くのでテストバイナリを指してしまう。ここで明示的に渡す。
pub fn hook_program() -> PathBuf {
    testkit::binary_path("agentdashboard")
}

/// 使い捨ての置き場所に一意な名前を付けるための連番。
///
/// nextest はテストごとにプロセスを分けるのでプロセスIDだけでも足りるが、
/// 1つのテストが複数のマネージャを作る場合に備えて連番も足しておく。
static THROWAWAY_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// テストが**本物の `~/.claude/settings.json` を読みに行かない**ようにする。
///
/// [`SessionManager::with_programs`] は設定が指定されていないと
/// [`ClaudeSettings::discover`]＝利用者の本物のファイルへ落ちる。書き込みは
/// テストごとに一時ファイルを渡して塞いでいたが、**読み込みが塞がれていなかった**。
/// 開発者の設定に `model` があると、その値が擬似 claude へ注入され、
/// 設定ファイルを持たない CI とは違う経路を通ることになる。
///
/// 指し先のファイルは**作らない**。読めなければ何もしないのが `claude_settings` の
/// 約束なので、これで「グローバル既定は指定なし」＝CI と同じ状態になる。
pub fn claude_settings_for(config: &SessionHostConfig) -> Arc<ClaudeSettings> {
    // テストが自分で使い捨てのファイルを指定しているならそれを尊重する
    if let Some(path) = &config.claude_settings_path {
        return Arc::new(ClaudeSettings::new(path.clone()));
    }
    let seq = THROWAWAY_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "agentdashboard-no-global-{}-{seq}",
        std::process::id()
    ));
    Arc::new(ClaudeSettings::new(dir.join("settings.json")))
}

/// テスト用のマネージャを組み立てる。
///
/// 別名の置き場所も in_memory へ寄せる。[`SessionManager::with_programs`] は
/// `config.resolved_state_dir()` を使うが、`SessionHostConfig::default()` ではそれが
/// **開発者の本物の状態ディレクトリ**（`~/.local/state/agentdashboard`）になる。
/// グローバル設定と同じ性質の漏れなので、まとめて塞ぐ。
pub fn build_manager(config: Arc<SessionHostConfig>, program: String) -> Arc<SessionManager> {
    build_manager_with(config, program, Arc::new(LocalEventBus::new()))
}

/// 報告先を明示して作る。
///
/// ブラウザ配信まで通すテスト（束ねる層）は、報告を記録層（DB）へ運ぶ実装を渡す。
/// **セッションホスト単体のテストは手元の配信のままでよい**——確かめたいのが PTY と
/// フックの往復で、記録はその先の話だから。
pub fn build_manager_with(
    config: Arc<SessionHostConfig>,
    program: String,
    events: Arc<dyn session_host_core::events::EventSink>,
) -> Arc<SessionManager> {
    let claude_settings = claude_settings_for(&config);
    SessionManager::with_everything(
        config,
        program,
        hook_program(),
        claude_settings,
        Arc::new(ModelAliases::in_memory()),
        events,
    )
}

pub fn manager_with(config: SessionHostConfig) -> Arc<SessionManager> {
    build_manager(
        Arc::new(config),
        fake_claude().to_string_lossy().into_owned(),
    )
}

pub fn manager() -> Arc<SessionManager> {
    manager_with(SessionHostConfig::default())
}

/// 起動する作業ディレクトリ。擬似 claude は中身を見ないので一時ディレクトリで足りる。
pub fn work_dir() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

/// ターミナル出力を購読して、届いたフレームを解釈しながら溜めていく。
///
/// ブラウザ側の `TerminalPane` がやることの最小版にあたる。スナップショット
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
            // 画面のフレームはセッションホスト→サーバの区間にしか存在せず、ブラウザへ渡る
            // 前に `PtySnapshot` / `PtyOutput` へ移し替えられる（設計§4-3）。ここに
            // 届いたなら移し替えを忘れている
            FrameKind::ScreenFull | FrameKind::ScreenDiff => {
                panic!(
                    "画面のフレームがブラウザ向けの経路へ漏れている: {:?}",
                    frame.kind
                )
            }
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

/// 擬似 claude に、注入された settings のフックを実際に起動させる。
///
/// 実行が終わったことを示すマーカーを待ってから戻るので、呼び出し側は
/// 「ダッシュボードが受け取り終わった状態」で検証に進める。`extra` にはイベント固有の
/// フィールド（`notification_type` など）を JSON で渡す。
pub async fn fire_hook(session: &Session, watcher: &mut Watcher, event: &str, extra: &str) {
    let command = if extra.is_empty() {
        format!("hook {event}")
    } else {
        format!("hook {event} {extra}")
    };
    send_line(session, &command);
    watcher
        .wait_for(&format!(
            "{}{event}",
            testkit::fake_claude::HOOK_SENT_PREFIX
        ))
        .await;
}
