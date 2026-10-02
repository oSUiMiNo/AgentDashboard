//! メモリが返ったかを、出来事の前後で記録する（寝ているカードばかりなのに、メモリ不足で
//! セッションを起こせない 設計§25）。
//!
//! # なぜ出来事の前後なのか
//!
//! Windows へメモリが返るのは WSL と Hyper-V が裏でやることで、**アプリには知らせが来ない**。
//! 「返った瞬間」は拾えないので、返るきっかけになりうる出来事（版の入れ替え・カードを寝かせる・
//! 一覧から外す）の直前に1回、その後に間をあけて3回測り、1回につき1行（`kind=memory_watch`）
//! 残す。「出来事から何分後に、何 GB 返ったか」が `agentdashboard logs` で読める。
//!
//! ```text
//! 出来事 ──┬─ before（直前）
//!          ├─ after_30s
//!          ├─ after_2m
//!          └─ after_10m   ← ここで系列が終わる
//! ```
//!
//! # 待たない
//!
//! Windows を聞くのは1回あたり約1秒、逼迫時は最大 27 秒かかる（実測）。**寝かせる・止める
//! 処理はその答えを待たない**——WSL の中の量（`/proc/meminfo`。数十マイクロ秒）だけを止める
//! 直前にその場で読み、Windows 側は裏のタスクで聞く。したがって `before` の Windows の欄は
//! **止める合図を出した少し後**の量で、どれだけ後かは `probe_ms` に出る。
//!
//! 版の入れ替えだけは、入れ替えた瞬間にこのプロセスが消えるので裏へ回せない。入れ替える直前の
//! 処理の中で聞き、[`SWAP_BEFORE_WAIT`] を過ぎたら Windows の欄を空欄にして入れ替えへ進む。
//!
//! # 束ねる
//!
//! 自動スリープはカードを続けて寝かせるので、出来事ごとに測ると `powershell.exe` が出来事の数
//! だけ立つ。**系列が走っている間の出来事は、その系列の数（`events`）に足すだけ**にし、新しい
//! 系列も測りも始めない。測る時点は系列を始めた出来事から数え、後の出来事では数え直さない
//! （数え直すと、寝かせ続ける間ずっと後ろへずれて、いつまでも測らない）。
//!
//! # 版の入れ替えをまたぐ
//!
//! 入れ替える直前に測った数を**印**（`<state_dir>/memory-watch-attempt`）に書いてから
//! 入れ替える。起き直った側がその印を拾って消し、**直前の行を書き残してから**残りの時点を
//! 測る（[`crate::version`] の `version-attempt` と同じ作法）。
//!
//! 直前の行を入れ替える前に書かないのは、ログが**非同期で**ファイルへ書かれるため
//! （[`crate::logging`]）。`exec` は後片付けを走らせないので、直前に出した行は書かれる前に
//! 消えうる。印に数を持たせれば、入れ替えた後のプロセスが確実に書ける。

use crate::resources::{HOST_FREE_TIMEOUT, POWERSHELL, WslSense, is_wsl, short_reason};
use crate::session::now_ms;
use protocol::{CardId, Timestamp};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// 版の入れ替えをまたぐ印の名前。
///
/// [`crate::version`] の `version-attempt`・[`crate::compact`] の `compact-attempt` に揃えてある
/// ——**打つ直前に書き、起き直った側が拾って消す**印は、同じ `<state_dir>` で同じ名付けにする。
pub const MEMORY_WATCH_ATTEMPT: &str = "memory-watch-attempt";

/// 入れ替える直前の測りで、Windows 側の答えを待つ上限（設計§25-3）。
///
/// 普段は約1秒で返る。**逼迫しているときほど遅い**（最大 27 秒の実測）が、そのときこそ
/// 利用者は入れ替えでメモリを空けたいので、入れ替えを待たせない側を採る。
pub const SWAP_BEFORE_WAIT: Duration = Duration::from_secs(3);

