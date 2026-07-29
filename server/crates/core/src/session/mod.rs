//! セッション（＝一覧画面の小窓1枚）の管理（設計§6）。
//!
//! [`SessionManager`] がカードの集合を持ち、[`Session`] が1枚分の状態と PTY を持つ。
//! PTY の生々しい扱いは [`pty`]、起動条件の組み立ては [`lifecycle`] に分けてある。
//!
//! # PTY のバイトがブラウザへ届くまで
//!
//! 1. [`pty::PtyProcess`] の専用スレッドが PTY から読み、チャンクを待ち行列へ流す
//! 2. セッションごとの**合流タスク**（[`coalesce_loop`]）が `coalesce_ms` の窓でチャンクを
//!    1つにまとめる。1文字ごとに WebSocket フレームを作ると数が爆発するため
//! 3. まとめたバイトを ①スクロールバック用のリングバッファへ追記 ②配信チャネルへ流す
//! 4. 配信チャネルは [`tokio::sync::broadcast`]。**同じ [`Bytes`] を clone（参照カウントを
//!    増やすだけ）して全購読者へ配る**ので、クライアントが増えてもコピーは増えない
//!
//! broadcast は購読者ごとに固定長の待ち行列を持ち、受信が遅れて溢れた購読者には
//! `Lagged` が返る。これがそのまま「遅いクライアントの検知」になり、検知したら
//! リングバッファのスナップショット（フレーム種別 `0x03`）を送り直して復帰させる。

pub mod hooks_settings;
pub mod input;
pub mod lifecycle;
pub mod pty;

use crate::{
    config::Config,
    state::{self, Changed, HookInput},
    transcript::{Anchor, TranscriptWindow},
};
use bytes::Bytes;
use hooks_settings::HookSettings;
use protocol::{
    CardId, ClaudeSessionId, NodeId, ProjectId, SessionMeta, SessionStatus, Timestamp, TreeNode,
    frame::{self, FrameKind},
    ipc::ParsedNode,
    ws::ServerMessage,
};
use pty::{PtyExit, PtyProcess};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, mpsc};

/// 読み取りスレッド → 合流タスクの待ち行列（チャンク数）。
///
/// ここが詰まると読み取りスレッドが待つので、フロー制御の一段目としても働く。深くすると
/// 大量出力を溜め込めてしまい、停止を指示してからも配信が続く時間が延びるため浅くしておく。
const CHUNK_QUEUE: usize = 8;

/// 1フレームに合流させる上限（バイト）。大量出力時にフレームが無制限に育つのを防ぐ。
const MAX_COALESCED_FRAME: usize = 128 * 1024;

/// ターミナル購読1本あたりの配信待ち行列（フレーム数）。
///
/// 8ms 窓なら毎秒 125 フレーム程度なので、およそ1秒分の余裕にあたる。これを超えて
/// 遅れたクライアントはスナップショットで作り直す。
pub const OUTPUT_QUEUE_FRAMES: usize = 128;

/// 一覧の更新通知の待ち行列（メッセージ数）。
const EVENT_QUEUE_MESSAGES: usize = 256;

/// 履歴購読1本あたりの配信待ち行列（メッセージ数）。
///
/// 履歴はツールコールの頻度で流れるので PTY ほど高頻度ではない。溢れたクライアントは
/// ウィンドウ全体を送り直せば追いつける（同じIDは上書きなので重複は害にならない）。
pub const TRANSCRIPT_QUEUE_MESSAGES: usize = 64;

/// 起動直後の端末サイズ。ブラウザがターミナルを開いた時点で `resize` が届く。
const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;

/// 停滞（ハング）の見張りが一巡する間隔。
///
/// 判定そのもののしきい値は `config.stalled_threshold_secs`（既定120秒）で、こちらは
/// 「何秒おきに見に行くか」。小窓の経過時間表示は1秒刻みなので、同じ粒度にしてある。
const STALLED_SWEEP_INTERVAL: Duration = Duration::from_secs(1);

/// 指示の本文を書いてから、確定の CR を書くまでの間（設計§18）。
///
/// 0 にすると2つの書き込みが1回の読み取りにまとまり、TUI が貼り付けの処理で
/// CR まで飲み込む。人の打鍵より十分速く、TUI の取りこぼしより十分遅い値にする。
const INSTRUCTION_SETTLE: Duration = Duration::from_millis(30);

pub fn now_ms() -> Timestamp {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as Timestamp)
        .unwrap_or_default()
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("作業ディレクトリが存在しません: {0}")]
    CwdNotFound(String),
    #[error("作業ディレクトリがフォルダではありません: {0}")]
    CwdNotDirectory(String),
    #[error("セッションを起動できませんでした: {0}")]
    Spawn(String),
    #[error("セッションが見つかりません: {0}")]
    NotFound(CardId),
    #[error("フック設定を用意できませんでした: {0}")]
    Settings(String),
}

