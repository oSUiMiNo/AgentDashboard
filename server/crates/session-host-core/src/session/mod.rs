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

pub mod account_toml;
pub mod cwd;
pub mod hooks_settings;
pub mod input;
pub mod lifecycle;
pub mod model;
pub mod permission;
pub mod pty;
pub mod screen;

use crate::{
    config::SessionHostConfig,
    events::{EventSink, LocalEventBus, TranscriptReport},
    state::{self, Changed, HookInput},
};
use bytes::Bytes;
use hooks_settings::HookSettings;
use protocol::{
    CardId, ClaudeSessionId, ModelId, PermissionMode, ProjectId, SessionMeta, SessionStatus,
    Timestamp,
    frame::{self, FrameKind},
    ipc::ParsedNode,
    ws::ServerMessage,
};
use pty::{PtyExit, PtyProcess};
use std::path::Path;
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

/// フッタを探すときに読むスクロールバックの末尾の長さ（バイト）。
///
/// フッタは画面が更新されるたびに書き直されるので、末尾さえ見れば足りる。全体
/// （既定 1MiB）を毎秒コピーすると、セッション数だけ無駄が積み上がる。
const FOOTER_TAIL: usize = 32 * 1024;

/// フック未受信の1行に載せる端末の末尾の長さ（文字）。
///
/// フォルダ信頼の確認は「このフォルダのファイルを信頼しますか」＋パス＋選択肢で、
/// 畳んだあと200文字前後。倍の余裕を取る。
const HOOK_SILENCE_TAIL_CHARS: usize = 400;

/// Shift+Tab（backtab）。TUI の権限モードを1つ進める。
const CYCLE_KEY: &[u8] = b"\x1b[Z";

/// 見張り1周ぶんで、セッションの外から渡す材料（設計§8-4）。
///
/// `hook_port` と `hook_bin` を持っているのは [`SessionManager`] だけ。**フック未受信を
/// 知らせる1行に、注入した設定と宛先を並べるため**にここへ通す。
pub(crate) struct SweepInput<'a> {
    pub threshold_secs: u64,
    pub hook_port: u16,
    pub hook_bin: &'a Path,
}

/// 端末の末尾を、ログの1行へ載せられる形にする（設計§8-4）。
///
/// # `squeeze` は通さない
///
/// [`permission::squeeze`] は空白を**全部**落とす照合専用の道具で、通すと
/// `Dtrtstthfilsinthisflder` のような人が読めない塊になる。ここは読む側に判断させる
/// ための材料なので、**制御列だけ落として空白は畳む**。
///
/// # それでも語がくっついて見えることがある
///
/// TUI は語ごとに別々に書き、間をカーソル移動で埋める。制御列を落としても
/// `trust this folder` が `trustthisfolder` になることがある（自己修復で実測済み）。
/// **これは壊れているのではない。** あとから「空白が無いから」と `squeeze` を足さないこと。
fn tail_for_log(raw: &str) -> String {
    let stripped = permission::strip_ansi(raw);
    let mut folded = String::with_capacity(stripped.len());
    let mut in_space = false;
    for ch in stripped.chars() {
        if ch.is_whitespace() {
            if !in_space {
                folded.push(' ');
                in_space = true;
            }
        } else {
            folded.push(ch);
            in_space = false;
        }
    }
    let folded = folded.trim();
    let count = folded.chars().count();
    if count <= HOOK_SILENCE_TAIL_CHARS {
        return folded.to_string();
    }
    // **文字数で切る。** バイトで切ると日本語の途中で割れる（`--since` で踏んだ罠）
    let skip = count - HOOK_SILENCE_TAIL_CHARS;
    format!("…{}", folded.chars().skip(skip).collect::<String>())
}

/// 切替で Shift+Tab を押す上限。
///
/// 実測した巡回は最大4モード（bypassPermissions 起動時。設計§11）なので、一巡して
/// 戻ったことは押す回数より前に検知できる。上限は暴走を止めるための最後の歯止め。
const CYCLE_LIMIT: usize = 8;

/// 1回押したあと、フッタが書き変わるのを待つ上限。
///
/// 本物の TUI は再描画が遅れることがある。短く切ると「押しても変わらない」と
/// 誤って判定する。
const CYCLE_SETTLE: Duration = Duration::from_millis(3_000);
const CYCLE_STEP: Duration = Duration::from_millis(100);

/// 楽観更新を取り消すまでの上限（設計§5）。
///
/// `statusLine` が走る契機に**モデル変更は入っていない**（設計§11 の実測）ので、
/// 確定値は `refreshInterval`（既定3秒）の次の周期で届く。それを何度か待てる長さにする。
///
/// ここで諦めるのは、CLI が切替を拒否した場合（組織の制限など）に**楽観更新が
/// 上書きされずに残り続けて嘘になる**のを防ぐため。
const MODEL_SETTLE: Duration = Duration::from_secs(15);
const MODEL_STEP: Duration = Duration::from_millis(200);

/// 切替の確認画面が出るのを待つ上限（設計§11）。
///
/// 会話が進んでいるときだけ出る。出ないほうが普通なので、短く切って先へ進む。
const MODEL_CONFIRM_WAIT: Duration = Duration::from_secs(4);

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

/// 権限モードの切替に失敗した理由（設計§6）。
///
/// **黙って諦めない**ための型。「押したのに変わらない、理由も分からない」が一番困るので、
/// 何が起きたのかをそのまま画面へ出せる文にする。
#[derive(Debug, thiserror::Error)]
pub enum SwitchError {
    #[error("いまのモードを読み取れませんでした。ターミナルの表示を確認してください")]
    Unreadable,
    #[error(
        "このセッションでは {0} へ切り替えられません。\
        Shift+Tab の巡回に入らないモードです（確認しないモードは起動時にしか選べず、\
        全承認をスキップは起動時に選んだセッションでだけ切り替えられます）"
    )]
    Unreachable(String),
    #[error(
        "モードを切り替えるキーを送りましたが、画面が変わりませんでした。\
        メニューや確認が出ていないか、ターミナルビューで確かめてください"
    )]
    NoResponse,
    #[error("端末へ書き込めませんでした: {0}")]
    Write(String),
}

/// モデルの切替に失敗した理由（設計§5）。
///
/// 権限モードと別の型にしているのは、**起こりうる失敗が違う**ため。モデルは巡回では
/// なく `/model` の一撃で切り替わるので「到達できない」が無く、代わりに
/// 「送ったが CLI が名乗り直さない」（組織の制限で拒否された等）がある。
#[derive(Debug, thiserror::Error)]
pub enum ModelSwitchError {
    #[error(
        "いま画面に何が出ているか読み取れないので、モデルの切替を送りませんでした。\
        メニューや確認が出ていないか、ターミナルビューで確かめてください"
    )]
    Unreadable,
    /// 切替先として受け取れない値だった。**端末へは何も送っていない**
    #[error("モデルの切替先として受け取れませんでした（{0}）。端末へは何も送っていません")]
    InvalidTarget(String),
    /// このセッションで既に切替が走っている。**待たせずにその場で断る**
    #[error("このセッションはモデルを切替中です。終わってからもう一度選んでください")]
    Busy,
    #[error("端末へ書き込めませんでした: {0}")]
    Write(String),
}

/// スクロールバック用の固定容量バッファ。
///
/// 上限を超えたら古いバイトから捨てる。ブラウザを開き直したときに「直前までの画面」を
/// 復元するのが目的なので、全履歴を持つ必要はない。
#[derive(Debug)]
pub struct RingBuffer {
    buffer: VecDeque<u8>,
    capacity: usize,
    /// これまでに書き込まれた累計バイト数。**捨てた分も数え続ける**。
    ///
    /// [`RingBuffer::len`] は容量で頭打ちになるので、位置の目印には使えない。
    /// 「この時点より後に届いたものだけを見る」を成り立たせるために持つ。
    written: u64,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buffer: VecDeque::new(),
            capacity,
            written: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        // 捨てるかどうかに関わらず「届いた」ことは数える。先に足しておかないと、
        // 容量を超える1回の書き込みで数え落とす
        self.written += data.len() as u64;

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

    /// 末尾の `limit` バイトだけを取り出す。
    ///
    /// フッタを探すだけなら全体を複製する必要が無い。見張りは1秒ごとに全セッションを
    /// 見て回るので、ここで 1MiB を複製すると本数だけ無駄が積み上がる。
    pub fn tail(&self, limit: usize) -> Vec<u8> {
        let skip = self.buffer.len().saturating_sub(limit);
        self.buffer.iter().skip(skip).copied().collect()
    }

    /// いままでに届いた累計バイト数。位置の目印として控えるための値。
    pub fn written(&self) -> u64 {
        self.written
    }