/// 出来事の後に測る時点と、系列を始めた出来事からの間（設計§25-3）。
pub const AFTER_STEPS: [(Step, Duration); 3] = [
    (Step::After30s, Duration::from_secs(30)),
    (Step::After2m, Duration::from_secs(2 * 60)),
    (Step::After10m, Duration::from_secs(10 * 60)),
];

/// 入れ替えの印がこれより古ければ捨てる。**最後の時点（10 分）＋1 分。**
///
/// 入れ替えた後のプロセスが起きられずに時間が経ち、後で起きたとき、10 分を過ぎた出来事の
/// 「30 秒後」を測っても、その出来事の前後の比べにならない。
pub const MARK_STALE_AFTER: Duration = Duration::from_secs(11 * 60);

/// 知らせ（[`MemoryWatch::subscribe`]）の溜め。**聞き手は試験だけ**なので小さくてよい。
const SAMPLE_QUEUE: usize = 64;

/// 系列の名前の長さ（16進）。ログで目で追える長さにする。
const SERIES_ID_LEN: usize = 12;

/// 何の出来事か（ログの `event`）。
///
/// **画面の「スリープ」と CLI の `session kill` は、PC には同じ頼み（`Kill`）で届く**ので
/// 区別できない。カードが残って寝る出来事なので、どちらも [`Event::SessionSleep`] に数える。
/// [`Event::SessionKill`] は一覧から外す（`session rm`）ときである（設計§25-4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    /// 版の入れ替え
    VersionSwap,
    /// 自動スリープ・手でスリープ（＝終了の頼み）
    SessionSleep,
    /// 一覧から外す
    SessionKill,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VersionSwap => "version_swap",
            Self::SessionSleep => "session_sleep",
            Self::SessionKill => "session_kill",
        }
    }
}

/// 出来事の何回目の測りか（ログの `step`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Before,
    After30s,
    After2m,
    After10m,
}

impl Step {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After30s => "after_30s",
            Self::After2m => "after_2m",
            Self::After10m => "after_10m",
        }
    }
}

// ---------------------------------------------------------------------------
// WSL の中

/// WSL の中の量（MB）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Inside {
    /// すぐ使える空き（`MemAvailable`）
    pub available_mb: u64,
    /// キャッシュを除いた空き（`MemFree`）
    pub free_mb: u64,
    /// ファイルのキャッシュ（`Cached`＋`Buffers`）。**Windows へ返らない分の大半はここにいる**
    pub cached_mb: u64,
}

/// `/proc/meminfo` の本文から3つを取り出す。**外の世界へ出ない純関数。**
///
/// `MemAvailable`・`MemFree`・`Cached` が欠けたら `None`（半分だけ読めた値を残さない）。
/// `Buffers` は欠けても 0 として足す。
pub fn parse_inside(text: &str) -> Option<Inside> {
    let field = |name: &str| crate::resources::meminfo_kb(text, name);
    Some(Inside {
        available_mb: field("MemAvailable")? / 1024,
        free_mb: field("MemFree")? / 1024,
        cached_mb: (field("Cached")? + field("Buffers").unwrap_or(0)) / 1024,
    })
}

/// WSL の中を読む口。**トレイトにしてあるのはテストのため**（[`crate::resources::Probe`] と同じ）。
pub trait InsideProbe: Send + Sync + std::fmt::Debug {
    /// 読めなければ `None`。**読めないことは異常ではない**（Linux 以外）。
    fn read(&self) -> Option<Inside>;
}

/// 本物。`/proc/meminfo` を読む。
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcInside;