/// スクロールバック用の固定容量バッファ。
///
/// 上限を超えたら古いバイトから捨てる。ブラウザを開き直したときに「直前までの画面」を
/// 復元するのが目的なので、全履歴を持つ必要はない。
#[derive(Debug)]
pub struct RingBuffer {
    buffer: VecDeque<u8>,
    capacity: usize,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buffer: VecDeque::new(),
            capacity,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.capacity {
            // 1回の書き込みだけで容量を超える場合は、末尾の容量分だけを残す
            self.buffer.clear();
            self.buffer.extend(&data[data.len() - self.capacity..]);
            return;
        }
        self.buffer.extend(data);
        if self.buffer.len() > self.capacity {
            let excess = self.buffer.len() - self.capacity;
            self.buffer.drain(..excess);
        }
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buffer.iter().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }
}

/// 一覧画面の小窓1枚に対応する、生きているセッション。
pub struct Session {
    pub card_id: CardId,
    meta: Mutex<SessionMeta>,
    process: PtyProcess,
    ring: Mutex<RingBuffer>,
    output: broadcast::Sender<Bytes>,
    /// 停止を要求しているクライアント。1つでも要求していれば読み取りを止める。
    ///
    /// 判定材料をターミナル購読クライアントに限るのは設計§10 の指示。構造化ビューしか
    /// 見ていないクライアントの都合で端末が止まると、全体が停滞してしまう。
    pause_requests: Mutex<HashSet<u64>>,
    /// このセッションに注入したフック設定（一時ファイルとトークン）。
    settings: HookSettings,
    /// SessionStart フックが知らせてきた JSONL の場所。パーサに監視を頼む先でもある。
    transcript_path: Mutex<Option<String>>,
    /// 構造化ビュー用の履歴。メモリに持つのは直近ウィンドウだけ（設計§4）
    transcript: Mutex<TranscriptWindow>,
    /// 履歴の配信。PTY と違い**購読しているクライアントにだけ**流す。
    ///
    /// 一覧しか開いていないクライアントにまで履歴を送ると、12セッション同時稼働のときに
    /// 無関係な JSON で送信キューが埋まる。PTY の配信（[`Session::output`]）と対称に、
    /// カード単位のチャネルを持たせている。
    transcript_tx: broadcast::Sender<Arc<String>>,
    /// 終了が「想定内」であることの印。
    ///
    /// ダッシュボードから終了させた場合、子プロセスは強制終了されるので終了コードは
    /// 非ゼロになる。それをそのまま「異常終了」と表示すると、利用者が自分で終わらせたのに
    /// 落ちたように見えてしまうため、指示した側で印を立てておく。
    expected_exit: AtomicBool,
    /// PTY が何か出力したか（設計§11 の「フック未受信」判定の片側）。
    ///
    /// 「CLI は動いているのにフックが1件も来ない」を見分けるために要る。出力が無い
    /// だけなら単に起動が遅いだけかもしれず、警告を出すのは早すぎる。
    saw_output: AtomicBool,
}

/// スクロールバックの中身まで出すと数MBの表示になるので、要点だけを出す。
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let meta = self.meta();
        f.debug_struct("Session")
            .field("card_id", &self.card_id)
            .field("project", &meta.project)
            .field("status", &meta.status)
            .finish_non_exhaustive()
    }
}

impl Session {
    pub fn meta(&self) -> SessionMeta {
        self.meta.lock().expect("ロックが壊れていない").clone()
    }

    pub fn status(&self) -> SessionStatus {
        self.meta.lock().expect("ロックが壊れていない").status
    }

    /// 現在のスクロールバックと、その続きを受け取る購読口を**同時に**取得する。
    ///
    /// スナップショットと購読開始がずれると、間に流れたバイトを取りこぼすか、逆に
    /// スナップショットに含まれるバイトを二重に書いてしまう。どちらも端末の表示を壊すので、
    /// リングバッファのロックを握ったまま両方を作って隙間を無くしている
    /// （配信側の [`Self::publish_output`] も同じロックを追記と送信の両方で握る）。
    pub fn subscribe_with_snapshot(&self) -> (Bytes, broadcast::Receiver<Bytes>) {
        let ring = self.ring.lock().expect("ロックが壊れていない");
        let receiver = self.output.subscribe();
        let snapshot = Bytes::from(frame::encode(
            FrameKind::PtySnapshot,
            self.card_id,
            &ring.snapshot(),
        ));
        (snapshot, receiver)
    }

