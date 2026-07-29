//! 統合テスト共通のヘルパ。
//!
//! 本物の claude ではなく擬似 claude（`fake-claude`）を起動して、PTY からブラウザへ届く
//! までの経路をそのまま動かす。実 CLI を使う統合テストはテスト計画フェーズ4（計画フェーズ2）
//! の担当で、ここでは扱わない。

#![allow(dead_code)]

use agentdashboard_core::{
    config::Config,
    parser::ParserSupervisor,
    session::{Session, SessionManager},
    ws::AppState,
};
use bytes::Bytes;
use protocol::{
    SessionStatus,
    frame::{self, FrameKind},
    ws::ServerMessage,
};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
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
/// 本番では `std::env::current_exe()` が自分自身を指すが、統合テストでは core が
/// ライブラリとして動くのでテストバイナリを指してしまう。ここで明示的に渡す。
pub fn hook_program() -> PathBuf {
    testkit::binary_path("agentdashboard")
}

/// パーサの実行ファイル（ビルド済みの `transcript-parser`）。
///
/// `hook_program` と同じ理由で明示的に渡す。本番は `current_exe()` の隣を見るが、
/// 統合テストでは core がライブラリとして動くのでテストバイナリの隣を探してしまう。
pub fn parser_program() -> PathBuf {
    testkit::binary_path("transcript-parser")
}

pub fn manager_with(config: Config) -> Arc<SessionManager> {
    SessionManager::with_programs(
        Arc::new(config),
        fake_claude().to_string_lossy().into_owned(),
        hook_program(),
    )
}

pub fn manager() -> Arc<SessionManager> {
    manager_with(Config::default())
}

/// 実際に待ち受けている core サーバ。フックの受信を端から端まで通すために使う。
pub struct TestServer {
    pub manager: Arc<SessionManager>,
    pub addr: SocketAddr,
    /// 立ち上げた場合のみ。パーサを使わないテストでは None
    pub parser: Option<Arc<ParserSupervisor>>,
    /// 立ち上げた場合のみ（自己修復のテストだけ）
    pub selfheal: Option<Arc<agentdashboard_core::selfheal::Selfheal>>,
    pub config: Arc<Config>,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    /// 空きポートで core を起動する。
    ///
    /// **先にポートを確定させてから設定を作る**のが要点。注入する settings には
    /// フックの宛先URLが焼き込まれるため、後からポートが変わると届かなくなる。
    pub async fn start() -> Self {
        Self::start_with(Config::default()).await
    }

    pub async fn start_with(config: Config) -> Self {
        Self::start_with_program(config, fake_claude().to_string_lossy().into_owned()).await
    }

    /// 起動する CLI を明示して立ち上げる（実CLI統合テストが本物の claude を指すため）。
    /// パーサ（transcript-parser の子プロセス）も立ち上げて起動する。
    ///
    /// 構造化ビューを端から端まで通すテスト専用。パーサを使わないテストで毎回
    /// 子プロセスを起こすと、テストの本数だけ無駄なプロセスが増える。
    pub async fn start_with_parser(config: Config) -> Self {
        let server = Self::build(config, fake_claude().to_string_lossy().into_owned(), true).await;
        // 起動直後は指示を受け付けられないので、パーサが立ち上がる間を置く
        tokio::time::sleep(Duration::from_millis(200)).await;
        server
    }

    pub async fn start_with_program(config: Config, program: String) -> Self {
        Self::build(config, program, false).await
    }