impl InsideProbe for ProcInside {
    fn read(&self) -> Option<Inside> {
        parse_inside(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }
}

// ---------------------------------------------------------------------------
// Windows 側

/// Windows 側の量（MB）。**聞けなかった欄は空欄で、理由が `error` に入る。**
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Outside {
    /// Windows の空き（`FreePhysicalMemory`）
    pub host_free_mb: Option<u64>,
    /// `VmmemWSL` 自体の常駐量（`WorkingSet64`）
    pub vmmem_mb: Option<u64>,
    /// 聞けなかった欄の理由（ログの `host_error`）
    pub error: Option<String>,
}

impl Outside {
    /// 何も聞けなかった。
    pub fn failed(reason: String) -> Self {
        Self {
            host_free_mb: None,
            vmmem_mb: None,
            error: Some(reason),
        }
    }
}

/// `powershell.exe` に渡す1行。**空きと常駐量を1回の呼び出しで聞く**（2回に分けると倍かかる）。
///
/// `VmmemWSL` が無い（WSL1・古い WSL2 は `vmmem`）ときは `vmmem_bytes=` が空で返る。
/// 管理者でなくても常駐量は読める（2026-10-02 に実機で確かめた）。
const OUTSIDE_SCRIPT: &str = "$os = Get-CimInstance Win32_OperatingSystem; \
     $p = Get-Process -Name VmmemWSL -ErrorAction SilentlyContinue | Select-Object -First 1; \
     \"free_kb=$($os.FreePhysicalMemory)\"; \
     \"vmmem_bytes=$(if ($p) { $p.WorkingSet64 })\"";

/// [`OUTSIDE_SCRIPT`] の答えを読む。**外の世界へ出ない純関数。**
///
/// **単位が2つある。** 空き（`FreePhysicalMemory`）は kB、常駐量（`WorkingSet64`）はバイト。
/// 取り違えると 1024 倍ずれる。
pub fn parse_outside(text: &str) -> Outside {
    let value = |key: &str| {
        text.lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('=').map(str::trim))
    };
    let mut errors = Vec::new();
    let host_free_mb = match value("free_kb") {
        Some(kb) => match kb.parse::<u64>() {
            Ok(kb) => Some(kb / 1024),
            Err(_) => {
                errors.push(format!(
                    "Windows の空きを数として読めませんでした: {}",
                    short_reason(kb, "（空）")
                ));
                None
            }
        },
        None => {
            errors.push(format!(
                "Windows の空きが答えにありませんでした: {}",
                short_reason(text, "（空）")
            ));
            None
        }
    };
    let vmmem_mb = match value("vmmem_bytes") {
        Some("") => {
            errors.push("VmmemWSL のプロセスが見つかりませんでした".to_string());
            None
        }
        Some(bytes) => match bytes.parse::<u64>() {
            Ok(bytes) => Some(bytes / 1024 / 1024),
            Err(_) => {
                errors.push(format!(
                    "VmmemWSL の常駐量を数として読めませんでした: {}",
                    short_reason(bytes, "（空）")
                ));
                None
            }
        },
        None => {
            errors.push("VmmemWSL の常駐量が答えにありませんでした".to_string());
            None
        }
    };
    Outside {
        host_free_mb,
        vmmem_mb,
        error: (!errors.is_empty()).then(|| errors.join("／")),
    }
}

/// Windows 側を聞く口。**同期で書いてある**——呼ぶのは裏の糸の中なので、寝かせる・止める
/// 処理は待たない。**トレイトにしてあるのはテストのため**（答えを止めた偽物で「待たない」を
/// 確かめる）。
pub trait OutsideProbe: Send + Sync + std::fmt::Debug {
    fn read(&self) -> Outside;
}

/// 本物。`powershell.exe` を1回立てる。打ち切りは起こし直しの判定と同じ 30 秒。
#[derive(Debug, Clone, Copy, Default)]
pub struct PowerShellOutside;

impl OutsideProbe for PowerShellOutside {
    fn read(&self) -> Outside {
        let outcome = crate::proc::run(
            std::process::Command::new(POWERSHELL).args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                OUTSIDE_SCRIPT,
            ]),
            HOST_FREE_TIMEOUT,
        );
        if !outcome.success {
            return Outside::failed(short_reason(
                outcome.output.trim(),
                "powershell.exe が失敗しました",
            ));
        }
        parse_outside(&outcome.output)
    }
}