    /// 現在のスクロールバック全体を、画面リセット付きのフレームとして取り出す。
    ///
    /// 取りこぼしたクライアントを作り直すときに使う。
    pub fn snapshot_frame(&self) -> Bytes {
        let payload = self.ring.lock().expect("ロックが壊れていない").snapshot();
        Bytes::from(frame::encode(
            FrameKind::PtySnapshot,
            self.card_id,
            &payload,
        ))
    }

    /// いま端末に溜まっている量（バイト）。
    ///
    /// 「描画が落ち着いたか」を安く見るための口。内容を毎回文字列へ起こすと、
    /// スクロールバック1MiB を何度も複製することになる。
    pub fn scrollback_len(&self) -> usize {
        self.ring.lock().expect("ロックが壊れていない").len()
    }

    /// いま端末に出ている内容を文字列として覗く。
    ///
    /// **表示を組み立てるために使ってはいけない。** 構造化ビューは JSONL とフックから
    /// 作るのが本設計の柱で、ANSI 画面の解析はしない（要件）。ここは
    /// 「キーを送る前に、送ってよい画面かを確かめる」ためだけの口
    /// （自己修復が無人でセッションを操るときに要る。フェーズ3で、画面を見ずに送った
    /// キーが別の相手に吸われる事故を実測している）。
    pub fn scrollback_text(&self) -> String {
        let payload = self.ring.lock().expect("ロックが壊れていない").snapshot();
        String::from_utf8_lossy(&payload).into_owned()
    }

    /// 合流済みのバイトをスクロールバックへ追記し、購読者へ配る。
    fn publish_output(&self, payload: &[u8]) {
        // 「CLI は動いている」ことの証拠。フックが来ないときの判定材料になる（設計§11）。
        // 一覧のロックは取らない（毎フレーム取ると高頻度な出力で一覧が詰まる）
        self.saw_output.store(true, Ordering::Relaxed);

        // 追記と配信を同じロックの中で行うことで、購読開始との間に隙間を作らない
        let mut ring = self.ring.lock().expect("ロックが壊れていない");
        ring.push(payload);

        // フレームは1回だけ組み立てる。以降 broadcast が clone するのは参照カウントだけ
        let framed = Bytes::from(frame::encode(FrameKind::PtyOutput, self.card_id, payload));
        // 購読者が1人もいないときは Err になるが、それは異常ではない
        let _ = self.output.send(framed);
    }

    pub fn write_input(&self, bytes: &[u8]) -> anyhow::Result<()> {
        self.process.write_input(bytes)
    }

    /// Composer やダッシュボードからの指示を1つ送る（設計§6）。
    ///
    /// **本文と確定を別々に書く**のが要点。1回に繋げて書くと、本物の TUI が
    /// 貼り付けの処理で末尾の CR まで飲み込み、**指示が入力欄に残ったまま何も
    /// 起きない**（フェーズ6で実測。詳細は [`input`] のモジュール説明）。
    ///
    /// 指示を送る経路はここに集約する。`write_input` を直に呼んで組み立て直すと、
    /// 同じ壊れ方が別の場所で再発する。
    pub async fn send_instruction(&self, text: &str) -> anyhow::Result<()> {
        let (body, submit) = input::encode_parts(text);
        if !body.is_empty() {
            self.write_input(&body)?;
            // 貼り付けを受け取り終えてから確定を渡す。ここを詰めると、
            // 2つの書き込みが1回の読み取りにまとまって元の破綻へ戻る
            tokio::time::sleep(INSTRUCTION_SETTLE).await;
        }
        self.write_input(&submit)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.process.resize(cols, rows)
    }

    /// クライアント単位のフロー制御要求を受け付ける。
    pub fn set_client_pause(&self, client: u64, paused: bool) {
        let mut requests = self.pause_requests.lock().expect("ロックが壊れていない");
        if paused {
            requests.insert(client);
        } else {
            requests.remove(&client);
        }
        let any_paused = !requests.is_empty();
        drop(requests);
        self.process.set_paused(any_paused);
    }

    /// クライアントが離れたときに、その要求を取り下げる。
    ///
    /// これを忘れると、停止を要求したまま切れたクライアントのせいで端末が二度と
    /// 動かなくなる。
    pub fn release_client(&self, client: u64) {
        self.set_client_pause(client, false);
    }

    pub fn is_paused(&self) -> bool {
        self.process.is_paused()
    }

    pub fn kill(&self) {
        // 「利用者が終わらせた」ことを先に記録してから落とす。逆順だと、終了検知が
        // 先に走って異常終了として表示されてしまう
        self.expected_exit.store(true, Ordering::SeqCst);
        self.process.kill();
    }

