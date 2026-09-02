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
use tokio::sync::{Semaphore, broadcast, mpsc};

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

/// 添付の印を確かめる刻み。
///
/// [`MODEL_STEP`] と同じ値だが**別に持つ**。あちらはモデル切替の確認画面を待つ刻みで、
/// 片方を実測で動かしたときにもう片方が黙って付いてくると理由が追えなくなる。
const ATTACHMENT_STEP: Duration = Duration::from_millis(200);

/// 添付の印を探すときに読むスクロールバックの長さ（バイト）。
///
/// **[`FOOTER_TAIL`] より厚い。** [`RingBuffer::since`] は目印より後が上限を超えると
/// **古いほうから捨てる**が、印は貼り付けの直後——つまり**窓の先頭側**に出る。
/// フッタと同じ 32 KiB にすると、**送信のあいだに 32 KiB を超える出力が流れただけで
/// 印が窓から落ち、添付できているのに断られる**（応答が流れている最中に画像を送ると起きる）。
///
/// フッタ側を厚くしないのは、あちらが**毎秒回る見張り**で、しかも末尾しか要らないため。
const ATTACHMENT_TAIL: usize = 256 * 1024;

/// 同時に起こし直せる本数（接続断のカードを復旧ボタンで戻す 設計§8-4）。
///
/// 1本あたり実測 **1190MB・14プロセス**（ローカルイシュー
/// `セッションに載るMCPサーバ群を選べるようにする`）なので、6枚を一斉に起こすと
/// 7GB が同時に立ち上がる。この機械は WSL で Windows とメモリを分け合っており、
/// 育てすぎて一度落としかけた記録がある。
///
/// **設定キーには出していない。** 実機で6枚を戻す実測（設計§13 の4）を取ってから
/// 決める。
const REVIVE_PARALLEL: usize = 2;

/// 起こし直した1本を「立ち上がりきった」と数えるまでの上限（設計§8-5）。
///
/// 席を返す条件は「カードが [`SessionStatus::Starting`] を抜けること」＝最初のフックが
/// 届くことだが、**フックが1件も来ないセッションが席を占め続ける**のは困る
/// （初期実装§11 の「フック未受信」は実在する状態である）。
///
/// 値は CLI の起動を待つ既存の上限と揃えてある。
const REVIVE_SETTLE: Duration = Duration::from_secs(60);
const REVIVE_STEP: Duration = Duration::from_millis(100);

/// 起こし直した1本のメモリが `MemAvailable` に現れきるまでの見込み（設計§19）。
///
/// # なぜ [`REVIVE_SETTLE`] と別に要るのか
///
/// **数えているものが違う。** 席は「起動の山」を抑えるためのもので、最初のフックが
/// 届いた時点＝**プロセスが立ち上がった時点**で返してよい。ところが claude が
/// 約 780MB を実際に確保するのは**そのあと**である。
///
/// フェーズ6 の実測がそのまま根拠になっている——6枚を撃つと擬似ターミナルは
/// **2.02 秒**で6本とも揃うのに、木の RSS はその直後で 7,585MB、**+50 秒で 10,617MB**
/// だった。席が返ったあとに 3GB 増えている。
///
/// 席と同じ寿命で容量を守ろうとすると、**席が返った瞬間に古い空きを読む**ので、
/// 断られ始めるのは実際に空きが尽きてからになる。歯止めが歯止めにならない。
const REVIVE_MEMORY_SETTLE: Duration = Duration::from_secs(60);

/// 同じカードへ二度目の頼みが来たときの言い分（設計§8-1）。
///
/// **待ち行列に並ばせない**ので、断り方は1つで済む。ここに置いてあるのは、
/// [`SessionManager::begin_revive`] が `None` を返す唯一の理由だからで、**頼み手ごとに
/// 書くと言い方が食い違う**——リモート（`crate::link`）とローカル（`agentdashboard_core::local`）で
/// 別の文が出ると、利用者には別々の不調に見える。
pub const ALREADY_REVIVING: &str = "このカードは復旧中です";

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
    /// 空きメモリが床を切っているので起こし直せない（設計§18-3）。
    ///
    /// **数を添える。** 「メモリが足りません」だけだと、あと1枚なのか10枚ぶん
    /// 足りないのかが分からず、利用者は何をすればよいか決められない。
    // **継続の `\` を落とさないこと。** 落とすと字下げの半角スペースがそのまま本文へ
    // 入り、画面のカードとログに出る（コードレビュー対応5）。飛ばされるのは ASCII の
    // 空白だけなので、この行頭に全角スペースを使ってはいけない
    #[error(
        "メモリが足りないので起こし直せません（空き {available_mb} MB／\
         1枚あたり {estimate_mb} MB ＋ 残す余白 {headroom_mb} MB）。\
         動いているセッションを終了させてから、もう一度押してください"
    )]
    OutOfMemory {
        available_mb: u64,
        estimate_mb: u64,
        headroom_mb: u64,
    },
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

/// CLI が「セッションが終わった」と名乗ったこと。**確定ではない。**
///
/// `SessionEnd` は会話の入れ替え（`/resume` ／ `/clear`）でも飛ぶので、これだけでは
/// プロセスが消えたと言えない。確定を受け持つのは PTY の終了（[`SessionManager::on_exit`]）で、
/// こちらは「利用者が知らないうちに落ちたのか」を見分けるための材料にしかならない。
#[derive(Debug, Clone)]
struct EndReport {
    /// 申告を受けた時刻。猶予の判定に使う。
    at: Timestamp,
    /// CLI が名乗った理由。**判定には使わず、記録にだけ載せる**。
    ///
    /// 綴りも顔ぶれも CLI 側の都合で変わる（公式の列挙は4つから6つへ増えている）。
    /// ここに判定を載せると、表に無い値が来たときだけ壊れる。
    // 読むのはログだけ。**判定からは永久に読まない**
    reason: Option<String>,
}

/// 申告の置き場所。**中に他のものを入れない。**
///
/// [`Session`] の欄として直に `Mutex<Option<EndReport>>` を持たせるのと持ち物は同じだが、
/// 名前を付けてあるのには理由が2つある。
///
/// - **`meta` や `ring` を跨げない形になる。** このロックは `Option` の出し入れだけで
///   終わる約束で、既存の並び（`ring` → 離す → `meta`）へ新しい順序を持ち込まない
/// - **単体テストが擬似ターミナルを起こさずに書ける。** [`Session`] は子プロセスを
///   起こさないと作れないので、包まないと器の検証がプロセス込みの統合テストになる
#[derive(Debug, Default)]
struct EndReportCell(Mutex<Option<EndReport>>);

impl EndReportCell {
    /// 申告を立てる。既に立っていれば新しいほうで上書きする。
    fn report(&self, at: Timestamp, reason: Option<String>) {
        *self.0.lock().expect("ロックが壊れていない") = Some(EndReport { at, reason });
    }

    /// 立っていれば下ろす。立っていなければ**何も起きない**。
    fn clear(&self) -> Option<EndReport> {
        self.0.lock().expect("ロックが壊れていない").take()
    }

    /// 立っていれば取り出す（[`Self::clear`] と同じだが、呼ぶ側の意図が違う）。
    fn take(&self) -> Option<EndReport> {
        self.clear()
    }