// ---------------------------------------------------------------------------
// 測りの系列

/// 1回の測り。1つが1行のログになる。**試験はこれを知らせで受け取る**（[`MemoryWatch::subscribe`]）。
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    /// 系列の名前。同じ出来事の測りは同じ名前を持つ
    pub series: String,
    /// 系列を始めた出来事
    pub event: Event,
    pub step: Step,
    /// 系列に束ねた出来事の数（`session_sleep:2,session_kill:1`）
    pub events: String,
    /// 系列を始めた出来事からの経過
    pub elapsed_ms: u64,
    /// WSL の中。読めなければ `None`
    pub inside: Option<Inside>,
    /// Windows 側。**WSL でなければ `None`**（聞かない）
    pub outside: Option<Outside>,
    /// Windows を聞くのにかかった時間
    pub probe_ms: Option<u64>,
    /// 生きている claude の本数
    pub live_sessions: Option<usize>,
    /// 系列を始めたカード
    pub card_id: Option<CardId>,
    /// 版の入れ替えで打ち切った系列（入れ替えの直前の行だけ）
    pub cut_series: Option<String>,
    /// 入れ替えをまたいで運んだ測りの、測った時刻（入れ替えの直前の行だけ）
    pub measured_at_ms: Option<Timestamp>,
}

/// 走っている系列。**同時に1本だけ。**
#[derive(Debug)]
struct Running {
    id: String,
    event: Event,
    card_id: Option<CardId>,
    /// 束ねた出来事の数。**現れた順**に並べる
    counts: Vec<(Event, u32)>,
}

impl Running {
    fn new(id: String, event: Event, card_id: Option<CardId>) -> Self {
        Self {
            id,
            event,
            card_id,
            counts: vec![(event, 1)],
        }
    }

    fn add(&mut self, event: Event) {
        match self.counts.iter_mut().find(|(seen, _)| *seen == event) {
            Some((_, count)) => *count = count.saturating_add(1),
            None => self.counts.push((event, 1)),
        }
    }

    fn events(&self) -> String {
        self.counts
            .iter()
            .map(|(event, count)| format!("{}:{count}", event.as_str()))
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// 入れ替えをまたいで運ぶ印（`<state_dir>/memory-watch-attempt`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
struct SwapMark {
    series: String,
    /// 測った時刻（エポックミリ秒）。**系列の起点**——入れ替えた後の時点はここから数える
    at: Timestamp,
    inside: Option<Inside>,
    outside: Option<Outside>,
    probe_ms: Option<u64>,
    live_sessions: Option<usize>,
    cut_series: Option<String>,
}

/// 直前の測りの出どころ。
enum Before {
    /// いま止める出来事の直前に読んだ WSL の中。Windows 側はこれから聞く
    Fresh {
        inside: Option<Inside>,
        live_sessions: Option<usize>,
    },
    /// 入れ替える前のプロセスが測って印に書いたもの
    Carried(SwapMark),
}

/// 測った数の組。
struct Measured {
    inside: Option<Inside>,
    outside: Option<Outside>,
    probe_ms: Option<u64>,
    live_sessions: Option<usize>,
}

type LiveCount = Arc<dyn Fn() -> Option<usize> + Send + Sync>;

/// 出来事の前後を測る一式（設計§25）。**セッションを抱える機械ごとに1つ**（`SessionManager` が持つ）。
pub struct MemoryWatch {
    inside: Arc<dyn InsideProbe>,
    /// Windows 側を聞く口。**WSL でなければ `None`**（Windows の欄を書かない）
    outside: Option<Arc<dyn OutsideProbe>>,
    running: Mutex<Option<Running>>,
    /// 生きている claude を数える口。器（`SessionManager`）が自分を弱い参照で渡す
    live: Mutex<Option<LiveCount>>,
    samples: broadcast::Sender<Sample>,
}

impl std::fmt::Debug for MemoryWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryWatch")
            .field("inside", &self.inside)
            .field("outside", &self.outside)
            .field("running", &self.走っている系列())
            .finish_non_exhaustive()
    }
}