    /// フックの受信URLに埋め込まれる、このセッション限りの合言葉。
    pub fn token(&self) -> &str {
        &self.settings.token
    }

    /// SessionStart フックが知らせてきた JSONL の場所（フェーズ3で使う）。
    pub fn transcript_path(&self) -> Option<String> {
        self.transcript_path
            .lock()
            .expect("ロックが壊れていない")
            .clone()
    }

    /// 履歴の購読を、いま持っているぶんの取得と**同じロックの中で**始める。
    ///
    /// PTY の [`Session::subscribe_with_snapshot`] と同じ理由。取得と購読開始がずれると、
    /// その隙間に届いたノードを取りこぼす。逆側にずれた場合は同じノードが二度届くが、
    /// 履歴は「同じIDは上書き」の約束なので害が無い。**迷ったら重ねる側に倒す。**
    pub fn subscribe_transcript(&self) -> (Vec<TreeNode>, broadcast::Receiver<Arc<String>>) {
        let window = self.transcript.lock().expect("ロックが壊れていない");
        let receiver = self.transcript_tx.subscribe();
        (window.snapshot(), receiver)
    }

    /// パーサが読んだノードを取り込み、購読者へ配る。
    pub fn append_transcript(&self, source: &str, nodes: &[ParsedNode]) {
        if nodes.is_empty() {
            return;
        }
        let mut window = self.transcript.lock().expect("ロックが壊れていない");
        window.append(source, nodes);
        self.broadcast_transcript(&ServerMessage::TranscriptAppend {
            card_id: self.card_id,
            nodes: nodes.iter().map(|parsed| parsed.node.clone()).collect(),
        });
    }

    /// 巻き戻り（`/rewind`）を受けて履歴を捨てる。
    pub fn reset_transcript(&self) {
        let mut window = self.transcript.lock().expect("ロックが壊れていない");
        window.clear();
        self.broadcast_transcript(&ServerMessage::TranscriptReset {
            card_id: self.card_id,
        });
    }

    /// 購読者が居るときだけ直列化して配る。
    ///
    /// 巨大な Edit の結果を JSON にする処理がコストの本体なので、誰も見ていないカードで
    /// それをやらない。ウィンドウの更新は購読の有無に関わらず続ける（開いた瞬間に
    /// 履歴が出るのはこのため）。
    fn broadcast_transcript(&self, message: &ServerMessage) {
        if self.transcript_tx.receiver_count() == 0 {
            return;
        }
        if let Ok(text) = serde_json::to_string(message) {
            let _ = self.transcript_tx.send(Arc::new(text));
        }
    }

    /// 取りこぼした購読者を作り直すための、ウィンドウ全体。
    pub fn transcript_snapshot(&self) -> Vec<TreeNode> {
        self.transcript
            .lock()
            .expect("ロックが壊れていない")
            .snapshot()
    }

    /// ウィンドウの中だけで「このノードより前」に答えられるなら答える。
    pub fn transcript_before(&self, before: &NodeId, limit: usize) -> Option<Vec<TreeNode>> {
        self.transcript
            .lock()
            .expect("ロックが壊れていない")
            .before_in_window(before, limit)
    }

    /// ウィンドウの外を読み直すための起点。
    pub fn transcript_anchor(&self, before: &NodeId) -> Option<Anchor> {
        self.transcript
            .lock()
            .expect("ロックが壊れていない")
            .anchor_for(before)
    }

    /// 届いたフック1件を状態機械へ通す（設計§5）。
    ///
    /// 判定そのものは [`crate::state::apply`] に閉じている。ここがやるのは
    /// 「時計を読む」「ロックを取る」「JSONL の場所を控える」という周辺の世話だけ。
    /// 変わった場合は、新しい JSONL の場所も返す（パーサへ監視を頼む引き金になる）。
    fn apply_hook(&self, input: &HookInput) -> (Changed, Option<String>) {
        let mut new_path = None;
        if let Some(path) = input.transcript_path() {
            let mut current = self.transcript_path.lock().expect("ロックが壊れていない");
            if current.as_deref() != Some(path) {
                *current = Some(path.to_string());
                new_path = Some(path.to_string());
            }
        }
        let mut meta = self.meta.lock().expect("ロックが壊れていない");
        (state::apply(&mut meta, input, now_ms()), new_path)
    }

    /// 停滞していないか見る（設計§5 のタイマー）。
    /// 見張りの1周ぶんをこのセッションに適用する（停滞とフック未受信）。
    fn sweep(&self, threshold_secs: u64) -> bool {
        let saw_output = self.saw_output.load(Ordering::Relaxed);
        let now = now_ms();
        let mut meta = self.meta.lock().expect("ロックが壊れていない");
        let stalled = state::sweep_stalled(&mut meta, now, threshold_secs);
        let silent = state::sweep_hook_silence(&mut meta, now, threshold_secs, saw_output);
        stalled || silent
    }