    /// 立ってから `secs` 秒より長く経っていれば取り出す。**そうでなければ残す。**
    ///
    /// `now` を引数で受け取るのは、境目の検証を待ち時間ゼロで書けるようにするため。
    fn take_older_than(&self, now: Timestamp, secs: u64) -> Option<EndReport> {
        let mut slot = self.0.lock().expect("ロックが壊れていない");
        let at = slot.as_ref()?.at;
        // 秒からミリ秒への直し方は `state::sweep_stalled` と同じ形に揃える
        if now.saturating_sub(at) > (secs as i64).saturating_mul(1000) {
            slot.take()
        } else {
            None
        }
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
    /// **利用者がダッシュボードから終わらせた**ことの印。立てるのは [`Session::kill`] だけで、
    /// 一度立つと下りない。
    ///
    /// ダッシュボードから終了させた場合、子プロセスは強制終了されるので終了コードは
    /// 非ゼロになる。それをそのまま「異常終了」と表示すると、利用者が自分で終わらせたのに
    /// 落ちたように見えてしまうため、指示した側で印を立てておく。
    ///
    /// **CLI 側の申告（`SessionEnd`）はここへ立てない。** あちらは `/resume` のように
    /// プロセスが生き続ける場面でも飛ぶので**取り消しうる**印であり、下りない印と混ぜると
    /// 呼び戻したあとに本当に落ちたときまで正常終了として表示される。器は `end_report`。
    expected_exit: AtomicBool,
    /// CLI からの終了の申告。**立っている間も状態は動かさない。**
    ///
    /// 取り消されるのは、次のフックが1件届いたとき（死んだプロセスはフックを出さない）か、
    /// 猶予を過ぎても生きていたとき。確定は [`SessionManager::on_exit`] が受け持つ。
    end_report: EndReportCell,
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
    /// 添付の印を待つ上限（画像添付 設計§21 読み替え2）。
    ///
    /// **設定から取る**（`attachment_mark_wait_ms`）。定数のままにすると、
    /// 「印が出ないこと」を確かめるテストが必ず既定の5秒を待ち切り、**その間ずっと
    /// 枠を握って時間に敏感な別のテストを落とす**（実際に落ちた）。
    attachment_mark_wait: Duration,
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

/// フックが知らせてきた JSONL の場所と、**それが乗り換えかどうか**。
///
/// **区別が要る理由。** ダッシュボードを起こし直すと `transcript_path` は `None` へ戻り、
/// **最初のフックで必ず「新しい場所」に見える**。ここで木を捨てると
/// **再起動のたびに全カードの履歴が消える**。**初めて名乗ったのか、別のファイルへ
/// 移ったのか**を、呼ぶ側が見分けられなければならない。
#[derive(Debug, Clone)]
struct TranscriptLearned {
    /// 監視してほしい JSONL の場所。
    path: String,
    /// **それまで別のファイルを見ていたか。** ターミナルの中で `/resume` や `/clear` を
    /// 打つと、claude は**別の JSONL へ移る**。このとき捨てないと、1枚のカードの木に
    /// **前のセッションと新しいセッションのノードが積み上がる**（実測：1,963件）。
    switched: bool,
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

    /// CLI が付けた名前を控える。変わっていれば `true`（設計§4）。
    ///
    /// **同じ題は履歴に何度も書かれる**（実測では1ファイルに2件）ので、変わっていない
    /// ときに `true` を返すと、読み直すたびにカード1枚の配り直しが記録層と全ブラウザまで
    /// 波及する。ここが「変わったときだけ」の最後の砦になる——パーサ側でも同じ判定を
    /// しているが、**再起動を跨ぐと向こうの記憶は消える**（設計§2-2）。
    fn store_session_title(&self, title: String) -> bool {
        let mut meta = self.meta.lock().expect("ロックが壊れていない");
        if meta.session_title.as_ref() == Some(&title) {
            return false;
        }
        meta.session_title = Some(title);
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
        self.send_instruction_with(text, &[]).await
    }

    /// [`Session::send_instruction`] に**添付のパス**を足した形（画像添付 設計§6・§7）。
    ///
    /// 添付が0枚のときは [`Session::send_instruction`] と**振る舞いが1つも変わらない**
    /// ——書くバイト列も、待ちの長さも、覗く回数も同じ（設計§14）。添付を使わない送信を
    /// 巻き添えにしないための約束で、テストで固定してある。
    ///
    /// 添付があるときだけ、確定の前に**画面へ印が出るのを待つ**。claude 側の添付は
    /// ディスクから読んで縮める非同期の処理なので、[`INSTRUCTION_SETTLE`]（30ms）では
    /// 間に合わない。間に合わないまま確定すると、**パスの文字列だけが送られる**——
    /// 利用者から見て「送ったのに画像が届いていない」形になる。
    pub async fn send_instruction_with(
        &self,
        text: &str,
        attachments: &[String],
    ) -> anyhow::Result<()> {
        let (body, submit) = input::encode_parts_with(text, attachments);
        // 印を数えるのは**書いたあとに届いたぶんだけ**にする。末尾から探すと、前回の
        // 送信で出た印に当たって「もう出ている」と誤って進む（`answer_switch_confirmation`
        // が同じ理由で目印を使っている）。添付が無いなら覗きもしない
        let since = (!attachments.is_empty()).then(|| self.scrollback_mark());
        if !body.is_empty() {
            self.write_input(&body)?;
            match since {
                // 貼り付けを受け取り終えてから確定を渡す。ここを詰めると、
                // 2つの書き込みが1回の読み取りにまとまって元の破綻へ戻る
                None => tokio::time::sleep(INSTRUCTION_SETTLE).await,
                Some(since) => self.await_image_marks(since, attachments.len()).await?,
            }
        }
        self.write_input(&submit)
    }

    /// 画面に添付の印が `want` 個出るまで待つ（設計§7-1）。
    ///
    /// 写し元は [`Session::answer_switch_confirmation`]——目印より後だけを見て、刻みで
    /// 確かめ、上限で諦める形。**固定の待ち時間にしない**のは、画像の大きさと機械の
    /// 速さで変わるためで、長めの固定値にすると遅い機械で取りこぼすか、速い機械を
    /// 無駄に待たせるかのどちらかになる。
    ///
    /// 出そろったら**上限を待たずにすぐ帰る**。
    ///
    /// # 本文が印の綴りを含んでいると、数を多く見る
    ///
    /// 貼り付けた本文は端末へ echo され、しかも TUI は入力欄を**何度も描き直す**ので、
    /// 利用者が `[Image #1]` と打つと**その字が何度も印として数えられる**。
    ///
    /// **「本文に含まれる数だけ差し引く」では直らない。** 描き直しの回数は端末と CLI の
    /// 都合で決まるので、**差し引くべき数が分からない**（擬似 claude で実測したところ、
    /// 本文の印1つが3つに見えた——生の echo と `received:` の行と、両方に写るため）。
    ///
    /// **起きたときの結末は「早く確定する」**——claude が画像を読み終える前に送ってしまう。
    /// 添付を付けたうえで本文に `[Image #N]` と打つ場合にしか起きないので、いまは
    /// **直さずに残してある**。直すなら、数えるのではなく**いま画面に出ているものだけを
    /// 見る**（＝端末エミュレータを通す）ことになるが、ローカルモードにはそれが無い。
    async fn await_image_marks(&self, since: u64, want: usize) -> anyhow::Result<()> {
        let started = tokio::time::Instant::now();
        let deadline = started + self.attachment_mark_wait;
        let mut got = 0;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(ATTACHMENT_STEP).await;
            got = input::count_image_marks(&self.scrollback_since(since, ATTACHMENT_TAIL));
            if got >= want {
                tracing::info!(
                    card_id = %self.card_id,
                    want,
                    got,
                    waited_ms = started.elapsed().as_millis() as u64,
                    "添付の印が出そろいました"
                );
                return Ok(());
            }
        }

        // 諦める。**確定は送らない**——パスの文字列だけが本文として送られる結末は、
        // 完了条件がいちばん嫌っている形（設計§7-2）
        let folded = self.fold_input().await;
        tracing::warn!(
            card_id = %self.card_id,
            want,
            got,
            folded,
            waited_ms = started.elapsed().as_millis() as u64,
            "添付の印が出ませんでした"
        );
        // この Err は `local.rs` と `link.rs` が `ServerMessage::Error` へ移して画面まで
        // 運ぶ。**「画像を添付できませんでした」で終わらせない**——もう一度押せばよいのか、
        // 大きすぎて諦めるべきなのかを、利用者が読んで判断できる形にする（設計§7-2）
        let 状況 = format!(
            "画像の印が {want} 枚ぶん出ませんでした（出たのは {got} 枚）。確定は送っていません"
        );
        Err(anyhow::anyhow!(if folded {
            format!("{状況}。入力欄は畳んであるので、そのままもう一度送れます")
        } else {
            format!(
                "{状況}。端末側の入力欄を畳めなかったので、\
                 **このまま送ると同じ画像が二重に添付されます**。\
                 ターミナルビューで Esc を2回押して入力欄を空にしてから送り直してください"
            )
        }))
    }

    /// 端末側の入力欄を畳む（設計§21 読み替え3）。畳めたら `true`。
    ///
    /// **`Ctrl+U` では畳めない。** あれはテキストしか消さず、添付のチップ（`[Image #N]`）は
    /// 残る。[`Session::send_instruction`] は毎回 `Ctrl+U` から始まるので、諦めたあとに
    /// 残しておくと**次の送信で前回の添付の上に積み上がる**（実測で7枚積んだ）。`Esc` は
    /// **2回**要る（1回では畳まれないことを実測済み）。
    ///
    /// ブラウザ側の添付一覧は**残す**（もう一度押せる）。畳むのは端末側だけで、この2つを
    /// 混同しないこと。
    ///
    /// # 確かめ方には限界がある
    ///
    /// 覗けるのは追記しかない生のバイト列なので、「消えた」ことは直接には見られない。
    /// **畳んだあとに描き直された分に印が載っていなければ畳めたとみなす。**
    ///
    /// **描き直しが1バイトも来なかったときは「畳めていない」側に倒す。** 忙しい・遅い・
    /// 詰まっている端末では `Esc` が効かないまま何も起きないことがあり、そこを「畳めた」と
    /// 読むと、断り文が「そのままもう一度送れます」と言ったうえで**次の送信で積み上がる**
    /// ——この関数が防ぐために在る失敗そのものになる。**安全側は「畳めた」ではない。**
    async fn fold_input(&self) -> bool {
        self.send_key(b"\x1b", "添付の取り消し（1回目）");
        tokio::time::sleep(INSTRUCTION_SETTLE).await;
        self.send_key(b"\x1b", "添付の取り消し（2回目）");

        let since = self.scrollback_mark();
        tokio::time::sleep(ATTACHMENT_STEP).await;
        let 描き直し = self.scrollback_since(since, ATTACHMENT_TAIL);
        // 何も来ていない＝畳めたかどうかを**確かめられなかった**
        !描き直し.is_empty() && input::count_image_marks(&描き直し) == 0
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

    /// CLI が終わりを名乗ったことを控える。**状態は動かさない。**
    ///
    /// `reason` を1行に残すのは、**受け取った値をどこにも残していなかった**ため
    /// （`/resume` と `/clear` が何を入れるかを、実機の症状から調べようがなかった）。
    pub(crate) fn report_end(&self, reason: Option<&str>) {
        self.end_report.report(now_ms(), reason.map(str::to_owned));
        tracing::info!(
            card_id = %self.card_id,
            reason = reason.unwrap_or_default(),
            "CLI が終了を名乗りました。確定はプロセスの終了を待ちます"
        );
    }

    /// 申告を下ろす。**まだ生きている証拠**（次のフック1件）を受け取ったときに呼ぶ。
    ///
    /// **立っていなければ何も出さない。** フックは1件ごとに届くので、ここが毎回喋ると
    /// いちばん読みたい行がそれで埋まる（ガイドライン「ログを残すとき」3）。
    pub(crate) fn clear_end_report(&self, by: state::HookEvent) {
        let Some(report) = self.end_report.clear() else {
            return;
        };
        tracing::info!(
            card_id = %self.card_id,
            reason = report.reason.as_deref().unwrap_or_default(),
            elapsed_ms = now_ms().saturating_sub(report.at),
            hook = by.as_str(),
            "終了の申告を下ろしました。フックが届いたので、まだ生きています"
        );
    }

    /// 申告を取り出す（確定のときに1度だけ）。
    fn take_end_report(&self) -> Option<EndReport> {
        self.end_report.take()
    }

    /// 猶予を過ぎた申告を取り出す。**過ぎていなければ残す。**
    fn end_report_older_than(&self, now: Timestamp, secs: u64) -> Option<EndReport> {
        self.end_report.take_older_than(now, secs)
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
    fn apply_hook(&self, input: &HookInput) -> (Changed, Option<TranscriptLearned>) {
        let mut new_path = None;
        if let Some(path) = input.transcript_path() {
            let mut current = self.transcript_path.lock().expect("ロックが壊れていない");
            if current.as_deref() != Some(path) {
                // **初回か、乗り換えか。** 呼ぶ側はこれで振る舞いを変える——
                // 乗り換えのときだけ、それまでの木を捨てる必要がある
                let switched = current.is_some();
                *current = Some(path.to_string());
                new_path = Some(TranscriptLearned {
                    path: path.to_string(),
                    switched,
                });
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

        // **猶予を過ぎても生きているなら、申告は嘘だったことになる。** 取り消す相手が
        // 居ない順序（`SessionStart` が先・`SessionEnd` が後で、そのあと無音）を、ここで拾う。
        //
        // 猶予に `threshold_secs`（＝停滞のしきい値）を流用しているのは、どちらも
        // 「何も来ないまま経った時間」で判断する同じ性質の値だから。別の数字を持つほどの
        // 違いが無く、持つとテストから短くできない。
        //
        // **状態は動かさないので `Changed` には足さない。** 申告の間も状態は動いていない
        // ので、下ろしても戻すものが無い（ブラウザへは1バイトも流れない）。
        if let Some(report) = self.end_report_older_than(now, input.threshold_secs) {
            tracing::info!(
                card_id = %self.card_id,
                reason = report.reason.as_deref().unwrap_or_default(),
                elapsed_ms = now.saturating_sub(report.at),
                "終了の申告を下ろしました。猶予の間に終わらなかったので、まだ生きています"
            );
        }

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

        // **宛先が実在するかを必ず言う。** 置き場所（`settings_exists`）は出していたのに
        // 宛先はパスを出すだけだったので、「settings は在るのに届かない」で行き止まりに
        // なった。実際、`(deleted)` が焼き込まれてフックが全滅した回は、**この1欄が
        // あれば2分待たずに切り分けが終わっていた**
        let hook_bin_exists = input.hook_bin.is_file();

        if saw_output {
            tracing::warn!(
                card_id = %self.card_id,
                settings = %settings.display(),
                settings_exists = settings.is_file(),
                hook_bin = %input.hook_bin.display(),
                hook_bin_exists,
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
                hook_bin_exists,
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
    /// いま起こし直している最中のカード（接続断のカードを復旧ボタンで戻す 設計§8-2）。
    ///
    /// **この集合が1台に1つで足りる**のが、上限を実体を持つ側に置いた理由である。
    /// カード1枚への頼みが集まる先は必ずこの PC なので、**サーバが2台でもタブが2枚でも
    /// 二重に起きない**——ブラウザ側やサーバ側で数える必要は無い。
    ///
    /// 実体の有無を見るだけでは防げない。抜け殻には実体が無いので、2つ目の頼みも
    /// 「居ないから作ってよい」を通ってしまう。
    reviving: Mutex<HashSet<CardId>>,
    /// 同時に起こし直す本数の上限（設計§8-1）。
    ///
    /// **ここだけは「その場で断る」ではなく「待たせる」**。このリポジトリの作法は
    /// `switch_model` の即断りだが、「全て復旧」は6枚をまとめて頼む操作なので、
    /// 断られたぶんを**押した人が拾い直せない**。
    revive_slots: Arc<Semaphore>,
    /// この機械のメモリを読む口（設計§18）。
    ///
    /// **差し替えられる形にしてあるのはテストのため。** テストから `/proc/meminfo` の
    /// 中身は変えられないので、固定していると**空きが足りないときの振る舞いを1行も
    /// 確かめられない**（ガイドライン「外の世界へ出る操作はトレイト越しにする」）。
    memory: Mutex<Arc<dyn crate::resources::Probe>>,
    /// 通したぶんを差し引いた**見込みの空き**（設計§19）。
    ///
    /// 席（[`SessionManager::revive_slots`]）とは**寿命が違う**ので別に持つ。席は
    /// 「起動の山」を抑えるためのもので最初のフックで返るが、claude が約 780MB を
    /// 確保し終えるのは**そのあと**である。席の数で容量を守ろうとすると、席が返った
    /// 瞬間に「まだ空いている」古い値を読んで次を通してしまう。
    ///
    /// **見るのと取るのは、このロックの中で不可分に行う**（[`SessionManager::reserve_memory`]）。
    /// 分けると、同時に席を取った2本が**両方「入る」と読んでから両方予約する**。
    budget: Mutex<ReviveBudget>,
}

/// 通したぶんを差し引いた見込みの空き（設計§19）。
///
/// # なぜ「枚数」ではなく「見込みの空き」なのか
///
/// 単純に「通した枚数 × 見積もり」を引くと、**もう載ったぶんまで二重に引く**。
/// 実機の `MemAvailable` は claude が確保するにつれて本当に減っていくので、
/// そのぶんと予約の両方を引くと、実際には入るのに断り続けることになる。
///
/// そこで**見込みと実測の小さいほう**を採る。載る前は見込みが効き、載ったあとは
/// 実測が効く——どちらが進んでいても、辻褄の合う側だけが残る。
#[derive(Debug, Default)]
struct ReviveBudget {
    /// いま枠を握っている本数。0 になったら見込みを捨てる（実測だけに戻す）。
    outstanding: u32,
    /// 通したぶんを引いた見込み。**枠が1つも無ければ `None`**。
    projected_mb: Option<u64>,
}

/// 起こし直し1枚ぶんのメモリを押さえていることの印（設計§19）。落ちると枠が返る。
///
/// [`ReviveInFlight`] と同じ RAII の形だが、**持つ期間が違う**——あちらは
/// 「立ち上がりきるまで」、こちらは**「メモリが載りきるまで」**である。
pub struct MemoryReservation {
    manager: Arc<SessionManager>,
}

impl Drop for MemoryReservation {
    fn drop(&mut self) {
        let mut budget = self.manager.budget.lock().expect("ロックが壊れていない");
        budget.outstanding = budget.outstanding.saturating_sub(1);
        if budget.outstanding == 0 {
            // 誰も待っていないなら、見込みは捨てて**実測だけ**に戻す
            budget.projected_mb = None;
        }
    }
}

/// 起こし直しが走っていることの印（設計§8-2）。落ちると印も下りる。
///
/// [`SwitchInFlight`] と同じ形だが、**こちらは所有する**——受け付けたら仕事を切り離し、
/// 切り離した先で席を待つ（設計§8-3）ので、借用のままではタスクへ移せない。
pub struct ReviveInFlight {
    manager: Arc<SessionManager>,
    card_id: CardId,
}

impl Drop for ReviveInFlight {
    fn drop(&mut self) {
        self.manager
            .reviving
            .lock()
            .expect("ロックが壊れていない")
            .remove(&self.card_id);
    }
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

    /// この PC の設定。
    ///
    /// ログを引く問い（ログ設計§13-1）が置き場所を知るために要る。`link.rs` は
    /// `SessionManager` しか持っていないので、**設定をもう1本の引数で配って回らない**
    /// ——同じものが2つの経路で渡ると、片方だけ差し替えたときに食い違う。
    pub fn config(&self) -> &Arc<SessionHostConfig> {
        &self.config
    }

    /// メモリを読む口を差し替える（テスト専用。設計§18-1）。
    ///
    /// 製品の経路からは呼ばない。**差し替えられないと、空きが足りないときの
    /// 振る舞いを1行も確かめられない**——テストから `/proc/meminfo` は変えられない。
    pub fn set_memory_probe(&self, probe: Arc<dyn crate::resources::Probe>) {
        *self.memory.lock().expect("ロックが壊れていない") = probe;
    }

    /// いまの資源と、**いま何枚起こし直せるか**（設計§18-2）。
    ///
    /// **数えるのはここ1箇所。** 画面もこの数を受け取って比べるだけで、同じ規則を
    /// TypeScript 側へ書き写さない。書き写すと、画面が「入る」と言ったものを
    /// PC が断る（あるいは逆）ことが起こる。
    ///
    /// 読めなければ `None`。**読めないことは異常ではない**（Linux 以外）。
    /// そのときは歯止めそのものが効かない——**分からないことを理由に止めない。**
    pub fn host_resources(&self) -> Option<protocol::HostResources> {
        crate::resources::snapshot(&self.memory_gauge(), self.projected_available_mb())
    }

    /// 通したぶんを差し引いた見込みの空き（設計§19）。枠が1つも無ければ `None`。
    ///
    /// **線の答えを作る2箇所**（`link.rs` の `Ask::Resources` と、ローカルモードの
    /// `local.rs`）も、床の判定と**同じ数**を使うためにこれを通す。片方だけ引くと、
    /// 画面が「入る」と言ったものを PC が断ることになる。
    pub fn projected_available_mb(&self) -> Option<u64> {
        self.budget
            .lock()
            .expect("ロックが壊れていない")
            .projected_mb
    }

    /// いま枠を握っている本数（テストと、ログのため）。
    pub fn reserved_revives(&self) -> u32 {
        self.budget
            .lock()
            .expect("ロックが壊れていない")
            .outstanding
    }

    /// メモリを読む口を借りる。
    ///
    /// **線の答えを作るところ（`link.rs`）は、器そのものではなくこれを持ち出す。**
    /// `SessionManager` を答えの中へ入れると `Debug` が要る形になり、器の全体に
    /// `Debug` を強いることになる——問いに要るのは読む口と数字2つだけである。
    pub fn memory_probe(&self) -> Arc<dyn crate::resources::Probe> {
        self.memory.lock().expect("ロックが壊れていない").clone()
    }

    /// 数えるのに要るもの一式（コードレビュー対応4）。
    ///
    /// **読む口と2つの数字を、ここでだけ束ねる。** 以前は3箇所が別々に組み立てており、
    /// **裸の `u64` が2つ並ぶ**ので見積もりと余白の取り違えを型が止められなかった。
    pub fn memory_gauge(&self) -> crate::resources::Gauge {
        crate::resources::Gauge::from_config(self.memory_probe(), &self.config)
    }

    /// いま1枚も起こし直せないなら、その理由を返す（設計§18-3）。
    ///
    /// 読めなかった場合は `None`＝**通す**。
    ///
    /// # なぜ席を引数で受け取るのか（使わないのに）
    ///
    /// **席を取った後でしか呼べないことを、型で固定するため。** 受付の時点で見ると、
    /// 「全て復旧」が投げる26枚は**まだ誰も起きていない空き**を読むので、全員が
    /// 「入る」と答えてしまう。席が空くころには足りていないのに、判断はもう済んでいる。
    ///
    /// **これをテストで押さえようとして、押さえられなかった。** 3枚を同時に頼んでも、
    /// 実際にはタスクが順に走るので、受付時に見る実装でも3枚目は既に2枚起きた後の
    /// 空きを読む——**壊し方を当てても落ちない**（当てて確かめた）。同時に読ませる
    /// 仕掛けを作るには、同期の `read()` の中で待つ必要があり、そこで走行時を止める。
    ///
    /// **だから検査ではなくコンパイラに見張らせる。** 席より前へ動かすと、渡すものが
    /// 無くてコンパイルが通らない。
    ///
    /// # 見るのと取るのは不可分（設計§19）
    ///
    /// 通れば**その場で1枚ぶん予約する**。読んでから予約するまでを分けると、同時に
    /// 席を取った2本が**両方「入る」と読んでから両方予約する**——席は2つあるので、
    /// これは日常的に起こる。
    ///
    /// 読めなかった場合は `Ok`＝**通す**（予約もしない）。**分からないことを理由に止めない。**
    fn reserve_memory(
        self: &Arc<Self>,
        _seat: &tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Option<MemoryReservation>, SessionError> {
        // **台帳のロックを取る前に読む口を複製しておく。** `memory_probe()` は別の
        // ロックを取るので、入れ子にすると順序の約束が要る
        let 物差し = self.memory_gauge();

        let mut budget = self.budget.lock().expect("ロックが壊れていない");
        let Some(resources) = crate::resources::snapshot(&物差し, budget.projected_mb) else {
            // 読めない機械（Linux 以外）。歯止めそのものが効かない
            return Ok(None);
        };
        // **`None` は「数えない」**（歯止めを外している）ので通す。断るのは
        // 「数えたうえで 0 枚」のときだけ（コードレビュー対応2）
        if resources.fits_now == Some(0) {
            return Err(SessionError::OutOfMemory {
                available_mb: resources.available_mb,
                estimate_mb: resources.estimate_mb,
                headroom_mb: resources.headroom_mb,
            });
        }
        // 通したぶんを見込みから引く。**実測が既に下がっていれば、そちらが採られている**
        // （`snapshot` が小さいほうを使う）ので、二重には引かれない
        let base = crate::resources::projected(resources.available_mb, budget.projected_mb);
        budget.projected_mb = Some(base.saturating_sub(物差し.estimate_mb()));
        budget.outstanding += 1;
        drop(budget);
        Ok(Some(MemoryReservation {
            manager: Arc::clone(self),
        }))
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
            reviving: Mutex::new(HashSet::new()),
            revive_slots: Arc::new(Semaphore::new(REVIVE_PARALLEL)),
            memory: Mutex::new(Arc::new(crate::resources::ProcMeminfo)),
            budget: Mutex::new(ReviveBudget::default()),
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

    /// カードを**新しく採番して**起こす。既存の4入口はすべてここを通る。
    ///
    /// 採番の1行だけをここに残し、中身は [`SessionManager::spawn_as`] へ寄せてある
    /// （接続断のカードを復旧ボタンで戻す 設計§7-2）。復旧は**採番せずに**あちらを
    /// 直に呼ぶので、この関数の見た目——ひいては公開の4入口の見た目——は変わらない。
    fn spawn_with(
        self: &Arc<Self>,
        cwd: &str,
        resume: Option<ClaudeSessionId>,
        extra_args: &[String],
        initial_mode: Option<PermissionMode>,
    ) -> Result<Arc<Session>, SessionError> {
        let start = match resume {
            Some(session_id) => lifecycle::SessionStart::Resume(session_id),
            None => lifecycle::SessionStart::Fresh(ClaudeSessionId::new()),
        };
        let initial_session_id = match start {
            // 自己採番なら起動した瞬間から対応が確定している
            lifecycle::SessionStart::Fresh(id) => Some(id),
            // 引き継ぎでは CLI 側が決めるので、最初のフックが届くまで空。
            // **復旧だけはここが違う**（設計§7-3）
            lifecycle::SessionStart::Resume(_) => None,
        };
        self.spawn_as(
            CardId::new(),
            cwd,
            start,
            extra_args,
            initial_mode,
            initial_session_id,
        )
    }

    /// カードIDを指定して起こす。
    ///
    /// `initial_session_id` は [`SessionMeta::claude_session_id`] の初期値で、
    /// **呼び出し側が「どの CLI セッションで始まるか」を知っている場合にだけ** `Some` に
    /// する。フックが届いたら [`crate::state`] の張り替えが確定させるので、CLI が別の
    /// IDを名乗った場合も追随する。
    #[allow(clippy::too_many_arguments)]
    fn spawn_as(
        self: &Arc<Self>,
        card_id: CardId,
        cwd: &str,
        start: lifecycle::SessionStart,
        extra_args: &[String],
        initial_mode: Option<PermissionMode>,
        initial_session_id: Option<ClaudeSessionId>,
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
            attachment_mark_wait: Duration::from_millis(self.config.attachment_mark_wait_ms),
            meta: Mutex::new(SessionMeta {
                card_id,
                project: ProjectId(project_path.to_string_lossy().into_owned()),
                // 呼び出し側が「どの CLI セッションで始まるか」を知っているときだけ
                // 埋まる（設計§7-3）。素の引き継ぎでは空のままで、最初のフックが確定させる
                claude_session_id: initial_session_id,
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
                // 名前は**最初のターンのあとに CLI が付ける**（履歴へ `ai-title` の行が
                // 書かれる）。起動した時点では存在しないので、ここで埋められる値が無い。
                // パーサが拾って報告してくるまで `None` のままでよい（設計§2）
                session_title: None,
            }),
            process,
            ring: Mutex::new(RingBuffer::new(self.config.pty_ring_buffer)),
            output,
            pause_requests: Mutex::new(HashSet::new()),
            settings,
            transcript_path: Mutex::new(None),
            expected_exit: AtomicBool::new(false),
            end_report: EndReportCell::default(),
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
        // **自分の実体を弱く握って渡す。** カードIDから引き直すと、起こし直しで
        // 載せ替わった別の実体へ終了を届けてしまう（[`SessionManager::on_exit`]）。
        // 強く握らないのは、終了を待つこのタスクが解放を1つも妨げないようにするため
        let 自分 = Arc::downgrade(&session);
        tokio::spawn(async move {
            if let Ok(exit) = exit_rx.await
                && let Some(session) = 自分.upgrade()
            {
                manager.on_exit(&session, exit);
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

    /// 実体を畳む。**カードが消えたことは配らない。**
    ///
    /// [`SessionManager::archive`] と [`SessionManager::revive`] が共有する本体で、
    /// 両者の違いは配信を伴うかどうかだけである（接続断のカードを復旧ボタンで戻す 設計§7-1）。
    /// **2箇所に書いてはいけない**——片方だけ直すと「画面からは畳めるのに復旧では
    /// 畳めない」が起きる。
    ///
    /// # 起こし直す前に必ず通す
    ///
    /// 同じ CardId で作り直すとき、これを飛ばすと2つの壊れ方が同時に起きる。
    ///
    /// 1. **古い claude が孤児になる。** `sessions` への登録は `insert` なので古い
    ///    `Arc<Session>` は表から消えるが、`coalesce_loop` が同じ `Arc` を握ったままで
    ///    参照数が 0 にならず、[`PtyProcess`] の `Drop`（＝`kill`）が走らない。表から
    ///    引けないので `kill` も `archive` も届かず、**画面から止める手段が無くなる**
    /// 2. **古いトークンが新しいカードを塗り替える。** [`SessionManager::resolve_token`]
    ///    は token → card_id → `get()` なので、古い合言葉が**新しい**セッションを引く。
    ///    古い claude のフックと `statusLine` が、復旧したカードの状態とモデルを
    ///    書き換えることになる（症状は「復旧したのに、たまに前の状態に戻る」）
    ///
    /// さらに、フック設定の置き場所は `<一時領域>/agentdashboard/<card_id>/` で
    /// **カードIDが鍵**である（[`hooks_settings::write`]）。畳むほうが後になると、
    /// [`hooks_settings::cleanup`] が**書いたばかりの settings をディレクトリごと消す**。
    ///
    /// # 居なければ何もしない
    ///
    /// PC が起き直して記録を失った場合はこちらが普通である（サーバの記録にはカードが
    /// 残っているが、この PC の表には無い）。`None` を返して終わる。
    fn fold(&self, card_id: CardId) -> Option<Arc<Session>> {
        let session = self
            .sessions
            .lock()
            .expect("ロックが壊れていない")
            .remove(&card_id)?;

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
        self.stop_watching_transcript(card_id);
        Some(session)
    }

    /// カードを一覧から消す。生きていれば先に終了させる。
    pub fn archive(&self, card_id: CardId) -> Result<(), SessionError> {
        self.fold(card_id).ok_or(SessionError::NotFound(card_id))?;
        // **配るのはこちらだけ。** 復旧は同じ本体を通るが、ここを配ると
        // 起こし直すつもりのカードが画面から消えてしまう（設計§7-1）
        self.events.emit(ServerMessage::SessionRemoved { card_id });
        Ok(())
    }

    /// 起こし直しの権利を1つ取る（接続断のカードを復旧ボタンで戻す 設計§8-2）。
    ///
    /// **同期であることが要点。** 呼び出し側（`link.rs` の `apply_command`）は接続ループの
    /// `select!` の中から同期で呼ばれるので、ここで待つと他のカードへの指示も履歴の
    /// 送り出しも止まり、無通信が続くとサーバから切られる。**印だけを立てて、待つのは
    /// 切り離した先**（[`SessionManager::revive`]）でやる。
    ///
    /// 印を立てるのを切り離した後にすると、**切り離した2つが同時に印を見て両方通る**
    /// （設計§8-3）。順序を守るために、こちらを同期の `fn` にしてある。
    ///
    /// 既に起こし直している最中なら `None`。**待ち行列に並ばせない**——同じカードが
    /// 2つ並ぶと、席が空いたときに両方とも通る（設計§8-1）。
    pub fn begin_revive(self: &Arc<Self>, card_id: CardId) -> Option<ReviveInFlight> {
        self.reviving
            .lock()
            .expect("ロックが壊れていない")
            .insert(card_id)
            .then(|| ReviveInFlight {
                manager: Arc::clone(self),
                card_id,
            })
    }

    /// 抜け殻のカードを、元の CLI セッションで起こし直す（設計§7・§8）。
    ///
    /// `in_flight` を引数で受けるのは、**印が既に立っていることを型で示す**ため。
    /// [`SessionManager::begin_revive`] を通らずにここへ来る道を作れない。
    ///
    /// # 席は「立ち上がりきる」まで持つ
    ///
    /// 擬似ターミナルを起こす処理は一瞬で返る（プロセスを産むだけ）ので、そこで席を
    /// 返すと上限が事実上効かない——1本あたり 1190MB を食うのは、そのあと CLI が
    /// 立ち上がっていく区間である。**カードが [`SessionStatus::Starting`] を抜けるまで**
    /// ＝最初のフックが届くまでを1本と数える（設計§8-5）。
    ///
    /// 天井（[`REVIVE_SETTLE`]）を置くのは、フックが1件も来ないセッションが席を
    /// 占め続けるのを防ぐため。落ちた場合も `Ended` になって `Starting` を抜けるので、
    /// そちらは天井を待たない。
    pub async fn revive(
        self: &Arc<Self>,
        in_flight: ReviveInFlight,
        cwd: &str,
        mode: Option<PermissionMode>,
        claude_session_id: ClaudeSessionId,
    ) -> Result<Arc<Session>, SessionError> {
        let card_id = in_flight.card_id;
        // 席が空くまで待つ。**ここは切り離されたタスクの中**なので、待っても他の指示は
        // 止まらない（設計§8-3）
        let seat = Arc::clone(&self.revive_slots)
            .acquire_owned()
            .await
            .expect("席の口を閉じていない");

        // **床は席を取った直後に見る**（設計§18-3）。順序はコンパイラが見張っている
        // ——`reserve_memory` は席を引数に取るので、前へ動かすと通らない。
        //
        // 畳むより先に見るのは、**畳んでから断ると、そのカードの実体だけを失う**ため。
        //
        // 通ったら1枚ぶん予約が返る。**この先で失敗したら、そこで落ちて枠が返る**
        // （RAII。60秒ぶん多く見積もったまま残さない）
        let reservation = match self.reserve_memory(&seat) {
            Ok(reservation) => reservation,
            Err(refusal) => {
                tracing::warn!(%card_id, "{refusal}");
                return Err(refusal);
            }
        };

        // **必ず起こす前に畳む**（設計§7-1）。理由は [`SessionManager::fold`] に書いてある
        if self.fold(card_id).is_some() {
            tracing::info!(%card_id, "起こし直す前に、古い実体を畳みました");
        }

        let args = lifecycle::permission_mode_args(mode.as_ref());
        let session = self.spawn_as(
            card_id,
            cwd,
            lifecycle::SessionStart::Resume(claude_session_id),
            &args,
            mode,
            // **こちらがどのセッションを指定したかを知っている**ので、先に入れておく
            // （設計§7-3）。フックが1件も届かないまま失敗しても戻す先を失わない
            Some(claude_session_id),
        )?;

        // 立ち上がりきるまで席と印を持つ見張りを、**切り離してから**返す。
        //
        // ここで待ってから返すと、頼んだ側（`link.rs` の切り離したタスク）が
        // 立ち上がりきるまで戻ってこない。返り値を待つ相手は居ないので実害は無いが、
        // **「起こせた」と「立ち上がりきった」は別の出来事**なので分けておく。
        //
        // 印も一緒に持つ。席だけ返すと、立ち上がり中のカードへ2回目の頼みが通る。
        //
        // **メモリの予約は、席より長く持つ**（設計§19）。席を返すのは「立ち上がった」
        // 時点だが、メモリが載りきるのはそのあとである。
        tokio::spawn({
            let session = Arc::clone(&session);
            async move {
                let reservation = reservation;
                {
                    // **印は席と同じ寿命。** ここを予約に合わせて延ばすと、立ち上がりきった
                    // カードが「まだ復旧中です」と断られ続ける（設計§8-2 の目的から外れる）
                    let _in_flight = in_flight;
                    let _seat = seat;
                    let deadline = tokio::time::Instant::now() + REVIVE_SETTLE;
                    while session.status() == SessionStatus::Starting {
                        if tokio::time::Instant::now() >= deadline {
                            tracing::warn!(
                                card_id = %session.card_id,
                                "{REVIVE_SETTLE:?} 経ってもフックが届かないので、席を返します"
                            );
                            break;
                        }
                        tokio::time::sleep(REVIVE_STEP).await;
                    }
                }
                // ここで席は返っている。**予約だけを、メモリが載りきるまで持ち続ける。**
                //
                // **終わったセッションは待たない。** 死んだプロセスはメモリを持って
                // いないので、枠を握り続ける理由が無い（起こし直しに失敗して即座に
                // 落ちた場合が、まさにこれに当たる）。
                if reservation.is_some() {
                    let deadline = tokio::time::Instant::now() + REVIVE_MEMORY_SETTLE;
                    while tokio::time::Instant::now() < deadline {
                        if matches!(session.status(), SessionStatus::Ended { .. }) {
                            break;
                        }
                        tokio::time::sleep(REVIVE_STEP).await;
                    }
                }
                drop(reservation);
            }
        });
        Ok(session)
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
        // `SessionEnd` は「会話が終わった」までしか言えない。**死んだプロセスはフックを
        // 出さない**ので、それ以外が1件届いたことが、そのまま「まだ生きている」の証拠になる。
        // 理由の綴りにも、到着順にも依らない
        match input.event {
            state::HookEvent::SessionEnd => session.report_end(input.end_reason()),
            other => session.clear_end_report(other),
        }
        let (changed, new_transcript) = session.apply_hook(input);
        // JSONL の場所が分かった／変わった時点でパーサへ監視を頼む。resume で別ファイルに
        // なった場合も同じ経路で張り替わる（設計§6）
        if let Some(learned) = new_transcript {
            let TranscriptLearned { path, switched } = learned;
            // **乗り換えなら、張り替える前に捨てる。** ターミナルの中で `/resume` や
            // `/clear` を打つと claude は別の JSONL へ移るが、それまでに積んだ木を
            // 捨てないと**1枚のカードに2つのセッションのノードが積み上がる**
            // （実測：混入 1,963件。利用者からは「隣のカードのログが出る」と見える）。
            //
            // **初回は捨ててはいけない。** 起こし直すと `transcript_path` は `None` へ
            // 戻るので、**最初のフックは必ず「新しい場所」に見える**——ここで捨てると
            // **再起動のたびに全カードの履歴が消える**
            if switched {
                tracing::info!(
                    card_id = %session.card_id,
                    %path,
                    "履歴の場所が変わったので、それまでの木を捨てます"
                );
                self.report_transcript_reset(session.card_id);
            }
            match self.parser.lock().expect("ロックが壊れていない").as_ref() {
                Some(parser) => {
                    tracing::info!(
                        card_id = %session.card_id,
                        %path,
                        switched,
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

    /// そのカードの履歴の監視を**止める**（イシュー設計§4-2 の3）。
    ///
    /// 溜まりが上限を超えたカードを畳んだときに呼ぶ。`ParserRequest::Unwatch` は
    /// **読み位置を捨てる（`offsets.forget()`）ことも兼ねている**ので、これ1つで
    /// 「位置を捨てる」段（設計§1-2 の1段目）が済む。
    ///
    /// **止めないと、切断が続いている間に同じ量がまた溜まる**（設計§4-4）。畳んだ
    /// そばから読み直すと、畳んでは読み直す輪になる。
    pub fn stop_watching_transcript(&self, card_id: CardId) {
        if let Some(parser) = self.parser.lock().expect("ロックが壊れていない").as_ref() {
            parser.unwatch(card_id);
        }
    }

    /// そのカードの履歴を**頭から読み直してもらう**（イシュー設計§4-2 の5）。
    ///
    /// 畳んだカードの `TranscriptReset` に ack が返った時点で呼ぶ。位置は
    /// [`SessionManager::stop_watching_transcript`] で捨ててあるので、`watch` を
    /// 頼み直せばパーサは JSONL の頭から読む——止めていた間に書き足されたぶんも
    /// 一緒に届く（設計§4-4）。
    ///
    /// 頼む形は [`SessionManager::handle_hook`] の監視依頼とまったく同じにしてある。
    /// **パーサが繋がっていないときに黙らない**ところまで揃えないと、構造化ビューだけが
    /// 永久に空のまま残り、利用者からは原因が見えない。
    ///
    /// # 戻り値は「実際に頼んだ場所」
    ///
    /// 頼めなかったとき（カードが外された／まだ JSONL の場所を名乗っていない／パーサが
    /// 繋がっていない）は `None` を返す。**遷移の1行を出すのは呼ぶ側**で、頼めていない
    /// のに「頼みました」と残ると、後からログを読む人が原因を1つ取り違える。
    pub fn rewatch_transcript(&self, card_id: CardId) -> Option<String> {
        // 畳んだあとに外されたカード／まだ場所を名乗っていないカードは、読み直す先が無い。
        // 後者は次のフックで監視が張られるので、ここで何もしなくても履歴は出る
        let path = self.get(card_id)?.transcript_path()?;
        match self.parser.lock().expect("ロックが壊れていない").as_ref() {
            Some(parser) => {
                parser.watch(card_id, path.clone());
                Some(path)
            }
            None => {
                tracing::warn!(
                    %card_id,
                    %path,
                    "パーサが繋がっていないため読み直しを頼めません"
                );
                None
            }
        }
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

    /// CLI が付けたセッションの名前を控えて、カード1枚を配り直す（設計§4・§13）。
    ///
    /// # 門をここ1枚にしている理由
    ///
    /// ノードの報告は門を2枚持っている（受け口の `watched` と、ここの `get`）が、
    /// **名前は「どこまで読んだか」の持ち主に依存しない**ので1枚で足りる。
    /// [`Self::report_transcript_reset`] と同じ形にしてある。
    ///
    /// 外した直後に届いたぶんで一覧を汚さないのが、この門の役目。
    pub fn report_session_title(&self, card_id: CardId, title: String) {
        let Some(session) = self.get(card_id) else {
            return;
        };
        // **「初めて付いた」を、控える前に読む。** 控えたあとでは区別が付かない
        let first = session.meta().session_title.is_none();
        if !session.store_session_title(title) {
            // 同じ題。配り直しも記録もしないので、行も出さない（設計§13）
            return;
        }
        if first {
            tracing::info!(card_id = %card_id, "セッションの名前が付きました");
        } else {
            tracing::debug!(card_id = %card_id, "セッションの名前が変わりました");
        }
        self.broadcast_meta(&session);
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

    /// 擬似ターミナルが終わったことを、**その実体自身へ**反映する。
    ///
    /// # カードIDから引き直してはいけない
    ///
    /// 起こし直し（[`SessionManager::revive`]）は**同じ CardId に別の実体を載せ直す**ので、
    /// `self.get(card_id)` で引くと、畳んだ古い擬似ターミナルの終了が
    /// **新しい実体へ届く**。復旧したばかりのカードが即座に終了扱いになり、しかも
    /// 原因は「前の claude が終わったこと」なので、まず辿れない。
    ///
    /// 起こす側が自分の [`Arc<Session>`] を渡す形にして、引き直す道を塞いである。
    fn on_exit(&self, session: &Arc<Session>, exit: PtyExit) {
        let card_id = session.card_id;
        // 申告はここで取り出して消す。**`meta` を取る前に済ませる**（器のロックは他と
        // 跨がない約束）。下の早期 return を通ると取り出したぶんは捨てられるが、そこは
        // 終了が二重に届いたときしか通らない
        let reported = session.take_end_report();
        {
            let mut meta = session.meta.lock().expect("ロックが壊れていない");
            // 終了は oneshot で1回だけ届くので二重には来ない。防御として残す
            if matches!(meta.status, SessionStatus::Ended { .. }) {
                return;
            }
            // **終わったと言えるのはプロセスだけ。** フックの申告は材料の1つとしてしか
            // 使わない。「異常終了」と出してよいのは、誰も終わりを意図していなかったとき
            // だけである——ダッシュボードから終了させた場合は強制終了なので終了コードが
            // 非ゼロになり、CLI が自分で終わりを名乗った場合も落ちたわけではない
            let ok = exit.ok || session.expected_exit.load(Ordering::SeqCst) || reported.is_some();
            meta.status = SessionStatus::Ended { ok };
            meta.last_activity_at = now_ms();
        }
        // **報告してよいのは、いま表に載っている実体だけ。** 畳まれた古い実体の終了を
        // 配ると、同じ札で「終了」が飛び、起こし直したばかりのカードが終了扱いになる。
        // 自分の meta を直すところまでは通す——あの実体は本当に終わっているので、
        // 後から覗いた人へ嘘をつかないほうがよい
        if self
            .get(card_id)
            .is_some_and(|live| Arc::ptr_eq(&live, session))
        {
            self.broadcast_meta(session);
        }
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

    /// 断りの文に**連続した半角スペースが無い**こと（コードレビュー対応5）。
    ///
    /// 改行継続の `\` を書き忘れると、ソースの字下げがそのまま本文へ入る。
    /// **画面のカードとログにそのまま出る**ので、目で見るまで誰も気づかない
    /// （実際、`cat -A` で見つかるまで出荷されていた）。
    ///
    /// 綴りではなく**組み立てた結果**を見る。`#[error(..)]` の中身を検査すると、
    /// 継続の書き方を変えただけで落ちる——確かめたいのは書き方ではなく、出る文である。
    #[test]
    fn 断りの文に連続した半角スペースを混ぜない() {
        let 文 = SessionError::OutOfMemory {
            available_mb: 2500,
            estimate_mb: 1000,
            headroom_mb: 2000,
        }
        .to_string();

        assert!(
            !文.contains("  "),
            "連続した半角スペースが入っている（継続の `\\` が落ちている）: {文:?}"
        );
        // 数を添えるという約束（型の doc）も、ここで一緒に固定する
        assert!(文.contains("2500"), "空きの数が出ていない: {文:?}");
    }

    /// 端末への書き込みは、声を持つ口だけを通ること（設計§10-3）。
    ///
    /// 送出の失敗に声を与えたのは `send_key` / `send_instruction` /
    /// `switch_permission_mode` の3つ。**直に呼ぶ道を増やすと、そこだけがまた
    /// 無音になる**——しかも「送ったのに効かない」という、いちばん理由の見えない形で。
    ///
    /// 到達可能性ではなく**綴りそのもの**を見るのは、`write_input` が公開の口で
    /// あり続ける必要があるため（`crate::link` のブラウザの打鍵が通る）。
    #[test]
    fn 印を探す窓はフッタ読みより厚い() {
        // `RingBuffer::since` は目印より後が上限を超えると**古いほうから捨てる**。
        // 印は貼り付けの直後（＝窓の先頭側）に出るので、フッタと同じ厚さだと
        // **送信のあいだに流れた出力に押し出される**（添付できているのに断られる）
        assert!(
            ATTACHMENT_TAIL > FOOTER_TAIL,
            "印の窓がフッタ読みと同じかそれより薄い"
        );
        // フッタ側は**毎秒回る見張り**なので厚くしない。値ごと固定する
        assert_eq!(FOOTER_TAIL, 32 * 1024);
    }

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

    /// 申告は1回しか取り出せない。**取り出したら空になる。**
    ///
    /// 取り出すのは終了の確定（`on_exit`）で、そこは1本につき1回しか通らない。
    /// 残ってしまうと、次に立てた申告と見分けが付かなくなる。
    #[test]
    fn 申告は立てて取り出すと消える() {
        let cell = EndReportCell::default();
        cell.report(1_000, Some("resume".to_owned()));

        let taken = cell.take().expect("立てた申告が取り出せること");
        assert_eq!(taken.at, 1_000);
        assert_eq!(taken.reason.as_deref(), Some("resume"));

        assert!(cell.take().is_none(), "2度目は空であること");
    }

    /// 取り消しは**空振りしてよい**。
    ///
    /// 申告が立っていないセッションにもフックは届き続けるので、ここが騒ぐと
    /// 1件ごとに何かをすることになる。
    #[test]
    fn 立っていない申告を取り消しても何も起きない() {
        let cell = EndReportCell::default();

        assert!(cell.clear().is_none(), "立てていないので何も返らないこと");
        assert!(
            cell.take().is_none(),
            "取り消しても状態は空のままであること"
        );
    }

    /// 猶予の**境目の直前では下ろさない**。
    ///
    /// 早く下ろすと、終了処理に手間取っている CLI の終了が「誰も意図していない異常終了」
    /// として出る。境目そのものは「過ぎた」に含めない。
    #[test]
    fn 猶予の境目までは申告を残す() {
        let cell = EndReportCell::default();
        cell.report(1_000, None);

        assert!(
            cell.take_older_than(1_000, 1).is_none(),
            "経っていないので残ること"
        );
        assert!(
            cell.take_older_than(2_000, 1).is_none(),
            "境目ちょうどでは残ること"
        );
        assert!(
            cell.take().is_some(),
            "残っていた申告は、まだ器の中にあること"
        );
    }

    /// 猶予を過ぎたら下ろす。**下ろしたら空になる。**
    #[test]
    fn 猶予を過ぎた申告は下ろされる() {
        let cell = EndReportCell::default();
        cell.report(1_000, Some("clear".to_owned()));

        let taken = cell
            .take_older_than(2_001, 1)
            .expect("猶予を過ぎたら取り出せること");
        assert_eq!(taken.reason.as_deref(), Some("clear"));

        assert!(
            cell.take_older_than(9_999, 1).is_none(),
            "下ろしたあとは空であること"
        );
    }
}