impl MemoryWatch {
    /// 材料を全部渡して作る。**テストの入口でもある。**
    pub fn new(inside: Arc<dyn InsideProbe>, outside: Option<Arc<dyn OutsideProbe>>) -> Arc<Self> {
        Arc::new(Self {
            inside,
            outside,
            running: Mutex::new(None),
            live: Mutex::new(None),
            samples: broadcast::channel(SAMPLE_QUEUE).0,
        })
    }

    /// 実機から作る。**WSL の中に居るときだけ Windows 側を聞く**（[`is_wsl`]。箱の中では聞かない）。
    pub fn from_env() -> Arc<Self> {
        let outside =
            is_wsl(&WslSense::read()).then(|| Arc::new(PowerShellOutside) as Arc<dyn OutsideProbe>);
        Self::new(Arc::new(ProcInside), outside)
    }

    /// 生きている claude を数える口を渡す。
    pub fn set_live_count(&self, live: LiveCount) {
        *self.live.lock().expect("ロックが壊れていない") = Some(live);
    }

    /// 測りを1回ごとに受け取る（**テスト専用**）。
    #[doc(hidden)]
    pub fn subscribe(&self) -> broadcast::Receiver<Sample> {
        self.samples.subscribe()
    }

    /// 走っている系列の名前（**テスト専用**）。
    #[doc(hidden)]
    pub fn 走っている系列(&self) -> Option<String> {
        self.running
            .lock()
            .expect("ロックが壊れていない")
            .as_ref()
            .map(|running| running.id.clone())
    }

    /// 寝かせる・止める**直前に**呼ぶ。**待たない**（WSL の中を読むだけで戻る）。
    ///
    /// 系列が走っていれば、その数に足すだけで何も測らない（モジュールの説明「束ねる」）。
    pub fn note(self: &Arc<Self>, event: Event, card_id: Option<CardId>) {
        if self.join_running(event) {
            return;
        }
        // **止める前のいまここで読む。** 裏へ回すと、claude が終わって WSL の中で空いた後の
        // 量を「直前」として残しうる
        let inside = self.inside.read();
        if inside.is_none() && self.outside.is_none() {
            tracing::debug!(
                kind = "memory_watch",
                event = event.as_str(),
                "この機械ではメモリの量を読めないので、出来事の前後を測りません"
            );
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::debug!(
                kind = "memory_watch",
                event = event.as_str(),
                "非同期の実行環境の外で呼ばれたので、出来事の前後を測りません"
            );
            return;
        };
        let live_sessions = self.live_count();
        let id = {
            let mut running = self.running.lock().expect("ロックが壊れていない");
            // 読んでいる間に、別の出来事が系列を始めていたら束ねる
            if let Some(running) = running.as_mut() {
                running.add(event);
                return;
            }
            let id = new_series_id();
            *running = Some(Running::new(id.clone(), event, card_id));
            id
        };
        let anchor = tokio::time::Instant::now();
        handle.spawn(Arc::clone(self).run(
            id,
            anchor,
            Before::Fresh {
                inside,
                live_sessions,
            },
        ));
    }

    /// 版を入れ替える**直前に**呼ぶ。測った数を印に書く（**行はここでは書かない**——モジュールの
    /// 説明「版の入れ替えをまたぐ」）。Windows の答えは `wait` まで待ち、過ぎたら空欄にする。
    ///
    /// 走っている系列はここで打ち切る（この後プロセスごと入れ替わるので、続きを測れない）。
    /// 打ち切った系列の名前は印に書き、入れ替えの直前の行の `cut_series` に出す。
    pub fn before_swap(&self, state_dir: &Path, wait: Duration) {
        let cut_series = self
            .running
            .lock()
            .expect("ロックが壊れていない")
            .take()
            .map(|running| running.id);
        let at = now_ms();
        let inside = self.inside.read();
        let live_sessions = self.live_count();
        let (outside, probe_ms) = self.ask_outside_within(wait);
        crate::jsonfile::save(
            &mark_path(state_dir),
            &SwapMark {
                series: new_series_id(),
                at,
                inside,
                outside,
                probe_ms,
                live_sessions,
                cut_series,
            },
        );
    }