    /// 差分配信用の値をまとめて取り出す。
    fn status_snapshot(&self) -> (SessionStatus, u32, Timestamp) {
        let meta = self.meta.lock().expect("ロックが壊れていない");
        (meta.status, meta.subagent_active, meta.last_activity_at)
    }
}

/// 全セッションの管理者。
pub struct SessionManager {
    config: Arc<Config>,
    program: String,
    /// フックが起動する実行ファイル。既定は自分自身（設計§7）。
    hook_program: PathBuf,
    sessions: Mutex<HashMap<CardId, Arc<Session>>>,
    /// フックの合言葉 → どのカードのものか。
    ///
    /// 受信URLにカードIDをそのまま載せない理由は、推測できる値だと外から状態を
    /// 書き換えられてしまうため。合言葉はセッションごとのランダム値にする。
    tokens: Mutex<HashMap<String, CardId>>,
    events: broadcast::Sender<ServerMessage>,
    /// パーサへ監視を頼む口。パーサが立ち上がってから差し込まれる。
    ///
    /// 逆参照（パーサ → SessionManager）はここには持たせない。フックの処理を止めない
    /// ために、送信は待たない `try_send` にしてある（[`crate::parser::ParserHandle`]）。
    parser: Mutex<Option<crate::parser::ParserHandle>>,
}

impl SessionManager {
    pub fn new(config: Arc<Config>) -> Arc<Self> {
        Self::with_program(config, lifecycle::claude_program())
    }

    /// 起動する CLI を明示して作る。
    pub fn with_program(config: Arc<Config>, program: String) -> Arc<Self> {
        Self::with_programs(config, program, hooks_settings::hook_program())
    }