    /// `mark` より後に届いたぶんだけを、多くても `limit` バイト取り出す。
    ///
    /// 目印より後の一部が既に捨てられている場合は、残っているものが全部返る
    /// （残っているバイトはすべて目印より後なので、それで正しい）。
    pub fn since(&self, mark: u64, limit: usize) -> Vec<u8> {
        let fresh = self.written.saturating_sub(mark);
        self.tail(fresh.min(limit as u64) as usize)
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
    ///
    /// **サーバ側へは移さない**（設計§2-2 からの読み替え）。これは PC 上のファイルの
    /// 場所で、サーバに JSONL は存在しない（§3-3）ため、向こうへ置いても使えない。
    transcript_path: Mutex<Option<String>>,
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
    /// 出力もフックも無いまま固まっていることを、もう言ったか（設計§8-4）。
    ///
    /// **主経路には要らない。** あちらは `Starting → Unknown` の遷移そのものが
    /// ラッチとして働く（2度目は `status != Starting` で偽になる）。ここが要るのは
    /// **状態を動かさない側**——出力が1バイトも無いセッションは `Starting` のままなので、
    /// 覚えておかないと毎秒言うことになる。
    hook_silence_noted: AtomicBool,
    /// いま効いていると分かっている**別名**。分からなければ `None`（設計§5）。
    ///
    /// [`SessionMeta::model`] が持つのは CLI が名乗った**フルID**で、別名とは別物である。
    /// 違う別名が同じフルIDへ落ちることがある（`opus` と `opus[1m]`）ので、
    /// 「もう目的のモデルか」をフルIDだけで判断すると、その組の間を移動できない。
    ///
    /// **`SessionMeta` には載せない。** 画面に出す必要が無く、protocol は共有境界で
    /// 変更のハードルが高い。
    ///
    /// 分からなくなったら**素直に `None` へ戻す**。分かっているふりで持つと、
    /// 送るべき切替を送らない判断に使われる。
    model_alias: Mutex<Option<ModelId>>,
    /// この端末の画面を作る相手（セルフホストモードだけ。設計§7-2）。
    ///
    /// ローカルモードでは `None`。生バイトをそのまま配れる相手（同じ PC のブラウザ）が
    /// 居るので、画面を作る理由が無い——**作ると CPU とメモリを黙って食う**だけになる。
    screen: Option<Arc<screen::TermEmulator>>,
    /// モデルの切替が走っている間だけ立つ。
    ///
    /// 切替は確認待ち（4秒）と確定待ち（15秒）を**プロセス全体のロックを持ったまま**
    /// 過ごす。印が無いと、連打したぶんだけタスクがロック待ちの行列に並び、
    /// **他のカードの切替まで全部その後ろで待つ**（5回で約76秒）。
    ///
    /// [`SessionMeta::model_requested`] を印の代わりにはしない。あれは端末へ送った
    /// **あと**に立つので、送る前の隙間を2本目が通り抜ける。
    model_switching: AtomicBool,
}

/// モデル切替が走っていることの印。落ちると印も下りる。
struct SwitchInFlight<'a> {
    session: &'a Session,
}