    /// 入れ替えの印を拾って消し、入れ替えの直前の行を書いてから残りの時点を測る。**拾えたら `true`。**
    ///
    /// 印が [`MARK_STALE_AFTER`] より古ければ、捨てたことを1行残して測らない。
    pub fn resume_after_swap(self: &Arc<Self>, state_dir: &Path) -> bool {
        let Some(mark) = take_mark(state_dir) else {
            return false;
        };
        if mark.series.is_empty() {
            tracing::debug!(
                kind = "memory_watch",
                "中身の読めない入れ替えの印を捨てました"
            );
            return false;
        }
        let age_ms = u64::try_from(now_ms().saturating_sub(mark.at)).unwrap_or(0);
        if Duration::from_millis(age_ms) > MARK_STALE_AFTER {
            tracing::info!(
                kind = "memory_watch",
                series = %mark.series,
                age_ms,
                "入れ替えの印が古いので捨てました。入れ替えの後の量は測りません"
            );
            return false;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::debug!(
                kind = "memory_watch",
                series = %mark.series,
                "非同期の実行環境の外で呼ばれたので、入れ替えの後の量を測りません"
            );
            return false;
        };
        *self.running.lock().expect("ロックが壊れていない") =
            Some(Running::new(mark.series.clone(), Event::VersionSwap, None));
        // **時点は印を書いた時刻から数える。** 起き直るまでにかかった分だけ、早く来る
        let now = tokio::time::Instant::now();
        let anchor = now
            .checked_sub(Duration::from_millis(age_ms))
            .unwrap_or(now);
        handle.spawn(Arc::clone(self).run(mark.series.clone(), anchor, Before::Carried(mark)));
        true
    }

    /// 入れ替えた側の起動だけが印を拾う（[`crate::version::confirm_started`] と同じ守り）。
    ///
    /// 統合テストの多くは core を**ライブラリとして**動かすので、確かめずに拾うと開発者の
    /// 実環境の印を消しにいく。印を書くのは入れ替える側だけなので、入れ替えた印
    /// （[`crate::version::already_handed_over`]）が立っていない起動は無関係である。
    pub fn resume_after_swap_if_handed_over(self: &Arc<Self>, state_dir: &Path) -> bool {
        if !crate::version::already_handed_over() {
            return false;
        }
        self.resume_after_swap(state_dir)
    }

    /// 版の入れ替え（`swap`）を、前後の測りで挟む。
    ///
    /// **`swap` が返ってきたら入れ替えられなかった**（入れ替えられれば `exec` で返らない）。
    /// プロセスは古い版のまま生き残るので、印をこの中で拾い直して測りを続ける——拾わないと、
    /// 次に入れ替えたときまで印が残り、別の入れ替えの続きとして読まれる。
    pub fn around_swap(self: &Arc<Self>, state_dir: &Path, wait: Duration, swap: impl FnOnce()) {
        self.before_swap(state_dir, wait);
        swap();
        tracing::info!(
            kind = "memory_watch",
            "版を入れ替えられなかったので、入れ替えの前後の測りをこのプロセスで続けます"
        );
        self.resume_after_swap(state_dir);
    }