    /// 起動する CLI と、フックが叩く実行ファイルの両方を明示して作る。
    ///
    /// テストから擬似 claude とビルド済みの `agentdashboard` を指すための入口。
    /// プロセスの環境変数を書き換えずに済むので、テスト同士が互いを壊さない。
    pub fn with_programs(config: Arc<Config>, program: String, hook_program: PathBuf) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENT_QUEUE_MESSAGES);
        Arc::new(Self {
            config,
            program,
            hook_program,
            sessions: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            events,
            parser: Mutex::new(None),
        })
    }

    /// 起動する実行ファイル名（画面や調査で確認できるように公開する）。
    pub fn program(&self) -> &str {
        &self.program
    }

    /// 一覧の更新通知を購読する。
    pub fn subscribe_events(&self) -> broadcast::Receiver<ServerMessage> {
        self.events.subscribe()
    }

    /// 現在のカード一覧を作成順に返す。
    pub fn list(&self) -> Vec<SessionMeta> {
        let mut metas: Vec<SessionMeta> = self
            .sessions
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .map(|session| session.meta())
            .collect();
        metas.sort_by_key(|meta| meta.created_at);
        metas
    }

    pub fn get(&self, card_id: CardId) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .expect("ロックが壊れていない")
            .get(&card_id)
            .cloned()
    }

    /// 指定した作業ディレクトリで新しいセッションを起動する。
    pub fn spawn(self: &Arc<Self>, cwd: &str) -> Result<Arc<Session>, SessionError> {
        self.spawn_with(cwd, None, &[])
    }

    /// 起動引数を足してセッションを起動する（設計§9 の修復セッション）。
    ///
    /// 通常のセッションと同じ扱いで一覧に出る。修復のあいだ何が起きているかを
    /// 隠さないのが設計の意図なので、専用の入れ物は作らない。
    pub fn spawn_with_args(
        self: &Arc<Self>,
        cwd: &str,
        extra_args: &[String],
    ) -> Result<Arc<Session>, SessionError> {
        self.spawn_with(cwd, None, extra_args)
    }

    /// 既存のセッションを引き継いで起動する（設計§6 の resume）。
    ///
    /// カードは新しく作られるが、CLI 側のセッションIDは**こちらでは決められない**。
    /// 引き継いだ結果として CLI が別のIDを名乗る場合があるため、最初のフックが
    /// 運んでくる値で確定させる。UI からの導線はまだ無く、core の入口だけを用意している。
    pub fn resume(
        self: &Arc<Self>,
        cwd: &str,
        session_id: ClaudeSessionId,
    ) -> Result<Arc<Session>, SessionError> {
        self.spawn_with(cwd, Some(session_id), &[])
    }

    fn spawn_with(
        self: &Arc<Self>,
        cwd: &str,
        resume: Option<ClaudeSessionId>,
        extra_args: &[String],
    ) -> Result<Arc<Session>, SessionError> {
        let path = PathBuf::from(cwd);
        if !path.exists() {
            return Err(SessionError::CwdNotFound(cwd.to_string()));
        }
        if !path.is_dir() {
            return Err(SessionError::CwdNotDirectory(cwd.to_string()));
        }
        // 一覧のグループ化キーになるので、シンボリックリンク等を解決して絶対パスに揃える
        let project_path = path.canonicalize().unwrap_or(path);

        let card_id = CardId::new();
        let start = match resume {
            Some(session_id) => lifecycle::SessionStart::Resume(session_id),
            None => lifecycle::SessionStart::Fresh(ClaudeSessionId::new()),
        };

        // フック設定は起動より前に書き出しておく。CLI は起動時に --settings を読むので、
        // 後から書いても間に合わない
        let settings = hooks_settings::write(card_id, self.config.port, &self.hook_program)
            .map_err(|err| SessionError::Settings(format!("{err:#}")))?;
        let command = lifecycle::build_command_with_extra(
            &self.program,
            &project_path,
            start,
            &settings.path,
            extra_args,
        );

        let (chunk_tx, chunk_rx) = mpsc::channel(CHUNK_QUEUE);
        let (process, exit_rx) = PtyProcess::spawn(
            command,
            portable_pty::PtySize {
                rows: INITIAL_ROWS,
                cols: INITIAL_COLS,
                pixel_width: 0,
                pixel_height: 0,
            },
            chunk_tx,
        )
        .map_err(|err| SessionError::Spawn(format!("{err:#}")))?;

        let created_at = now_ms();
        let (output, _) = broadcast::channel(OUTPUT_QUEUE_FRAMES);
        let session = Arc::new(Session {
            card_id,
            meta: Mutex::new(SessionMeta {
                card_id,
                project: ProjectId(project_path.to_string_lossy().into_owned()),
                claude_session_id: match start {
                    // 自己採番なら起動した瞬間から対応が確定している
                    lifecycle::SessionStart::Fresh(id) => Some(id),
                    // 引き継ぎでは CLI 側が決めるので、最初のフックが届くまで空
                    lifecycle::SessionStart::Resume(_) => None,
                },
                // SessionStart フックが届くまでは「起動した」以上のことが分からない。
                // 設計§5 の定義どおり Starting から始める
                status: SessionStatus::Starting,
                subagent_active: 0,
                last_activity_at: created_at,
                last_assistant_message: None,
                created_at,
                hooks_seen: false,
            }),
            process,
            ring: Mutex::new(RingBuffer::new(self.config.pty_ring_buffer)),
            output,
            pause_requests: Mutex::new(HashSet::new()),
            settings,
            transcript_path: Mutex::new(None),
            transcript: Mutex::new(TranscriptWindow::new(self.config.transcript_window_nodes)),
            transcript_tx: broadcast::channel(TRANSCRIPT_QUEUE_MESSAGES).0,
            expected_exit: AtomicBool::new(false),
            saw_output: AtomicBool::new(false),
        });

        self.tokens
            .lock()
            .expect("ロックが壊れていない")
            .insert(session.token().to_string(), card_id);
        self.sessions
            .lock()
            .expect("ロックが壊れていない")
            .insert(card_id, Arc::clone(&session));

        tokio::spawn(coalesce_loop(
            Arc::clone(&session),
            chunk_rx,
            Duration::from_millis(self.config.coalesce_ms),
        ));

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            if let Ok(exit) = exit_rx.await {
                manager.on_exit(card_id, exit);
            }
        });

        self.broadcast_meta(&session);
        Ok(session)
    }

    /// セッションを終了させる。カードは Ended 表示で残る（設計§6）。
    pub fn kill(&self, card_id: CardId) -> Result<(), SessionError> {
        let session = self.get(card_id).ok_or(SessionError::NotFound(card_id))?;
        session.kill();
        Ok(())
    }

    /// カードを一覧から消す。生きていれば先に終了させる。
    pub fn archive(&self, card_id: CardId) -> Result<(), SessionError> {
        let session = self
            .sessions
            .lock()
            .expect("ロックが壊れていない")
            .remove(&card_id)
            .ok_or(SessionError::NotFound(card_id))?;

        self.tokens
            .lock()
            .expect("ロックが壊れていない")
            .remove(session.token());

        // 先に止めないと、読み取りスレッド → 合流タスクが Arc を握ったままになり
        // セッションが解放されない（合流タスクは待ち行列が閉じたときに終わる）
        session.kill();
        hooks_settings::cleanup(&session.settings);
        if let Some(parser) = self.parser.lock().expect("ロックが壊れていない").as_ref() {
            parser.unwatch(card_id);
        }
        let _ = self.events.send(ServerMessage::SessionRemoved { card_id });
        Ok(())
    }

    /// 合言葉からカードを引く（[`crate::hooks`] の受信口が使う）。
    pub fn resolve_token(&self, token: &str) -> Option<Arc<Session>> {
        let card_id = *self
            .tokens
            .lock()
            .expect("ロックが壊れていない")
            .get(token)?;
        self.get(card_id)
    }

    /// フック1件を適用し、変わった分だけを配信する。
    ///
    /// 差分（`status`）で足りるか、カード全体（`session_upsert`）を送り直すかは
    /// [`crate::state::apply`] の戻り値で決まる。フックはツールコールのたびに飛んで
    /// くるので、毎回カード全体を送ると無駄が大きい。
    pub fn handle_hook(&self, session: &Arc<Session>, input: &HookInput) {
        // SessionEnd を受けたら「自分で終了した」ことが分かる。この後に PTY の終了が
        // 届いても異常終了として上書きしないための印でもある
        if input.event == state::HookEvent::SessionEnd {
            session.expected_exit.store(true, Ordering::SeqCst);
        }
        let (changed, new_transcript) = session.apply_hook(input);
        // JSONL の場所が分かった／変わった時点でパーサへ監視を頼む。resume で別ファイルに
        // なった場合も同じ経路で張り替わる（設計§6）
        if let Some(path) = new_transcript {
            match self.parser.lock().expect("ロックが壊れていない").as_ref() {
                Some(parser) => {
                    tracing::info!(
                        card_id = %session.card_id,
                        %path,
                        "パーサへ履歴の監視を頼みました"
                    );
                    parser.watch(session.card_id, path);
                }
                // ここを黙って落とすと、構造化ビューだけが永久に空のまま残る。
                // 一覧もターミナルも動くので、利用者からは原因が見えない
                None => tracing::warn!(
                    card_id = %session.card_id,
                    %path,
                    "パーサが繋がっていないため履歴の監視を頼めません"
                ),
            }
        }
        self.publish(session, changed);
    }

    /// パーサへの口を差し込む。
    ///
    /// 起動順の都合で、SessionManager を作ってからパーサを立ち上げるため後から渡す。
    pub fn attach_parser(&self, handle: crate::parser::ParserHandle) {
        *self.parser.lock().expect("ロックが壊れていない") = Some(handle);
    }

    /// 一覧を見ている全クライアントへ流す（カード単位でない通知に使う）。
    pub fn broadcast(&self, message: ServerMessage) {
        let _ = self.events.send(message);
    }

    fn publish(&self, session: &Arc<Session>, changed: Changed) {
        if changed.meta {
            self.broadcast_meta(session);
        } else if changed.status {
            let (status, subagent_active, last_activity_at) = session.status_snapshot();
            let _ = self.events.send(ServerMessage::Status {
                card_id: session.card_id,
                status,
                subagent_active,
                last_activity_at,
            });
        }
    }

    /// 見張りを始める（設計§5 の停滞タイマーと設計§11 のフック未受信）。
    ///
    /// セッションごとにタイマーを持たせるとフックが届くたびに張り直すことになるので、
    /// 全体を一定間隔で見て回る方式にしている。どちらの判定も「一定時間なにも起きて
    /// いないこと」を根拠にするので、見て回る場所を1つにまとめている。
    pub fn start_sweeper(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(STALLED_SWEEP_INTERVAL);
            loop {
                ticker.tick().await;
                manager.sweep_once();
            }
        })
    }

    /// 見張りの1周分。テストから直接呼べるように分けてある。
    pub fn sweep_once(&self) {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .cloned()
            .collect();
        for session in sessions {
            if session.sweep(self.config.stalled_threshold_secs) {
                self.publish(
                    &session,
                    Changed {
                        status: true,
                        meta: false,
                    },
                );
            }
        }
    }

    fn on_exit(&self, card_id: CardId, exit: PtyExit) {
        let Some(session) = self.get(card_id) else {
            return;
        };
        {
            let mut meta = session.meta.lock().expect("ロックが壊れていない");
            // SessionEnd フックで既に終了扱いになっているなら、そちらの判定を尊重する
            if matches!(meta.status, SessionStatus::Ended { .. }) {
                return;
            }
            // ダッシュボードから終了させた場合、強制終了なので終了コードは非ゼロになる。
            // それを異常終了として出すと、利用者が自分で終わらせたのに落ちたように見える
            let ok = exit.ok || session.expected_exit.load(Ordering::SeqCst);
            meta.status = SessionStatus::Ended { ok };
            meta.last_activity_at = now_ms();
        }
        self.broadcast_meta(&session);
    }

    fn broadcast_meta(&self, session: &Session) {
        let _ = self.events.send(ServerMessage::SessionUpsert {
            session: session.meta(),
        });
    }
}