impl Drop for SwitchInFlight<'_> {
    fn drop(&mut self) {
        self.session.model_switching.store(false, Ordering::SeqCst);
    }
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

    /// 端末の**末尾だけ**を文字列として覗く。
    ///
    /// 権限モードのフッタを読むための口（設計§11）。フッタは画面が更新されるたびに
    /// 書き直されるので末尾に必ず現れる。1秒周期の見張りから毎回呼ばれるため、
    /// [`Session::scrollback_text`] のように全体を複製してはいけない。
    pub fn scrollback_tail(&self, limit: usize) -> String {
        let payload = self.ring.lock().expect("ロックが壊れていない").tail(limit);
        String::from_utf8_lossy(&payload).into_owned()
    }

    /// いまの位置に目印を打つ。
    ///
    /// 「ここから後に届いたものだけを見たい」ときに、先に控えておく値。
    /// [`Session::scrollback_len`] と違って**捨てた分も数え続ける**ので、
    /// 時間が経っても位置の比較に使える。
    pub fn scrollback_mark(&self) -> u64 {
        self.ring.lock().expect("ロックが壊れていない").written()
    }

    /// 目印より後に届いた出力だけを覗く。
    ///
    /// [`Session::scrollback_tail`] との違いは**過去を巻き込まないこと**。画面の残骸に
    /// 反応してキーを送る事故（モデル切替の確認ダイアログで実測）を防ぐためにある。
    pub fn scrollback_since(&self, mark: u64, limit: usize) -> String {
        let payload = self
            .ring
            .lock()
            .expect("ロックが壊れていない")
            .since(mark, limit);
        String::from_utf8_lossy(&payload).into_owned()
    }

    /// いまの権限モード（分かっていれば）。
    pub fn permission_mode(&self) -> Option<PermissionMode> {
        self.meta
            .lock()
            .expect("ロックが壊れていない")
            .permission_mode
            .clone()
    }

    /// 端末に出ている内容から、いまのモードを読む。
    fn read_footer_mode(&self) -> Option<PermissionMode> {
        permission::parse_footer(&self.scrollback_tail(FOOTER_TAIL))
    }

    /// モードを控える。変わっていれば `true`。
    fn store_permission_mode(&self, mode: PermissionMode) -> bool {
        let mut meta = self.meta.lock().expect("ロックが壊れていない");
        if meta.permission_mode.as_ref() == Some(&mode) {
            return false;
        }
        meta.permission_mode = Some(mode);
        true
    }

    /// 権限モードを目的の値へ切り替える（設計§6）。
    ///
    /// # 巡回順を決め打ちしない
    ///
    /// Shift+Tab の巡回に入るモードは起動条件とアカウントで変わり、`dontAsk` は
    /// そもそも入らない（設計§11 の実測）。そこで **1回押すごとに読んで、目的に着くまで
    /// 繰り返す**。出発点へ戻ったら一巡＝到達できないと判定して打ち切る。
    ///
    /// # 送る前に画面を確かめる
    ///
    /// 現在のモードが読めない＝フッタが出ていない（メニューや確認が出ている）ときは
    /// **送らない**。このPJTは、画面を見ずにキーを送って別の相手に届いた事故を
    /// 実測している（初期実装フェーズ3）。
    pub async fn switch_permission_mode(
        &self,
        target: &PermissionMode,
    ) -> Result<PermissionMode, SwitchError> {
        let start = self.read_footer_mode().ok_or(SwitchError::Unreadable)?;
        if &start == target {
            self.store_permission_mode(start.clone());
            return Ok(start);
        }

        // 1回押すごとに「押す前」と比べる。**押した結果が描かれる前に次を押してはいけない** —
        // 飛び越して目的地を通り過ぎる
        let mut previous = start.clone();
        for _ in 0..CYCLE_LIMIT {
            self.write_input(CYCLE_KEY)
                .map_err(|err| SwitchError::Write(format!("{err:#}")))?;

            let Some(current) = self.wait_for_footer_move(&previous).await else {
                // 押しても画面が変わらない。到達できないのとは別の話（メニューが出ている、
                // 描画が極端に遅い等）なので、**そう言う**。ここで「到達できません」と
                // 返すと、実際には行けるモードを行けないと嘘をつくことになる
                return Err(SwitchError::NoResponse);
            };
            self.store_permission_mode(current.clone());

            if &current == target {
                return Ok(current);
            }
            if current == start {
                // 一巡して戻ってきた。これ以上押しても同じところを回るだけ
                return Err(SwitchError::Unreachable(target.to_string()));
            }
            previous = current;
        }

        Err(SwitchError::Unreachable(target.to_string()))
    }

    /// モデルの切替を要求する（設計§5 の手順1〜4）。
    ///
    /// 戻り値は「どの位置で送ったか」。`None` は**もう目的のモデルだった**という意味で、
    /// 失敗ではない。返した目印は [`Session::settle_model_switch`] へそのまま渡す。
    ///
    /// # 送る前に値を確かめる
    ///
    /// 切替先はそのまま `/model <値>` として端末へ貼られる。改行が混ざっていると
    /// **末尾の確定で全体が1つのプロンプトになる**ので、送る前に弾く（[`model::target_problem`]）。
    /// 画面の判定より先に見るのは、理由が入れ替わらないようにするため。
    ///
    /// # 送る前に画面を確かめる
    ///
    /// 権限モードと同じ原則（設計§5）。フッタが読めない＝メニューや確認が出ている
    /// 状態でキーを送ると、別の相手に吸われる。このPJTは同じ事故を2回実測している。
    /// モデルの取得に端末を読まなくなっても、**送ってよい画面かの判断には端末を読む**。
    ///
    /// # 送ったら楽観更新を立てる
    ///
    /// 確定値が届くのは次の `refreshInterval` の周期なので、その間ずっと古い値を
    /// 出すと「押したのに反応しない」ように見える。要求値を別フィールドに立てて
    /// 手応えを返す。確定と混ざらないよう、入れ物は分けてある。
    pub async fn request_model(
        &self,
        target: &ModelId,
        resolved: Option<&ModelId>,
    ) -> Result<Option<u64>, ModelSwitchError> {
        if let Some(problem) = model::target_problem(target) {
            return Err(ModelSwitchError::InvalidTarget(problem));
        }
        if self.read_footer_mode().is_none() {
            return Err(ModelSwitchError::Unreadable);
        }

        let current = self.meta().model;
        if model::is_already_current(
            target,
            self.model_alias().as_ref(),
            resolved,
            current.as_ref(),
        ) {
            return Ok(None);
        }

        // **書く直前に目印を打つ。** これより後に届いたものだけが「この切替への反応」で、
        // 前回の切替で出た確認ダイアログの残骸は目印より前に落ちる
        let mark = self.scrollback_mark();
        self.send_instruction(&model::switch_command(target))
            .await
            .map_err(|err| ModelSwitchError::Write(format!("{err:#}")))?;
        self.store_model_requested(Some(target.clone()));
        Ok(Some(mark))
    }

    /// 送ったあとの後始末（設計§5 の手順6）。
    ///
    /// 1. 確認画面が出ていたら答える（会話が進んでいるときだけ出る。設計§11）
    /// 2. `statusLine` からの確定を待つ
    /// 3. 待っても来なければ**楽観更新を取り消す**
    ///
    /// 戻り値は「確定したか」。取り消した場合は `false` で、画面は確定値（多くは
    /// 切替前のモデル）に戻る。CLI が拒否したのに切り替わったように見せ続けるより、
    /// 元に戻って「変わらなかった」と分かるほうがよい。
    ///
    /// `since` は [`Session::request_model`] が返した目印。確認画面を探す範囲を
    /// **送ったあとに届いたぶんへ限る**ために要る。
    pub async fn settle_model_switch(&self, since: u64) -> bool {
        self.answer_switch_confirmation(since).await;

        let deadline = tokio::time::Instant::now() + MODEL_SETTLE;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(MODEL_STEP).await;
            // 確定は受信口（[`crate::model_post`] の受け側）が消す。ここは消えたことを見るだけ
            if self.meta().model_requested.is_none() {
                return true;
            }
        }

        tracing::warn!(
            card_id = %self.card_id,
            "モデルの切替を送りましたが、CLI が名乗り直しませんでした。切替前の表示へ戻します"
        );
        self.store_model_requested(None);
        // 効いたのか拒否されたのか分からない。**分かっているふりで持たない**
        self.store_model_alias(None);
        false
    }

    /// 会話が進んだ状態で出る「Switch model?」に答える（設計§11）。
    ///
    /// **画面を読んでから送る。** 既定のカーソルは「はい」の側にあるが、決め打ちで
    /// Enter を送ると、確認が出ていない場合に**入力欄の中身を確定させてしまう**。
    /// 全承認スキップの確認と同じ作法にしてある（[`answer_bypass_notice`]）。
    ///
    /// # 見るのは「送ったあとに届いたぶん」だけ
    ///
    /// ダイアログは切替のたびにスクロールバックへ残る。末尾から探すと、**2回目以降の
    /// 切替で前回の残骸に一致する**。確認は出ていないので入力欄は空のままで、そこへ
    /// 送った `1` は**本物の Claude への指示として確定される**（ターンを1回消費し、
    /// 履歴も汚れる）。目印より後だけを見れば、この経路が塞がる。
    ///
    /// 確認が出ないほうが普通なので、待たずに帰るのが既定の道筋。
    async fn answer_switch_confirmation(&self, since: u64) {
        let deadline = tokio::time::Instant::now() + MODEL_CONFIRM_WAIT;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(MODEL_STEP).await;

            let screen = self.scrollback_since(since, FOOTER_TAIL);
            if !model::looks_like_confirmation(&screen) {
                continue;
            }
            match permission::accept_option_key(&screen) {
                Some(key) => {
                    tracing::info!(
                        card_id = %self.card_id,
                        "モデル切替の確認に答えます（選択肢 {key}）"
                    );
                    self.send_key(key.to_string().as_bytes(), "モデル切替の選択肢");
                    tokio::time::sleep(INSTRUCTION_SETTLE).await;
                    self.send_key(b"\r", "モデル切替の確定");
                }
                // 読めないなら何も送らない。利用者がターミナルビューから答えられる
                None => tracing::warn!(
                    card_id = %self.card_id,
                    "モデル切替の確認が出ていますが、受け入れる選択肢を読み取れませんでした。\
                    ターミナルビューから答えてください"
                ),
            }
            return;
        }
    }

    /// CLI が名乗ったモデルを控える。変わったときだけ `true`。
    ///
    /// **ここが「正」の入り口**（設計§1）。`statusLine` から届いた値だけがここを通る。
    /// 値が動いたら楽観更新は役目を終えるので、同時に落とす。
    pub fn store_model(&self, id: ModelId, label: Option<String>) -> bool {
        let mut meta = self.meta.lock().expect("ロックが壊れていない");
        let same = meta.model.as_ref() == Some(&id) && meta.model_label == label;
        if same {
            // 値が動いていないなら、楽観更新も残したままにする。ここで落とすと
            // 「切替を送った直後の同じ値の通知」で手応えが消える
            return false;
        }
        meta.model = Some(id);
        meta.model_label = label;
        meta.model_requested = None;
        true
    }

    /// 切替の要求値を立てる／落とす。
    fn store_model_requested(&self, requested: Option<ModelId>) {
        self.meta
            .lock()
            .expect("ロックが壊れていない")
            .model_requested = requested;
    }

    /// いま効いていると分かっている別名。
    pub fn model_alias(&self) -> Option<ModelId> {
        self.model_alias
            .lock()
            .expect("ロックが壊れていない")
            .clone()
    }

    /// 効いている別名を控える／忘れる。
    pub fn store_model_alias(&self, alias: Option<ModelId>) {
        *self.model_alias.lock().expect("ロックが壊れていない") = alias;
    }

    /// モデル切替の権利を1つだけ取る。**既に走っていれば `None`**。
    ///
    /// 取れた側だけが先へ進み、取れなかった側はその場で断られる。ここで断らずに
    /// プロセス全体のロックを待たせると、待っている本数だけ**他のカードの切替も
    /// 後ろへずれる**（設計§6 のロックはプロセスに1本しかない）。
    ///
    /// 返すガードを落とすと印も下りる。途中で早期 return しても取り残されない。
    fn begin_model_switch(&self) -> Option<SwitchInFlight<'_>> {
        self.model_switching
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| SwitchInFlight { session: self })
    }

    /// 1回押したあと、フッタの表示が落ち着くまで待って読む。
    ///
    /// 描画の途中で読むと、書き換わる前の古いフッタを掴む。初期実装フェーズ5で
    /// 「描画中に流し込んだ指示が静かに消える」事故を実測しているのと同じ性質の話。
    /// 押す前のモードから**動いた**ことを確かめてから読む。
    ///
    /// 動かないまま時間切れになったら `None`。ここで「いまの値」を返してしまうと、
    /// 描画が遅れただけの場合に呼び出し側が「出発点へ戻った＝一巡した」と誤読し、
    /// **本当は行けるモードを行けないと報告する**。
    async fn wait_for_footer_move(&self, previous: &PermissionMode) -> Option<PermissionMode> {
        let deadline = tokio::time::Instant::now() + CYCLE_SETTLE;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(CYCLE_STEP).await;
            if let Some(current) = self.read_footer_mode()
                && &current != previous
            {
                return Some(current);
            }
        }
        None
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

    /// 端末へキーを送り、**送れなかったことだけ**を残す（設計§10-3）。
    ///
    /// 戻り値を返さないのは、元の判断（送れなくても続ける）を変えないため。直前に
    /// 「答えます」と `info` を出しておきながら送出が無音だと、**ログ上は「答えたのに
    /// 効かない」としか読めない**。
    ///
    /// # `write_input` の中に置いてはいけない
    ///
    /// あそこはブラウザの1打鍵（`crate::link`）も通る熱い経路（設計§9-1）で、しかも
    /// **何をしようとしたかが失われる**——あそこからは「`0x1b[B` を送ろうとした」
    /// としか言えない。
    ///
    /// # `what` は欄に置く
    ///
    /// 本文へ埋めると先頭24文字が変わり、間引き（設計§6-3）の鍵が散る。
    pub fn send_key(&self, bytes: &[u8], what: &str) {
        if let Err(err) = self.write_input(bytes) {
            tracing::warn!(
                card_id = %self.card_id,
                what,
                err = %format!("{err:#}"),
                "端末へキーを送れません"
            );
        }
    }

    pub fn write_input(&self, bytes: &[u8]) -> anyhow::Result<()> {
        // 何か打った直後は画面が動く。ここでホットウィンドウを開ける（設計§7-5）。
        // ブラウザのキー入力（0x02）も Composer の指示送信も、必ずここを通る
        if let Some(screen) = &self.screen {
            screen.note_input();
        }
        self.process.write_input(bytes)
    }

    /// この端末の画面を作っている相手（セルフホストモードだけ居る。設計§7-2）。
    pub fn screen(&self) -> Option<&Arc<screen::TermEmulator>> {
        self.screen.as_ref()
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
        // PTY とエミュレータは同じ大きさでなければならない（設計§7-4）。片方だけ
        // 変えると、CLI が描いた位置と画面の桁がずれる
        if let Some(screen) = &self.screen
            && screen.resize(cols, rows)
        {
            // 大きさが変わったら画面を作り直して送る。差分では追いつけない
            screen.refresh();
        }
        self.process.resize(cols, rows)
    }

    /// 遡れる行数を変える（設計§13-3）。作り直しになるので、手元の生バイトから復元する。
    pub fn set_scrollback_lines(&self, lines: usize) {
        let Some(screen) = &self.screen else {
            return;
        };
        if screen.scrollback_lines() == lines {
            return;
        }
        let seed = self.ring.lock().expect("ロックが壊れていない").snapshot();
        screen.rebuild(lines, &seed);
        screen.refresh();
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

    /// このセッションへ注入した設定ファイルの**実際の**パス。
    ///
    /// フックが1件も来ないときの材料（設計§8-4）。形を写すのではなく、
    /// **いま注入されているファイルそのもの**を出す——「読まれていない」を
    /// 確かめる材料になるのは実物だけである。
    pub fn settings_path(&self) -> &Path {
        &self.settings.path
    }

    /// SessionStart フックが知らせてきた JSONL の場所（フェーズ3で使う）。
    pub fn transcript_path(&self) -> Option<String> {
        self.transcript_path
            .lock()
            .expect("ロックが壊れていない")
            .clone()
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

    /// 見張りの1周ぶんをこのセッションに適用する（停滞・フック未受信・権限モード）。
    ///
    /// 権限モードの読み取りをここへ相乗りさせているのは、**フックだけでは追従できない**
    /// ため（設計§11）。`SessionStart` は `permission_mode` を運ばず、Shift+Tab では
    /// フックが1件も発火しない。つまり起動直後と、利用者がターミナルで切り替えた直後は、
    /// 端末のフッタを読む以外に知る手段が無い。
    ///
    /// 戻り値は「状態の差分を配信すべきか」。モードは差分メッセージ（`status`）に
    /// 載らないので、変わったときはカード全体を送り直す必要がある（[`Changed::meta`]）。
    fn sweep(&self, input: &SweepInput<'_>) -> Changed {
        let mode_changed = match self.read_footer_mode() {
            Some(mode) => self.store_permission_mode(mode),
            None => false,
        };

        let saw_output = self.saw_output.load(Ordering::Relaxed);
        let now = now_ms();

        // **判定だけをロックの中で終わらせる。** 材料集め（端末の末尾は `ring` の
        // ロックを取る）を中でやると、毎フレーム `ring` を握る出力の配信と、一覧を
        // 読む側が、32 KiB の複製ぶんだけ待たされる。
        //
        // `ring` → 離す → `meta` の順は既存の並びで、**ここだけ逆順を持たせない**。
        let (stalled, silent, quiet, created_at) = {
            let mut meta = self.meta.lock().expect("ロックが壊れていない");
            let stalled = state::sweep_stalled(&mut meta, now, input.threshold_secs);
            let silent =
                state::sweep_hook_silence(&mut meta, now, input.threshold_secs, saw_output);
            let quiet =
                state::hook_silent_without_output(&meta, now, input.threshold_secs, saw_output);
            (stalled, silent, quiet, meta.created_at)
        };

        if silent {
            // `Starting → Unknown` の遷移そのものがラッチ。ここへ来るのは1本につき1回だけ
            self.report_hook_silence(input, now, created_at, true);
        } else if quiet && !self.hook_silence_noted.swap(true, Ordering::Relaxed) {
            self.report_hook_silence(input, now, created_at, false);
        }

        Changed {
            status: stalled || silent,
            meta: mode_changed,
        }
    }

    /// フックが1件も来ないことを、**材料を並べて**1行にする（設計§8-4）。
    ///
    /// **原因を1つに決め打ちしない。** 積み残し_運用 項目2 では推測を決め打ちして
    /// 外している（実際の原因はフォルダ信頼の確認待ちだった）。読む側に判断させる。
    fn report_hook_silence(
        &self,
        input: &SweepInput<'_>,
        now: Timestamp,
        created_at: Timestamp,
        saw_output: bool,
    ) {
        let settings = self.settings_path();
        let elapsed_secs = now.saturating_sub(created_at) / 1000;
        // 宛先は**合言葉を含まない形**（設計§9-3。入館証は伏せるのではなく載せない）
        let hook_url = hooks_settings::hook_url_shape(input.hook_port);

        if saw_output {
            tracing::warn!(
                card_id = %self.card_id,
                settings = %settings.display(),
                settings_exists = settings.is_file(),
                hook_bin = %input.hook_bin.display(),
                hook_url = %hook_url,
                elapsed_secs,
                tail = %tail_for_log(&self.scrollback_tail(FOOTER_TAIL)),
                "CLI は動いているのにフックが1件も届いていません（材料を並べます）"
            );
        } else {
            tracing::debug!(
                card_id = %self.card_id,
                settings = %settings.display(),
                settings_exists = settings.is_file(),
                hook_bin = %input.hook_bin.display(),
                hook_url = %hook_url,
                elapsed_secs,
                "フックも端末への出力も1バイトもありません（まだ起動していない疑い）"
            );
        }
    }

    /// 差分配信用の値をまとめて取り出す。
    fn status_snapshot(&self) -> (SessionStatus, u32, Timestamp) {
        let meta = self.meta.lock().expect("ロックが壊れていない");
        (meta.status, meta.subagent_active, meta.last_activity_at)
    }
}

/// 全セッションの管理者。
pub struct SessionManager {
    config: Arc<SessionHostConfig>,
    program: String,
    /// フックが起動する実行ファイル。既定は自分自身（設計§7）。
    hook_program: PathBuf,
    sessions: Mutex<HashMap<CardId, Arc<Session>>>,
    /// フックの合言葉 → どのカードのものか。
    ///
    /// 受信URLにカードIDをそのまま載せない理由は、推測できる値だと外から状態を
    /// 書き換えられてしまうため。合言葉はセッションごとのランダム値にする。
    tokens: Mutex<HashMap<String, CardId>>,
    /// 上へ報告する口（セルフホスト化設計§2-3）。
    ///
    /// ローカルモードはプロセス内の配信そのもの、セルフホストモードでは A2S 越しの
    /// 実装に差し替わる。**流し先をここに焼き付けない**ためにトレイトで持つ。
    events: Arc<dyn EventSink>,
    /// パーサへ監視を頼む口。パーサが立ち上がってから差し込まれる。
    ///
    /// 逆参照（パーサ → SessionManager）はここには持たせない。フックの処理を止めない
    /// ために、送信は待たない `try_send` にしてある（[`crate::parser::ParserHandle`]）。
    parser: Mutex<Option<crate::parser::ParserHandle>>,
    /// 利用者のグローバル既定を守る役（設計§6）。
    ///
    /// **セッションではなくマネージャが持つ。** 対象がプロセスに1つしかないファイルなので、
    /// セッションごとに持つと直列化の意味が無くなる。
    claude_settings: Arc<crate::claude_settings::ClaudeSettings>,
    /// 別名がこの環境で何に解決されるかの実測（設計§12）。
    aliases: Arc<crate::model_aliases::ModelAliases>,
    /// 画面配信の設定（セルフホスト化設計§13-3）。サーバから届いた値をここへ置く。
    ///
    /// **これから起こすセッションのため**に持つ。すでに動いているセッションへは
    /// [`SessionManager::set_screen_settings`] がその場で配るので、両方が要る。
    screen_settings: Mutex<screen::ScreenSettings>,
}

impl SessionManager {
    pub fn new(config: Arc<SessionHostConfig>) -> Arc<Self> {
        Self::with_program(config, lifecycle::claude_program())
    }

    /// 報告先を明示して作る（セルフホスト化設計§2-3）。
    ///
    /// ローカルモードでは、束ねる層が「DB へ書いてからブラウザへ配る」報告先を渡す。
    /// フェーズ3 では A2S へ転送する実装に変わる。**流し先をここで決めない**のが
    /// [`EventSink`] を置いた理由なので、入口も分けてある。
    pub fn with_sink(config: Arc<SessionHostConfig>, events: Arc<dyn EventSink>) -> Arc<Self> {
        let program = lifecycle::claude_program();
        let hook_program = hooks_settings::hook_program();
        let (claude_settings, aliases) = Self::user_files(&config);
        Self::with_everything(
            config,
            program,
            hook_program,
            claude_settings,
            aliases,
            events,
        )
    }

    /// 起動する CLI を明示して作る。
    pub fn with_program(config: Arc<SessionHostConfig>, program: String) -> Arc<Self> {
        Self::with_programs(config, program, hooks_settings::hook_program())
    }

    /// 起動する CLI と、フックが叩く実行ファイルの両方を明示して作る。
    ///
    /// テストから擬似 claude とビルド済みの `agentdashboard` を指すための入口。
    /// プロセスの環境変数を書き換えずに済むので、テスト同士が互いを壊さない。
    pub fn with_programs(
        config: Arc<SessionHostConfig>,
        program: String,
        hook_program: PathBuf,
    ) -> Arc<Self> {
        let (claude_settings, aliases) = Self::user_files(&config);
        Self::with_everything(
            config,
            program,
            hook_program,
            claude_settings,
            aliases,
            Arc::new(LocalEventBus::new()),
        )
    }

    /// 利用者の PC 上のファイル（グローバル既定・別名の実測）を開く。
    fn user_files(
        config: &SessionHostConfig,
    ) -> (
        Arc<crate::claude_settings::ClaudeSettings>,
        Arc<crate::model_aliases::ModelAliases>,
    ) {
        let aliases = Arc::new(crate::model_aliases::ModelAliases::load(Some(
            config.resolved_state_dir(),
        )));
        let claude_settings = Arc::new(match &config.claude_settings_path {
            Some(path) => crate::claude_settings::ClaudeSettings::new(path.clone()),
            None => crate::claude_settings::ClaudeSettings::discover(),
        });
        (claude_settings, aliases)
    }

    /// グローバル既定と別名の置き場所まで明示して作る。
    ///
    /// **テストが本物の `~/.claude/settings.json` を触らないための入口。**
    /// 既定の [`crate::claude_settings::ClaudeSettings::discover`] は利用者の本物の
    /// ファイルを指すので、テストからは必ずこちらを使って一時ファイルへ逃がす。
    /// 環境変数を書き換える方式にすると、並行して走る他のテストを巻き込む。
    pub fn with_everything(
        config: Arc<SessionHostConfig>,
        program: String,
        hook_program: PathBuf,
        claude_settings: Arc<crate::claude_settings::ClaudeSettings>,
        aliases: Arc<crate::model_aliases::ModelAliases>,
        events: Arc<dyn EventSink>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            program,
            hook_program,
            sessions: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            events,
            parser: Mutex::new(None),
            claude_settings,
            aliases,
            screen_settings: Mutex::new(screen::ScreenSettings::default()),
        })
    }

    /// 画面配信の設定を差し替える（設計§13-3）。
    ///
    /// 名乗りの応答（Hello）と設定変更（SetIntervals）の両方から呼ばれる。**動いている
    /// セッションにもその場で効かせる**——次に繋ぎ直すまで古い間隔で送り続けると、
    /// 「設定したのに変わらない」という一番分かりにくい形になる。
    pub fn set_screen_settings(&self, settings: screen::ScreenSettings) {
        *self.screen_settings.lock().expect("ロックが壊れていない") = settings;
        for session in self.sessions() {
            if let Some(screen) = session.screen() {
                screen.set_screen_ms(settings.screen_ms);
            }
            // 遡り行数は端末を作り直すことになるので、変わったときだけ
            session.set_scrollback_lines(settings.scrollback_lines);
        }
    }

    fn screen_settings(&self) -> screen::ScreenSettings {
        *self.screen_settings.lock().expect("ロックが壊れていない")
    }

    /// 画面の配信を始める（設計§7-4）。**視聴者が現れたときだけ**呼ばれる。
    pub fn subscribe_screen(&self, card_id: CardId, cols: u16, rows: u16) {
        let Some(session) = self.get(card_id) else {
            return;
        };
        // PTY の大きさも揃える。見ている端末の桁で CLI に描いてもらう
        let _ = session.resize(cols, rows);
        if let Some(screen) = session.screen() {
            screen.subscribe(cols, rows);
        }
    }

    /// 画面の配信を止める。視聴者が居なくなったときだけ呼ばれる。
    pub fn unsubscribe_screen(&self, card_id: CardId) {
        if let Some(screen) = self.get(card_id).as_ref().and_then(|s| s.screen()) {
            screen.unsubscribe();
        }
    }

    /// 画面の配信を全部止める。
    ///
    /// サーバとの接続が切れたときに呼ぶ。**誰が見ているかを知っているのはサーバ**
    /// （設計§7-4 の視聴者数）なので、切れた時点でこちらの手元にある「見られている」は
    /// 根拠を失う。繋ぎ直したらサーバが出し直す（§6-4）。
    pub fn unsubscribe_all_screens(&self) {
        for session in self.sessions() {
            if let Some(screen) = session.screen() {
                screen.unsubscribe();
            }
        }
    }

    /// 生きているセッションを全部。
    fn sessions(&self) -> Vec<Arc<Session>> {
        self.sessions
            .lock()
            .expect("ロックが壊れていない")
            .values()
            .cloned()
            .collect()
    }

    /// 起動する実行ファイル名（画面や調査で確認できるように公開する）。
    pub fn program(&self) -> &str {
        &self.program
    }

    /// フックと `statusLine` の宛先ポート（セルフホスト化設計§5-3）。
    ///
    /// セッションを起こすときに settings へ焼き込まれる値そのもの。**焼き込んだ先と
    /// 受けている場所が同じか**は分離後の要になるので、外から確かめられるようにしてある。
    pub fn hook_port(&self) -> u16 {
        self.config.hook_port
    }

    /// 利用者のグローバル既定を守る役。
    pub fn claude_settings(&self) -> &Arc<crate::claude_settings::ClaudeSettings> {
        &self.claude_settings
    }

    /// 別名の実測結果（画面の選択肢に版番号を併記するために配る）。
    pub fn aliases(&self) -> &Arc<crate::model_aliases::ModelAliases> {
        &self.aliases
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
        self.spawn_with(cwd, None, &[], None)
    }

    /// 権限モードを指定してセッションを起動する（設計§4）。
    ///
    /// `mode` が `None` なら CLI に**何も渡さない**。利用者の `permissions.defaultMode` を
    /// 尊重するという意味なので、`manual` を勝手に補ってはいけない。
    ///
    /// 指定した値は [`SessionMeta`] の**初期値**として控える。ただし本当にそのモードで
    /// 起動するとは限らない（`auto` は条件を満たさないと静かに `manual` になる。設計§11）
    /// ので、正はあくまで CLI 側にある。1秒周期の見張りがフッタを読んで実態へ訂正する。
    pub fn spawn_with_mode(
        self: &Arc<Self>,
        cwd: &str,
        mode: Option<PermissionMode>,
    ) -> Result<Arc<Session>, SessionError> {
        let args = lifecycle::permission_mode_args(mode.as_ref());
        self.spawn_with(cwd, None, &args, mode)
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
        self.spawn_with(cwd, None, extra_args, None)
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
        self.spawn_with(cwd, Some(session_id), &[], None)
    }

    fn spawn_with(
        self: &Arc<Self>,
        cwd: &str,
        resume: Option<ClaudeSessionId>,
        extra_args: &[String],
        initial_mode: Option<PermissionMode>,
    ) -> Result<Arc<Session>, SessionError> {
        // 入力は利用者が手で打つか Windows 側から貼ったものなので、区切りや先頭の
        // スラッシュが揃っていないことがある。試すべき解釈は [`cwd`] が並べる
        let path = match cwd::resolve(cwd) {
            cwd::Resolution::Found(path) => path,
            cwd::Resolution::NotDirectory(path) => {
                return Err(SessionError::CwdNotDirectory(
                    path.to_string_lossy().into_owned(),
                ));
            }
            // 何として読んだのかを添える。読み替えが効いていないのか、読み替えた先が
            // 無いのかを、利用者が画面のエラーだけで見分けられるようにする
            cwd::Resolution::NotFound { interpreted } => {
                return Err(SessionError::CwdNotFound(match interpreted {
                    Some(path) => format!("{cwd}（{} として解釈しました）", path.display()),
                    None => cwd.to_string(),
                }));
            }
        };
        // 一覧のグループ化キーになるので、シンボリックリンク等を解決して絶対パスに揃える
        let project_path = path.canonicalize().unwrap_or(path);

        let card_id = CardId::new();
        let start = match resume {
            Some(session_id) => lifecycle::SessionStart::Resume(session_id),
            None => lifecycle::SessionStart::Fresh(ClaudeSessionId::new()),
        };

        // 注入するモデルは**セッションを起こすたびに読み直す**（設計§6 の主の仕掛け）。
        // 起動時に1回だけ読むと、利用者が途中で既定を変えたときに追従できない。
        // 回復に失敗している間は読みに行かず、覚えている値を使う（汚れた値を
        // 利用者の既定として取り込まないため）
        let explicit_model = model_arg(extra_args);
        let injection = hooks_settings::ModelInjection {
            status_line: self.config.inject_status_line,
            refresh_secs: self.config.status_line_refresh_secs,
            // **呼び出し側が `--model` を明示しているなら注入しない。**
            // 起動引数と注入設定の両方でモデルを指定すると、CLI は起動しきらずに
            // 入力を受け付ける状態へ入らない（自己修復の見直しセッションで実測）。
            // 明示された指定のほうが具体的なので、そちらを立てる
            model: if explicit_model.is_some() {
                None
            } else {
                self.claude_settings.refresh_default()
            },
        };
        // その値で CLI が始まるので、**それが起動時に効いている別名**になる（設計§5）。
        // ここを埋めておくと、一度も切り替えていないセッションでも別名で判定できる
        let initial_alias = explicit_model.or_else(|| injection.model.clone());

        // フック設定は起動より前に書き出しておく。CLI は起動時に --settings を読むので、
        // 後から書いても間に合わない
        let settings = hooks_settings::write(
            card_id,
            self.config.hook_port,
            &self.hook_program,
            &injection,
        )
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
                // 起動時に指定した値は初期値でしかない（設計§11）。フックとフッタが
                // 実態へ訂正するまでの間、画面を空にしないために持つ
                permission_mode: initial_mode.clone(),
                // モデルは**起動時には分からない**（設計§4）。権限モードと違って
                // 起動引数から埋められる値が無く、注入した `statusLine` が最初の値を
                // 送ってくるまでは名乗りようがない。ここで推測で埋めてはいけない
                model: None,
                model_label: None,
                model_requested: None,
                // SessionStart フックが届くまでは「起動した」以上のことが分からない。
                // 設計§5 の定義どおり Starting から始める
                status: SessionStatus::Starting,
                subagent_active: 0,
                last_activity_at: created_at,
                last_assistant_message: None,
                created_at,
                hooks_seen: false,
                // セッションホスト（PC）側は**自分の帰属を知らない**。どの PC のものか・
                // どのアカウントのものかを決めるのはサーバの仕事（設計§5-1 の手順4）で、
                // ここで推測して埋めると2箇所が同じことを決めることになる
                agent_id: None,
                account: None,
                // 報告している時点で生きている。鮮度を判断するのは受け取る側（§6-3）で、
                // 切断は「報告が来なくなったこと」としてしか観測できない
                agent_connected: true,
                // **申告するだけ。** 帰属を決めるのはサーバなので、ここに他人の名前が
                // 書いてあっても通らない（設計§8-5）。読むのは起こす瞬間の1回だけで、
                // 途中でファイルを書き換えても走っているセッションは動かない——
                // 帰属が実行中に変わると、見えていたカードが黙って消えることになる
                toml_account: account_toml::lookup(&project_path),
            }),
            process,
            ring: Mutex::new(RingBuffer::new(self.config.pty_ring_buffer)),
            output,
            pause_requests: Mutex::new(HashSet::new()),
            settings,
            transcript_path: Mutex::new(None),
            expected_exit: AtomicBool::new(false),
            saw_output: AtomicBool::new(false),
            hook_silence_noted: AtomicBool::new(false),
            model_alias: Mutex::new(initial_alias),
            model_switching: AtomicBool::new(false),
            // 画面を作るかどうかは**報告先が決める**（設計§7-2・§22 読み替え2）
            screen: self.events.screens_enabled().then(|| {
                screen::TermEmulator::new(
                    card_id,
                    Arc::clone(&self.events),
                    INITIAL_COLS,
                    INITIAL_ROWS,
                    self.screen_settings(),
                )
            }),
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

        // 全承認をスキップで起動した初回だけ、TUI が責任の受諾を尋ねてくる。
        // 答えるまで先へ進まないので、こちらで答える（利用者の判断）。
        //
        // 起動引数のほうも見るのは、**自己修復の修復セッションが同じモードを
        // `spawn_with_args` 経由で渡している**ため（設計§17）。無人で走らせる機能なので、
        // ここで答えられないと確認の画面で永久に止まる
        let wants_bypass = initial_mode.as_ref().map(PermissionMode::as_str)
            == Some("bypassPermissions")
            || extra_args.iter().any(|arg| arg == "bypassPermissions");
        if wants_bypass {
            tokio::spawn(answer_bypass_notice(Arc::clone(&session)));
        }

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

        // 画面の配信も畳む。カードが消えたあとに1枚でも出ると、サーバ側では
        // 「居ないカードのフレーム」になって捨てられるだけの無駄になる
        if let Some(screen) = session.screen() {
            screen.unsubscribe();
        }
        // 先に止めないと、読み取りスレッド → 合流タスクが Arc を握ったままになり
        // セッションが解放されない（合流タスクは待ち行列が閉じたときに終わる）
        session.kill();
        hooks_settings::cleanup(&session.settings);
        if let Some(parser) = self.parser.lock().expect("ロックが壊れていない").as_ref() {
            parser.unwatch(card_id);
        }
        self.events.emit(ServerMessage::SessionRemoved { card_id });
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

    /// パーサが読んだノードを**上へ報告する**（セルフホスト化設計§3-3・§6-1）。
    ///
    /// フェーズ1 まではセッションが持つ窓へ直接書いていたが、DB が真実になったので
    /// 履歴の持ち主はサーバ側の記録に移った。セッションホストは読んで渡すだけになる。
    ///
    /// 知らないカードのぶんは捨てる。外した直後に届いたノードで一覧を汚さないため。
    ///
    /// 「進めてよい位置」を一緒に運ぶのは、**位置を進めるのが運び手の仕事**になったため
    /// （§6-1）。読んだ側には、記録に入ったかどうかを知る術が無い。
    pub fn report_transcript(
        &self,
        card_id: CardId,
        transcript_path: &str,
        source: &str,
        next_offset: u64,
        nodes: &[ParsedNode],
    ) {
        if nodes.is_empty() || self.get(card_id).is_none() {
            return;
        }
        self.events.report_transcript(TranscriptReport {
            card_id,
            transcript_path: transcript_path.to_string(),
            source: source.to_string(),
            next_offset,
            nodes: nodes.iter().map(|parsed| parsed.node.clone()).collect(),
        });
    }

    /// 巻き戻り（`/rewind`）を上へ報告する。
    pub fn report_transcript_reset(&self, card_id: CardId) {
        if self.get(card_id).is_none() {
            return;
        }
        self.events.reset_transcript(card_id);
    }

    /// パーサへの口を差し込む。
    ///
    /// 起動順の都合で、SessionManager を作ってからパーサを立ち上げるため後から渡す。
    pub fn attach_parser(&self, handle: crate::parser::ParserHandle) {
        *self.parser.lock().expect("ロックが壊れていない") = Some(handle);
    }

    /// 一覧を見ている全クライアントへ流す（カード単位でない通知に使う）。
    pub fn broadcast(&self, message: ServerMessage) {
        self.events.emit(message);
    }

    /// カード1枚を全クライアントへ送り直す。
    ///
    /// 権限モードのように**差分メッセージ（`status`）に載らない項目**が変わったときに使う。
    /// モデルの切替を最後まで面倒みる（設計§5・§6）。
    ///
    /// # なぜマネージャの仕事なのか
    ///
    /// 切替は**利用者のグローバル既定 `~/.claude/settings.json` を汚す**（設計§11 前提3
    /// で実測）。対象はプロセスに1つしかないファイルなので、**プロセス全体で1本の
    /// ロック**の下で「送る → 確定を待つ → 回復する」を通しで行う必要がある。
    /// セッション1本の中に閉じた話ではないので、ここに置く。
    ///
    /// 直列化しないと設計§6 の4手が起きる。
    ///
    /// ```text
    /// A：opus を控える → A：/model sonnet   → CLI が sonnet を書く
    /// B：控える（★sonnet を「元の値」だと思い込む）→ B：/model haiku
    /// A：値が違うので諦める → B：sonnet へ戻す → opus が二度と戻らない
    /// ```
    ///
    /// 「読んだ時点と違ったら書かない」という自衛だけでは、汚染を防ぐのではなく
    /// **汚染を固定する**ことになる。
    ///
    /// # 同一セッションへの連打は、ロックの手前で断る
    ///
    /// ロックだけに任せると、連打したぶんが**行列に並ぶ**。1本あたり最長19秒
    /// （確認待ち4秒＋確定待ち15秒）なので、5回押せば5回目は約76秒後になり、
    /// しかもロックはプロセスに1本なので**他のカードの切替も全部その後ろ**になる。
    ///
    /// 待たせて順番に叶えるより、**その場で断って選び直してもらう**ほうがよい。
    pub async fn switch_model(
        self: &Arc<Self>,
        session: &Arc<Session>,
        target: &ModelId,
    ) -> Result<(), ModelSwitchError> {
        // **ロックを取る前に**権利を1つだけ取る。ここで断らないと行列ができる
        let Some(_in_flight) = session.begin_model_switch() else {
            return Err(ModelSwitchError::Busy);
        };
        // 切替と回復の一連をプロセス全体で直列化する。ガードはこの関数を抜けるまで持つ
        let _guard = self.claude_settings.lock_switch().await;

        let resolved = self.aliases.resolve(target);
        let Some(mark) = session.request_model(target, resolved.as_ref()).await? else {
            // もう目的のモデルだった。送っていないのでグローバル既定も汚れていない
            return Ok(());
        };

        // 押した手応えを即返す（楽観更新。設計§5）
        self.broadcast_session(session);

        // **回復は成否によらず必ず走らせる。** 送った時点でグローバル既定は汚れうる
        session.settle_model_switch(mark).await;
        // 解決先は**ここで引き直す。** 確定の過程で [`Self::apply_model_report`] が
        // 別名の解決先を覚えている可能性があり、送る前の値より新しい
        let resolved = self.aliases.resolve(target);
        let outcome = self.claude_settings.recover(target, resolved.as_ref());
        tracing::debug!(card_id = %session.card_id, "グローバル既定の回復: {outcome:?}");

        self.broadcast_session(session);
        Ok(())
    }

    /// `statusLine` が知らせてきたモデルを取り込む（設計§4）。
    ///
    /// **ここが「いま何で動いているか」の唯一の入り口**。値が動いたときだけ配信する
    /// （フックの `permission_mode` と同じ考え方。毎回配ると無駄が大きい）。
    ///
    /// あわせて、切替を要求していた別名の解決先を覚える（設計§12）。送った別名と
    /// CLI が名乗り返したフルIDが結び付くのは、**この瞬間しかない**。
    ///
    /// # 名乗る値が動かない切替がある
    ///
    /// 違う別名が同じフルIDへ落ちる組（`opus` と `opus[1m]`）では、切り替わっても
    /// 名乗りが変わらない。**「値が動いたか」だけを見ていると確定に気づけず**、
    /// 楽観更新が時間切れまで残って「切替中…」が15秒続く。要求と辻褄が合う名乗りなら、
    /// 値が動いていなくても確定として扱う。
    ///
    /// # 動いたからといって、要求の結果とは限らない
    ///
    /// CLI は自分の都合でもモデルを変える（利用制限のフォールバック等）。要求中に
    /// 起きたそれを要求の結果として覚えると、`opus → Sonnet 5` のような対応が
    /// **永続化される**。覚えるのは名乗りが別名を説明するときだけにする
    /// （[`model::id_matches_alias`]）。
    pub fn apply_model_report(&self, session: &Arc<Session>, id: ModelId, label: Option<String>) {
        let requested = session.meta().model_requested;
        let moved = session.store_model(id.clone(), label.clone());
        // 要求した別名で名乗りの説明が付くか。確定の判断にも、覚えてよいかの判断にも使う
        let explained = requested.as_ref().is_some_and(|alias| {
            model::report_explains(alias, self.aliases.resolve(alias).as_ref(), &id)
        });

        if !moved {
            // 値が動いていないのに要求と辻褄が合う＝名乗りが変わらない切替が効いた。
            // 説明が付かないなら CLI が拒否した可能性が残るので、時間切れの側へ任せる
            if !explained {
                return;
            }
            session.store_model_requested(None);
        }

        match requested {
            // 効いた別名が分かった。次の「もう目的のモデルか」の判定はこれで行う
            Some(alias) => {
                if explained {
                    if let Some(display_name) = label.as_deref()
                        && model::id_matches_alias(&alias, &id)
                        && self.aliases.learn(&alias, &id, display_name)
                    {
                        tracing::info!(
                            card_id = %session.card_id,
                            "別名の解決先を覚えました: {alias} -> {id}（{display_name}）"
                        );
                        // 表が変わったので上へ知らせる（設計§13-4）。運ぶ相手が
                        // 居なければ何も起きない
                        if let Ok(aliases) = serde_json::to_value(self.aliases.all()) {
                            self.events.model_aliases_changed(aliases);
                        }
                    }
                    session.store_model_alias(Some(alias));
                } else {
                    // 要求の裏で CLI が乗り換えた。どの別名で動いているのか分からない
                    tracing::info!(
                        card_id = %session.card_id,
                        "{alias} を要求しましたが、CLI は {id} を名乗りました。要求の結果とはみなしません"
                    );
                    session.store_model_alias(None);
                }
            }
            // 要求していないのに動いた。起動後の最初の名乗りもここを通るので、
            // **一律に忘れてはいけない**（注入した別名で始まっていることが分かっている）。
            // いまの別名で名乗りの説明が付かなくなったときだけ忘れる
            None => {
                let stale = session.model_alias().is_some_and(|alias| {
                    !model::report_explains(&alias, self.aliases.resolve(&alias).as_ref(), &id)
                });
                if stale {
                    session.store_model_alias(None);
                }
            }
        }

        self.broadcast_session(session);
    }

    pub fn broadcast_session(&self, session: &Session) {
        self.broadcast_meta(session);
    }

    fn publish(&self, session: &Arc<Session>, changed: Changed) {
        if changed.meta {
            self.broadcast_meta(session);
        } else if changed.status {
            let (status, subagent_active, last_activity_at) = session.status_snapshot();
            self.events.emit(ServerMessage::Status {
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
        // 束は1周に1回だけ組む。`hook_port` と `hook_bin` を持っているのはこちらだけで、
        // フック未受信の1行に宛先を並べるために要る（設計§8-4）
        let input = SweepInput {
            threshold_secs: self.config.stalled_threshold_secs,
            hook_port: self.config.hook_port,
            hook_bin: &self.hook_program,
        };
        for session in sessions {
            let changed = session.sweep(&input);
            if changed.any() {
                self.publish(&session, changed);
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
        self.events.emit(ServerMessage::SessionUpsert {
            session: Box::new(session.meta()),
        });
    }
}

/// 起動引数から `--model <値>` の値を取り出す。
///
/// 有無だけでなく値も要るのは、**その値が起動時に効いている別名になる**ため（設計§5）。
/// 自己修復の見直しセッションが `--model` を明示して起こす経路がこれにあたる。
fn model_arg(extra_args: &[String]) -> Option<ModelId> {
    let at = extra_args.iter().position(|arg| arg == "--model")?;
    extra_args
        .get(at + 1)
        .map(|value| ModelId::new(value.as_str()))
}

/// PTY の細切れチャンクを時間窓でまとめて、まとまるたびに `sink` へ渡す（設計§10）。
///
/// CLI は1文字ずつ書くこともあるので、そのまま WebSocket フレームにすると数が爆発して
/// ブラウザ側の処理が追いつかなくなる。`window` の間に届いたものを1つにまとめてから送る。
///
/// セッションから切り離してあるのは、時間窓の挙動を PTY 無しで検証できるようにするため。
///
/// # 途中に口が2つある
///
/// `tap` は**合流する前**の1チャンクごと、`sink` は合流した結果。端末エミュレータは
/// 前者を使う（設計§7-2）。合流後の経路（リングバッファ・配信）は溢れたら落とす作りに
/// なっていて、**落ちたバイトを食わせると ANSI の状態機械が壊れる**ため、
/// 「落とさない側」から取らなければならない。
pub async fn coalesce_stream<T, F>(
    mut chunks: mpsc::Receiver<Vec<u8>>,
    window: Duration,
    mut tap: T,
    mut sink: F,
) where
    T: FnMut(&[u8]),
    F: FnMut(&[u8]),
{
    loop {
        // 窓を開くのは最初のチャンクが来てから。何も来ていないのに待つと遅延が増えるだけ
        let Some(first) = chunks.recv().await else {
            break;
        };
        tap(&first);
        let mut merged = first;
        let deadline = tokio::time::Instant::now() + window;
        let mut input_closed = false;

        while merged.len() < MAX_COALESCED_FRAME {
            match tokio::time::timeout_at(deadline, chunks.recv()).await {
                Ok(Some(chunk)) => {
                    tap(&chunk);
                    merged.extend_from_slice(&chunk);
                }
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
    coalesce_stream(
        chunks,
        window,
        |chunk| {
            if let Some(screen) = &session.screen {
                screen.feed(chunk);
            }
        },
        |merged| session.publish_output(merged),
    )
    .await;
}

/// 全承認をスキップで起動したときの、責任の受諾を尋ねる画面に答える（利用者の判断）。
///
/// # なぜダッシュボードが答えるのか
///
/// 起動ボタンで「全承認をスキップ」を選んだ時点で意思表示は済んでいる、という判断。
/// ただし**答え方は自己修復と同じ**にする — その画面が出ていることを確かめ、さらに
/// 「はい」と書かれた選択肢の番号を読んでから、その数字だけを送る。
///
/// # 決め打ちで確定を送らない
///
/// この画面の既定の選択肢は「いいえ（終了する）」とされている。時間で区切って闇雲に
/// Enter を送ると、**起動したはずのセッションが黙って終了する**。選択肢を読めなければ
/// 何も送らず、利用者がターミナルビューで答えられる状態のまま残す。
///
/// # ここは末尾を見たままでよい
///
/// モデル切替の確認（[`Session::answer_switch_confirmation`]）は、残骸に一致して
/// 誤爆するので目印より後だけを見るようにした。こちらは**起動直後に1回だけ**走り、
/// その時点でスクロールバックは空なので拾う残骸がそもそも無い。加えてフッタが
/// 読めた時点で切り上げる片道処理になっている。片方だけ直っているのは意図的。
async fn answer_bypass_notice(session: Arc<Session>) {
    /// 画面が出るのを待つ上限。本物の CLI は起動に十数秒かかることがある。
    const DEADLINE: Duration = Duration::from_secs(60);
    const STEP: Duration = Duration::from_millis(300);

    let deadline = tokio::time::Instant::now() + DEADLINE;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(STEP).await;

        let screen = session.scrollback_tail(FOOTER_TAIL);
        let lowered = permission::strip_ansi(&screen).to_lowercase();
        let looks_like_notice = permission::BYPASS_NOTICE_MARKERS
            .iter()
            .any(|marker| lowered.contains(marker));

        if !looks_like_notice {
            // フッタが読めた＝もう通常の画面。一度受け入れた環境では確認自体が出ない
            if session.read_footer_mode().is_some() {
                return;
            }
            continue;
        }

        match permission::accept_option_key(&screen) {
            Some(key) => {
                tracing::info!(
                    card_id = %session.card_id,
                    "全承認をスキップの確認に答えます（選択肢 {key}）"
                );
                session.send_key(key.to_string().as_bytes(), "全承認スキップの選択肢");
                // 番号を選んだあとに確定が要る作りもあるので、間を置いて確定を送る
                tokio::time::sleep(INSTRUCTION_SETTLE).await;
                session.send_key(b"\r", "全承認スキップの確定");
            }
            None => tracing::warn!(
                card_id = %session.card_id,
                "全承認をスキップの確認が出ていますが、受け入れる選択肢を読み取れませんでした。\
                ターミナルビューから答えてください"
            ),
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 端末への書き込みは、声を持つ口だけを通ること（設計§10-3）。
    ///
    /// 送出の失敗に声を与えたのは `send_key` / `send_instruction` /
    /// `switch_permission_mode` の3つ。**直に呼ぶ道を増やすと、そこだけがまた
    /// 無音になる**——しかも「送ったのに効かない」という、いちばん理由の見えない形で。
    ///
    /// 到達可能性ではなく**綴りそのもの**を見るのは、`write_input` が公開の口で
    /// あり続ける必要があるため（`crate::link` のブラウザの打鍵が通る）。
    #[test]
    fn 端末への書き込みは声を持つ口だけを通る() {
        /// 許した綴り。**増やすときは、その口が失敗を残すことを確かめてから。**
        const 許した綴り: &[&str] = &[
            // 口そのもの
            "pub fn write_input(&self, bytes: &[u8]) -> anyhow::Result<()> {",
            "self.process.write_input(bytes)",
            // 声を持つ3つの口。**綴りごと持つ**——`self.write_input(..)` だけを
            // 見ると、`let _ =` で捨てる形が紛れ込んでも気づけない
            "if let Err(err) = self.write_input(bytes) {", // send_key
            "self.write_input(CYCLE_KEY)",                 // switch_permission_mode
            "self.write_input(&body)?;",                   // send_instruction
            "self.write_input(&submit)",                   // send_instruction
        ];

        // **試験の側は数えない。** この検査自身が許した綴りを並べているので、
        // 切らないと自分の行を拾って必ず落ちる（台帳の走査と同じ規則）
        let source = include_str!("mod.rs");
        let 製品 = source
            .find("\n#[cfg(test)]")
            .map_or(source, |cut| &source[..cut]);

        let はみ出し: Vec<&str> = 製品
            .lines()
            .map(str::trim)
            .filter(|line| line.contains("write_input("))
            .filter(|line| !line.starts_with("//"))
            .filter(|line| !許した綴り.contains(line))
            .collect();

        assert!(
            はみ出し.is_empty(),
            "端末への書き込みが、声を持たない口から出ています:\n{}\n\
             `send_key` を通すか、失敗を残す口を新しく作って許した綴りへ足すこと",
            はみ出し.join("\n")
        );
    }

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

    #[test]
    fn 目印より後に届いたぶんだけを取り出す() {
        // モデル切替の確認を探す範囲を限るための土台。ここが崩れると、
        // 前回の切替で出たダイアログの残骸に反応して端末へキーを送ってしまう
        let mut ring = RingBuffer::new(64);
        ring.push(b"Switch model?");
        let mark = ring.written();
        ring.push("新しい出力".as_bytes());

        let fresh = ring.since(mark, 64);
        assert_eq!(fresh, "新しい出力".as_bytes());
        assert!(
            !String::from_utf8_lossy(&fresh).contains("Switch model?"),
            "目印より前は見えてはいけない"
        );
    }

    #[test]
    fn 目印を打った直後は何も返らない() {
        let mut ring = RingBuffer::new(64);
        ring.push(b"abcde");
        let mark = ring.written();
        assert!(ring.since(mark, 64).is_empty());
    }

    #[test]
    fn 目印より後でも上限を超えたぶんは返らない() {
        let mut ring = RingBuffer::new(64);
        let mark = ring.written();
        ring.push(b"123456789");
        assert_eq!(ring.since(mark, 4), b"6789", "末尾から上限ぶんだけ");
    }

    #[test]
    fn 目印より後の一部が捨てられていたら残りが全部返る() {
        // 目印以降が容量を超えた場合。残っているバイトはすべて目印より後なので、
        // 全部返すのが正しい（過去を巻き込む心配は無い）
        let mut ring = RingBuffer::new(4);
        ring.push(b"ab");
        let mark = ring.written();
        ring.push(b"cdefgh");

        assert_eq!(ring.since(mark, 64), b"efgh");
    }

    #[test]
    fn 累計は捨てたぶんも数え続ける() {
        // len() は容量で頭打ちになるので、位置の目印には使えない
        let mut ring = RingBuffer::new(4);
        ring.push(b"abcdef");
        ring.push(b"gh");

        assert_eq!(ring.len(), 4);
        assert_eq!(ring.written(), 8, "1回で容量を超えた書き込みも数える");
    }

    /// 合流結果を順番に集めながら [`coalesce_stream`] を回す。
    async fn collect_merged(
        window: Duration,
        feed: impl FnOnce(mpsc::Sender<Vec<u8>>) -> tokio::task::JoinHandle<()>,
    ) -> Vec<Vec<u8>> {
        collect_both(window, feed).await.1
    }

    /// 合流前（タップ）と合流後（配信）の両方を集める。
    async fn collect_both(
        window: Duration,
        feed: impl FnOnce(mpsc::Sender<Vec<u8>>) -> tokio::task::JoinHandle<()>,
    ) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(16);
        let tapped = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let merged = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));

        let tap_sink = Arc::clone(&tapped);
        let sink = Arc::clone(&merged);
        let feeder = feed(tx);
        coalesce_stream(
            rx,
            window,
            move |chunk| {
                tap_sink
                    .lock()
                    .expect("ロックが壊れていない")
                    .push(chunk.to_vec());
            },
            move |bytes| {
                sink.lock()
                    .expect("ロックが壊れていない")
                    .push(bytes.to_vec());
            },
        )
        .await;
        feeder.await.expect("送信側が正常に終わること");

        let tapped = tapped.lock().expect("ロックが壊れていない").clone();
        let merged = merged.lock().expect("ロックが壊れていない").clone();
        (tapped, merged)
    }

    #[tokio::test]
    async fn 合流前のバイトは全量が順序どおり流れる() {
        // 設計§7-2。端末エミュレータはこちら側から食う。**合流の窓や上限で1バイトも
        // 落ちない**ことが、ANSI の状態機械を壊さない前提になっている
        let (tapped, merged) = collect_both(Duration::from_millis(8), |tx| {
            tokio::spawn(async move {
                for index in 0..64u8 {
                    tx.send(vec![index]).await.expect("送れること");
                }
            })
        })
        .await;

        let flat: Vec<u8> = tapped.concat();
        assert_eq!(
            flat,
            (0..64u8).collect::<Vec<u8>>(),
            "順序か全量が崩れている"
        );
        assert_eq!(
            flat,
            merged.concat(),
            "合流の前後で中身が食い違っている（どちらかが落としている）"
        );
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