    /// 1本の系列を最後まで測る。**打ち切られたら（入れ替え）次の時点で止まる。**
    async fn run(self: Arc<Self>, id: String, anchor: tokio::time::Instant, before: Before) {
        match before {
            Before::Fresh {
                inside,
                live_sessions,
            } => {
                let (outside, probe_ms) = self.ask_outside().await;
                self.emit(
                    &id,
                    Step::Before,
                    0,
                    Measured {
                        inside,
                        outside,
                        probe_ms,
                        live_sessions,
                    },
                    None,
                );
            }
            Before::Carried(mark) => {
                let carried = (mark.cut_series, mark.at);
                self.emit(
                    &id,
                    Step::Before,
                    0,
                    Measured {
                        inside: mark.inside,
                        outside: mark.outside,
                        probe_ms: mark.probe_ms,
                        live_sessions: mark.live_sessions,
                    },
                    Some(carried),
                );
            }
        }
        for (step, after) in AFTER_STEPS {
            tokio::time::sleep_until(anchor + after).await;
            if !self.is_running(&id) {
                return;
            }
            let inside = self.inside.read();
            let live_sessions = self.live_count();
            let (outside, probe_ms) = self.ask_outside().await;
            let elapsed_ms = u64::try_from(anchor.elapsed().as_millis()).unwrap_or(u64::MAX);
            self.emit(
                &id,
                step,
                elapsed_ms,
                Measured {
                    inside,
                    outside,
                    probe_ms,
                    live_sessions,
                },
                None,
            );
        }
        let mut running = self.running.lock().expect("ロックが壊れていない");
        if running.as_ref().is_some_and(|running| running.id == id) {
            *running = None;
        }
    }

    /// 走っている系列があれば、出来事をその数に足す。**足したら `true`。**
    fn join_running(&self, event: Event) -> bool {
        match self.running.lock().expect("ロックが壊れていない").as_mut() {
            Some(running) => {
                running.add(event);
                true
            }
            None => false,
        }
    }

    fn is_running(&self, id: &str) -> bool {
        self.running
            .lock()
            .expect("ロックが壊れていない")
            .as_ref()
            .is_some_and(|running| running.id == id)
    }

    /// 生きている claude の本数。**自分のロックの外で数える**（数える口は器のロックを取る）。
    fn live_count(&self) -> Option<usize> {
        let live = self.live.lock().expect("ロックが壊れていない").clone();
        live.and_then(|live| live())
    }

    /// Windows 側を裏の糸で聞く。WSL でなければ聞かない。
    async fn ask_outside(&self) -> (Option<Outside>, Option<u64>) {
        let Some(probe) = self.outside.clone() else {
            return (None, None);
        };
        let started = std::time::Instant::now();
        let outside = match tokio::task::spawn_blocking(move || probe.read()).await {
            Ok(outside) => outside,
            Err(err) => Outside::failed(format!("Windows 側を聞いている途中で落ちました: {err}")),
        };
        (Some(outside), Some(millis(started.elapsed())))
    }