/// PTY の細切れチャンクを時間窓でまとめて、まとまるたびに `sink` へ渡す（設計§10）。
///
/// CLI は1文字ずつ書くこともあるので、そのまま WebSocket フレームにすると数が爆発して
/// ブラウザ側の処理が追いつかなくなる。`window` の間に届いたものを1つにまとめてから送る。
///
/// セッションから切り離してあるのは、時間窓の挙動を PTY 無しで検証できるようにするため。
pub async fn coalesce_stream<F>(mut chunks: mpsc::Receiver<Vec<u8>>, window: Duration, mut sink: F)
where
    F: FnMut(&[u8]),
{
    loop {
        // 窓を開くのは最初のチャンクが来てから。何も来ていないのに待つと遅延が増えるだけ
        let Some(first) = chunks.recv().await else {
            break;
        };
        let mut merged = first;
        let deadline = tokio::time::Instant::now() + window;
        let mut input_closed = false;

        while merged.len() < MAX_COALESCED_FRAME {
            match tokio::time::timeout_at(deadline, chunks.recv()).await {
                Ok(Some(chunk)) => merged.extend_from_slice(&chunk),
                Ok(None) => {
                    input_closed = true;
                    break;
                }
                // 窓が閉じた
                Err(_) => break,
            }
        }

        sink(&merged);
        if input_closed {
            break;
        }
    }
}