    /// パーサに加えて自己修復も立ち上げる（設計§9）。
    ///
    /// 外の世界へ出る操作（cargo・git・本物の claude）は呼び出し側が差し替える。
    /// コンテナの中から docker は叩けないので、ここは差し替えが前提になる。
    pub async fn start_with_selfheal(
        config: Config,
        ops: Arc<dyn agentdashboard_core::selfheal::ops::SelfhealOps>,
    ) -> Self {
        // 差し替えの検証をするので、パーサの場所は**ポインタ経由**で決めさせる。
        // 環境変数で名指しすると探索順の先頭にあたり、差し替えても効かなくなる
        let state_dir = config.resolved_state_dir();
        std::fs::create_dir_all(&state_dir).expect("状態の置き場所を作れること");
        std::fs::write(
            state_dir.join(agentdashboard_core::parser::PARSER_POINTER),
            parser_program().to_string_lossy().as_bytes(),
        )
        .expect("ポインタを書けること");

        let mut server = Self::build_with(
            config,
            fake_claude().to_string_lossy().into_owned(),
            true,
            false,
        )
        .await;
        server.selfheal = Some(agentdashboard_core::selfheal::Selfheal::start(
            Arc::clone(&server.manager),
            Arc::clone(server.parser.as_ref().expect("パーサを起動している")),
            Arc::clone(&server.config),
            Some(ops),
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        server
    }

    /// 起動する CLI を明示したうえで、パーサも立ち上げる（実CLI×構造化ビュー用）。
    pub async fn start_with_parser_and_program(config: Config, program: String) -> Self {
        let server = Self::build(config, program, true).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        server
    }

    async fn build(config: Config, program: String, with_parser: bool) -> Self {
        Self::build_with(config, program, with_parser, true).await
    }

    /// `name_parser_by_env` を false にすると、パーサの場所をポインタに決めさせる
    /// （自己修復の差し替えを検証するテスト用）。
    async fn build_with(
        mut config: Config,
        program: String,
        with_parser: bool,
        name_parser_by_env: bool,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("空きポートで待ち受けられること");
        let addr = listener.local_addr().expect("待ち受け先を取れること");
        config.port = addr.port();

        let config = Arc::new(config);
        let manager = SessionManager::with_programs(Arc::clone(&config), program, hook_program());

        let mut state = AppState::new(Arc::clone(&manager), Arc::clone(&config));
        let parser = if with_parser {
            // 本番と同じ入口（環境変数）でビルド済みのパーサを指す
            if name_parser_by_env {
                unsafe {
                    std::env::set_var(
                        agentdashboard_core::parser::PARSER_BIN_ENV,
                        parser_program(),
                    );
                }
            }
            let parser = ParserSupervisor::start(Arc::clone(&manager), Arc::clone(&config));
            manager.attach_parser(parser.handle());
            state = state.with_parser(Arc::clone(&parser));
            Some(parser)
        } else {
            None
        };

        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, agentdashboard_core::build_router(state)).await;
        });

        Self {
            manager,
            addr,
            parser,
            selfheal: None,
            config,
            task,
        }
    }

    /// フックの受信口を直接叩く（擬似 claude を介さない経路の確認用）。
    ///
    /// HTTP クライアントがブロッキングなので、必ず専用スレッドへ逃がす。テストの
    /// スレッドで直接待つと、同じランタイムで動いているサーバが応答できなくなり、
    /// 自分の応答を自分で待ち続ける形で止まってしまう。
    pub async fn post_hook(&self, token: &str, event: &str, body: &str) -> u16 {
        let (addr, path, body) = (
            self.addr,
            format!("/hook/{token}/{event}"),
            body.to_string(),
        );
        tokio::task::spawn_blocking(move || testkit::post_json(addr, &path, &body))
            .await
            .expect("送信スレッドが正常に終わること")
            .expect("受信口へ送れること")
    }

    pub async fn get(&self, path: &str) -> (u16, String) {
        let (addr, path) = (self.addr, path.to_string());
        tokio::task::spawn_blocking(move || testkit::get(addr, &path))
            .await
            .expect("送信スレッドが正常に終わること")
            .expect("応答が返ること")
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 一覧の更新通知を受け取り、目的の種類が来るまで待つ。
pub struct EventWatcher {
    receiver: broadcast::Receiver<ServerMessage>,
}

impl EventWatcher {
    pub fn attach(manager: &SessionManager) -> Self {
        Self {
            receiver: manager.subscribe_events(),
        }
    }

    /// 条件に合うメッセージが届くまで受信を続ける。
    pub async fn wait_for(
        &mut self,
        what: &str,
        matches: impl Fn(&ServerMessage) -> bool,
    ) -> ServerMessage {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match timeout(remaining, self.receiver.recv()).await {
                Ok(Ok(message)) => {
                    if matches(&message) {
                        return message;
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    panic!("配信が閉じられました。{what} を待っていました")
                }
                Err(_) => panic!("{TIMEOUT:?} 以内に {what} が届きませんでした"),
            }
        }
    }
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