    /// Windows 側を別の糸で聞き、`wait` まで待つ（入れ替えの直前）。過ぎたら空欄と理由を返す。
    ///
    /// 打ち切った後も糸は答えが返るまで走り続け、返した答えは捨てる（受け手が居ない）。
    /// 入れ替えでプロセスごと消えるので、残り続けることは無い。
    fn ask_outside_within(&self, wait: Duration) -> (Option<Outside>, Option<u64>) {
        let Some(probe) = self.outside.clone() else {
            return (None, None);
        };
        let started = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("memory-watch-swap".to_string())
            .spawn(move || {
                if tx.send(probe.read()).is_err() {
                    tracing::debug!(
                        kind = "memory_watch",
                        "入れ替えの直前に聞いた Windows 側の答えが、打ち切った後に届きました（捨てます）"
                    );
                }
            });
        let outside = match spawned {
            Err(err) => Outside::failed(format!("Windows 側を聞く糸を立てられませんでした: {err}")),
            Ok(_detached) => match rx.recv_timeout(wait) {
                Ok(outside) => outside,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Outside::failed(format!(
                    "版の入れ替えを待たせないため、{}で打ち切りました",
                    span(wait)
                )),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    Outside::failed("Windows 側を聞いている途中で落ちました".to_string())
                }
            },
        };
        (Some(outside), Some(millis(started.elapsed())))
    }

    /// 1回の測りを1行に残し、知らせる。**打ち切られた系列なら何もしない。**
    ///
    /// `carried` は入れ替えをまたいで運んだ直前の行だけが持つ（打ち切った系列・測った時刻）。
    fn emit(
        &self,
        id: &str,
        step: Step,
        elapsed_ms: u64,
        measured: Measured,
        carried: Option<(Option<String>, Timestamp)>,
    ) {
        let (event, card_id, events) = {
            let running = self.running.lock().expect("ロックが壊れていない");
            match running.as_ref() {
                Some(running) if running.id == id => {
                    (running.event, running.card_id, running.events())
                }
                _ => return,
            }
        };
        let (cut_series, measured_at_ms) = match carried {
            Some((cut_series, at)) => (cut_series, Some(at)),
            None => (None, None),
        };
        let sample = Sample {
            series: id.to_string(),
            event,
            step,
            events,
            elapsed_ms,
            inside: measured.inside,
            outside: measured.outside,
            probe_ms: measured.probe_ms,
            live_sessions: measured.live_sessions,
            card_id,
            cut_series,
            measured_at_ms,
        };
        log(&sample);
        let _ = self.samples.send(sample);
    }
}

/// 1回の測りを1行にする。**読めなかった欄は書かない**（0 と書くと嘘になる）。
fn log(sample: &Sample) {
    let inside = sample.inside;
    let outside = sample.outside.as_ref();
    tracing::info!(
        kind = "memory_watch",
        series = %sample.series,
        event = sample.event.as_str(),
        step = sample.step.as_str(),
        events = %sample.events,
        elapsed_ms = sample.elapsed_ms,
        available_mb = inside.map(|inside| inside.available_mb),
        free_mb = inside.map(|inside| inside.free_mb),
        cached_mb = inside.map(|inside| inside.cached_mb),
        host_free_mb = outside.and_then(|outside| outside.host_free_mb),
        vmmem_mb = outside.and_then(|outside| outside.vmmem_mb),
        probe_ms = sample.probe_ms,
        host_error = outside.and_then(|outside| outside.error.as_deref()),
        live_sessions = sample.live_sessions.map(|live| live as u64),
        card_id = sample.card_id.as_ref().map(tracing::field::display),
        cut_series = sample.cut_series.as_deref(),
        measured_at_ms = sample.measured_at_ms,
        "メモリの量を測りました（{}・{}）",
        sample.event.as_str(),
        sample.step.as_str()
    );
}

fn mark_path(state_dir: &Path) -> PathBuf {
    state_dir.join(MEMORY_WATCH_ATTEMPT)
}

/// 印が残っていれば取り出して消す。
fn take_mark(state_dir: &Path) -> Option<SwapMark> {
    let path = mark_path(state_dir);
    if !path.is_file() {
        return None;
    }
    let mark: SwapMark = crate::jsonfile::load_or_default(&path);
    if let Err(err) = std::fs::remove_file(&path) {
        tracing::warn!(
            kind = "memory_watch",
            path = %path.display(),
            error = %err,
            "入れ替えの印を消せません。次の起動でも同じ印を拾います"
        );
    }
    Some(mark)
}

fn new_series_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..SERIES_ID_LEN].to_string()
}

fn millis(span: Duration) -> u64 {
    u64::try_from(span.as_millis()).unwrap_or(u64::MAX)
}

/// 「3 秒」「50 ミリ秒」のように読める長さにする。
fn span(wait: Duration) -> String {
    if wait.subsec_millis() == 0 && wait.as_secs() > 0 {
        format!("{} 秒", wait.as_secs())
    } else {
        format!("{} ミリ秒", wait.as_millis())
    }
}