async fn coalesce_loop(session: Arc<Session>, chunks: mpsc::Receiver<Vec<u8>>, window: Duration) {
    coalesce_stream(chunks, window, |merged| session.publish_output(merged)).await;
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn リングバッファは容量を超えたら古いバイトから捨てる() {
        let mut ring = RingBuffer::new(8);
        ring.push(b"12345");
        assert_eq!(ring.snapshot(), b"12345");

        ring.push(b"6789");
        assert_eq!(ring.len(), 8);
        assert_eq!(ring.snapshot(), b"23456789", "先頭の 1 が押し出される");
    }

    #[test]
    fn 容量より大きい書き込みは末尾だけが残る() {
        let mut ring = RingBuffer::new(4);
        ring.push(b"abcdefghij");
        assert_eq!(ring.snapshot(), b"ghij");
        assert_eq!(ring.len(), 4);
    }

    #[test]
    fn 空のリングバッファのスナップショットは空になる() {
        let ring = RingBuffer::new(16);
        assert!(ring.is_empty());
        assert!(ring.snapshot().is_empty());
    }

    /// 合流結果を順番に集めながら [`coalesce_stream`] を回す。
    async fn collect_merged(
        window: Duration,
        feed: impl FnOnce(mpsc::Sender<Vec<u8>>) -> tokio::task::JoinHandle<()>,
    ) -> Vec<Vec<u8>> {
        let (tx, rx) = mpsc::channel(16);
        let merged = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));

        let sink = Arc::clone(&merged);
        let feeder = feed(tx);
        coalesce_stream(rx, window, move |bytes| {
            sink.lock()
                .expect("ロックが壊れていない")
                .push(bytes.to_vec());
        })
        .await;
        feeder.await.expect("送信側が正常に終わること");

        merged.lock().expect("ロックが壊れていない").clone()
    }

    #[tokio::test]
    async fn 窓の中に届いた細切れは1フレームにまとまる() {
        // CLI が1文字ずつ書いても、ブラウザへ送るフレームは1つで済むことの確認
        let merged = collect_merged(Duration::from_millis(50), |tx| {
            tokio::spawn(async move {
                for part in [b"a".as_slice(), b"b", b"c", b"d", b"e"] {
                    tx.send(part.to_vec()).await.expect("送信できること");
                }
            })
        })
        .await;

        assert_eq!(
            merged,
            vec![b"abcde".to_vec()],
            "5チャンクが1フレームになる"
        );
    }

    #[tokio::test]
    async fn 窓を越えて届いたものは別フレームになる() {
        let window = Duration::from_millis(20);
        let merged = collect_merged(window, |tx| {
            tokio::spawn(async move {
                tx.send(b"first".to_vec()).await.expect("送信できること");
                // 窓が閉じるのを十分に待ってから次を送る
                tokio::time::sleep(window * 5).await;
                tx.send(b"second".to_vec()).await.expect("送信できること");
            })
        })
        .await;

        assert_eq!(merged, vec![b"first".to_vec(), b"second".to_vec()]);
    }
}
