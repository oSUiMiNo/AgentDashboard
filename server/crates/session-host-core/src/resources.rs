//! この機械の資源を読む（起こし直し設計§18）。
//!
//! **なぜ PC 側にあるのか。** メモリを持っているのは**セッションを抱える機械**であって、
//! サーバではない。セルフホストではサーバと PC が別の機械なので、サーバが自分の
//! `/proc/meminfo` を読んでも**別の機械の話**になる。
//!
//! **なぜ「何枚入るか」まで、ここで数えるのか。** 同じ規則を Rust と TypeScript の
//! 2箇所に書くと、画面が「入る」と言ったものを PC が断る（あるいは逆）ことが起こる。
//! 戻せるかの判定（設計§3-3）は二重に持ってよいと決めたが、**あちらはずれても
//! 「押せてしまってサーバが断る」に倒れる**だけだった。**こちらはずれると機械が死ぬ。**

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// いま読めたメモリの姿。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Memory {
    /// 積んでいる量（MB）
    pub total_mb: u64,
    /// **いま渡せる量**（MB）。`MemAvailable` であって `MemFree` ではない。
    ///
    /// 空きだけを見るとページキャッシュを空きに数えないので、実際より遥かに少なく出る。
    pub available_mb: u64,
    /// スワップの空き（MB）。**数える対象には入れない**——ここへ落ちた時点で
    /// 機械は使い物にならなくなるので、「入る」の根拠にしてはいけない。見せるだけ。
    pub swap_free_mb: u64,
    /// **キャッシュを当てにしない空き**（`MemFree`）。
    ///
    /// 普段は使わない。**WSL の中に居て、外側（Windows）の空きを聞けなかったとき**の
    /// 抑えに使う（[`counted_available`]）。`MemAvailable` より遥かに小さいので、
    /// **少なく言う側へ倒れる。**
    pub free_mb: u64,
}

/// メモリを読む口。
///
/// **トレイトにしてあるのはテストのため**（ガイドライン「外の世界へ出る操作は
/// トレイト越しにする」）。差し替えられないと、**空きが足りないときの振る舞いを
/// 1行も確かめられない**——テストから `/proc/meminfo` の中身は変えられない。
pub trait Probe: Send + Sync + std::fmt::Debug {
    /// 読めなければ `None`。**読めないことは異常ではない**（Linux 以外）。
    fn read(&self) -> Option<Memory>;
}

/// 本物。`/proc/meminfo` を読む。
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcMeminfo;

impl Probe for ProcMeminfo {
    fn read(&self) -> Option<Memory> {
        parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }
}

/// `/proc/meminfo` の本文から4つを取り出す。
///
/// 単位は kB 固定（カーネルがそう書く）。**要る行が欠けたら `None`**——
/// 半分だけ読めた値で「入る」と答えるより、分からないと言うほうがよい。
pub fn parse_meminfo(text: &str) -> Option<Memory> {
    let field = |name: &str| meminfo_kb(text, name).map(|kb| kb / 1024);
    Some(Memory {
        total_mb: field("MemTotal")?,
        available_mb: field("MemAvailable")?,
        // スワップを持たない機械もある。**そこは 0 として続ける**（見せるだけの値なので）
        swap_free_mb: field("SwapFree").unwrap_or(0),
        // **欠けても `None` にはしない**（`SwapFree` と同じ扱い）。必ず在る行だが、
        // **0 なら「0 枚」へ倒れる**ので、欠損は安全側に出る
        free_mb: field("MemFree").unwrap_or(0),
    })
}

/// `/proc/meminfo` の1行の値（kB）。**行の頭で名前と `:` を見る**——`Cached` を探して
/// `SwapCached` を拾わない。メモリの測り（[`crate::memory_watch`]）も同じ読み方を使う。
pub(crate) fn meminfo_kb(text: &str, name: &str) -> Option<u64> {
    text.lines()
        .find(|line| line.starts_with(name) && line[name.len()..].starts_with(':'))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u64>().ok())
}

/// WSL の中に居るかを決める材料。**外の世界を読むのはここだけ。**
///
/// 判定そのものは [`is_wsl`] という純関数がやる。**読む側と決める側を分けてある**のは、
/// テストから機械の状態を作れるようにするためである——`/run/WSL` は作れない。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WslSense {
    /// `/proc/sys/kernel/osrelease` の中身。**読めなければ空文字**
    pub osrelease: String,
    /// `/run/WSL` が在るか
    pub run_wsl_exists: bool,
}

impl WslSense {
    /// 実機から採る。**読めなければ空文字・偽**——読めないこと自体は異常ではない
    /// （WSL でない機械では当然読めない）。
    pub fn read() -> Self {
        Self {
            osrelease: std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default(),
            run_wsl_exists: std::path::Path::new("/run/WSL").is_dir(),
        }
    }
}

/// WSL の中に居るか。**外の世界へ出ない純関数。**
///
/// # なぜ2つを「かつ」で結ぶのか
///
/// **どちらも単独では使えない。**
///
/// `osrelease` の `microsoft` は**docker コンテナの中でも同じ文字列が出る**
/// （カーネルを共有するため）。`make ci` はコンテナの中で走るので、これだけで
/// 判定すると**毎回「ここは WSL だ」と誤答する**。
///
/// `/run/WSL` の有無は「検出に使ってよい」と公式に書かれた文書が無く、単独では
/// 根拠が弱い。**「かつ」なら両方の弱点が消える**——`osrelease` が準公式の根拠を
/// 与え、`/run/WSL` がコンテナ誤検知を潰す。
///
/// 大小を無視するのは、WSL1 が大文字の `Microsoft` を返すとされているため。
/// **実測していないので断定しないが、無視しておけば両方拾える**（外れても損がない）。
pub fn is_wsl(sense: &WslSense) -> bool {
    sense.osrelease.to_ascii_lowercase().contains("microsoft") && sense.run_wsl_exists
}

/// 外側（WSL から見た Windows）の空きを、**表示のために**どう読んだか（寝ているカード
/// ばかりなのに、メモリ不足でセッションを起こせない 設計§2-5）。
///
/// **判定はこれを使わない。** 表示（`snapshot`）は同期の経路にいて待てないので、古い値も
/// 古さを添えて見せる。判定は [`HostFree::confirm`] が返す [`Confirmed`] を使い、
/// **新しい値でしか通さない。**
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outside {
    /// WSL ではない（または期限 0 の設定）。**外側という概念が無い**ので、いまと1ビットも変わらない
    NotWsl,
    /// 期限内に聞けた値（MB）と、その古さ。`fresh_for` は**この答えを作った時点から**
    /// あと何秒「新しい」ままか（[`fresh_for`]。実装レビュー第2回 Astra 5）
    Fresh {
        mb: u64,
        age: Duration,
        fresh_for: Duration,
    },
    /// 期限を過ぎた値と、その古さ。**取り直しは起こしてある**（か、走っている）
    Stale { mb: u64, age: Duration },
    /// 一度も聞けていないので、いま聞いている
    Checking,
    /// 聞けなかったので、次の取得まで空けている。`last` は最後に聞けた値と古さ（参考）
    Failed {
        reason: String,
        last: Option<(u64, Duration)>,
    },
}

impl Outside {
    /// 表示で数えるときの土台。**確かめられていない状態は `MemFree` の床で数える**（設計§2-5）。
    pub fn basis(&self) -> Basis {
        match self {
            Outside::NotWsl => Basis::NoOutside,
            Outside::Fresh { mb, .. } | Outside::Stale { mb, .. } => Basis::Outside(*mb),
            Outside::Checking | Outside::Failed { .. } => Basis::Floor,
        }
    }
}

/// 数えるときに、`MemAvailable` を何で抑えるか（設計§4-1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    /// 抑えない（WSL でない・期限 0）
    NoOutside,
    /// 外側（Windows）の値（MB）で抑える
    Outside(u64),
    /// 外側を確かめられていないので `MemFree` で抑える。**表示の経路でだけ使う**——
    /// 判定は床で数えずに「確かめられなかった」と断る
    Floor,
}

/// 数えるのに使う空き（MB）。**抑えていないなら `None`**（＝`available_mb` をそのまま使う）。
///
/// **外の世界へ出ない純関数。** [`parse_meminfo`] と同じ作法で、テストから総当たりできる。
///
/// # なぜ床で `MemFree` を使うのか
///
/// 理由は3つ。
///
/// 1. **材料が WSL の中だけで揃う。** 外の世界へ出られないときの答えを、外の世界に
///    頼らずに出せる
/// 2. **`MemAvailable` より遥かに小さい**（実測：`MemAvailable` 15.25 GiB に対し
///    `MemFree` 0.44 GiB）。**キャッシュを当てにしない値**なので保守的
/// 3. **0 枚固定ではない。** 「WSL だが interop の無い構成」でも使えなくならず、
///    機械が空いていれば素直に増える
///
/// **ただし床は表示の案内であって門番ではない**（設計§1-1）。暖まった WSL では常に
/// 余白を下回り、キャッシュを手放した直後は Windows 側と無関係に跳ね上がる——
/// Windows 側の空きの代わりにはならないので、判定には使わない。
pub fn counted_available(memory: &Memory, basis: Basis) -> Option<u64> {
    match basis {
        Basis::NoOutside => None,
        Basis::Outside(host_mb) => Some(memory.available_mb.min(host_mb)),
        Basis::Floor => Some(memory.available_mb.min(memory.free_mb)),
    }
}

/// 何が枚数を決めたか（設計§4-1）。断りの文面・画面・CLI で言い分けるために持つ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    /// WSL の中の空き（`MemAvailable`）。WSL でない機械もここ
    Wsl,
    /// Windows 側の空き
    Windows,
    /// 外側を聞けないときの `MemFree` の床。**表示の経路でだけ出る**
    Floor,
    /// 起こしている途中のぶん（予約）
    Reserved,
}

impl Limit {
    /// ログに載せる綴り。
    pub fn as_str(self) -> &'static str {
        match self {
            Limit::Wsl => "wsl",
            Limit::Windows => "windows",
            Limit::Floor => "floor",
            Limit::Reserved => "reserved",
        }
    }
}

/// 数えた結果（設計§4-1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Assessment {
    /// 観測から数える空き。**抑えていないなら `None`**（`available_mb` をそのまま使った）
    pub counted_mb: Option<u64>,
    /// 予約後の見込みも引いた、判定に使う空き
    pub effective_mb: u64,
    /// 起こせる枚数。**見積もり 0 なら `None`**＝数えない
    pub fits: Option<u32>,
    /// 1枚通したあとの見込み。**起点は `effective_mb`**——`available_mb` へ戻ると、
    /// 外側で抑えていたぶんが見込みから抜け落ちる（設計§1-2）
    pub next_mb: u64,
    /// 何が枚数を決めたか
    pub limit: Limit,
}

/// 数える規則の1本（設計§4-1）。**表示（[`snapshot`]）も判定（`reserve_memory`）もこれを通す。**
///
/// ```text
/// counted   = min(MemAvailable, 外側)   （床なら MemFree、外側なしなら MemAvailable）
/// effective = min(counted, 予約後の見込み)
/// fits      = max(effective − 余白, 0) ÷ 1枚の見積もり
/// next      = max(effective − 1枚の見積もり, 0)
/// ```
pub fn assess(
    memory: &Memory,
    basis: Basis,
    projected_mb: Option<u64>,
    estimate_mb: u64,
    headroom_mb: u64,
) -> Assessment {
    let counted = counted_available(memory, basis);
    let base = counted.unwrap_or(memory.available_mb);
    let effective = projected(base, projected_mb);
    let fits_now = fits(effective, headroom_mb, estimate_mb);
    // **予約のせいと言うのは、予約を引いたことで枚数が減ったときだけ**（実装レビュー
    // Fable 1）。見込みが空きを下回っていても、引く前から同じ枚数なら決めたのは土台の
    // 側である。ここを取り違えると「1分待てば通る」と言い、待って押し直した人が
    // 今度は Windows 側の空きで断られる
    let limit = if fits_now != fits(base, headroom_mb, estimate_mb) {
        Limit::Reserved
    } else {
        match basis {
            Basis::Outside(host_mb) if host_mb < memory.available_mb => Limit::Windows,
            Basis::Floor if memory.free_mb < memory.available_mb => Limit::Floor,
            _ => Limit::Wsl,
        }
    };
    Assessment {
        counted_mb: counted,
        effective_mb: effective,
        fits: fits_now,
        next_mb: effective.saturating_sub(estimate_mb),
        limit,
    }
}

/// 外側（Windows）の空きを聞く口。
///
/// **トレイトにしてあるのはテストのため**（[`Probe`] と同じ理由）。「聞けた」
/// 「聞けなかった」の2通りを、**外の世界へ出ずに**作れる。
///
/// **同期で書いてある。** 呼ぶのは切り離したスレッドの中（[`HostFree`] の取得）なので、
/// 表示の経路が待つことはない。
pub trait HostFreeProbe: Send + Sync + std::fmt::Debug {
    /// 外側の空き（MB）。**聞けなければ理由の文。**
    ///
    /// 理由は断りの文面・画面・CLI まで運ぶ（設計§2-1）。「起動できません」と
    /// 「30s を過ぎても終わりませんでした」では、利用者がすることが違う。
    fn read(&self) -> Result<u64, String>;
}

/// `powershell.exe` の置き場所（**絶対パス**）。
///
/// PATH に Windows の道が載らない構成（`appendWindowsPath=false`）でも通るように、
/// 探さずに直に指す。**`pwsh.exe` は既定で入っていないので使わない。**
pub(crate) const POWERSHELL: &str = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/// 外側を聞くのを諦めるまでの時間。
///
/// 実測は 6〜27 秒（2026-09）、静かな機械では約 1 秒（2026-10-01）で、**逼迫している
/// ときほど遅い**。
pub(crate) const HOST_FREE_TIMEOUT: Duration = Duration::from_secs(30);

/// 判定の確認段階全体の上限（設計§3）。
///
/// **`2 × HOST_FREE_TIMEOUT + 5 秒`。** 失効の境界より前に始まった取得の終わりを待ち、
/// もう1本取る——いちばん長い場合でも、正常な取得を時間切れにしない。
///
/// **CLI の復旧待ち（`agentdashboard-core` の `REVIVE_CAP`）もこれを参照する**（設計§6-5）。
/// 2箇所に数を書くと、片方だけ直したときに CLI が裏の判定より先に諦める。
pub const CONFIRM_WAIT: Duration = Duration::from_secs(HOST_FREE_TIMEOUT.as_secs() * 2 + 5);

/// 取り終えてからこの間は、期限より長くかかった取得でも新しいとみなす（設計§2-4）。
///
/// **取得そのものが期限より長くかかった**場合に、延々と取り直さないための道。
const FRESH_AFTER_FINISH: Duration = Duration::from_secs(5);

/// 「終えてから5秒」の例外を使ってよい、取得にかかった時間の上限（設計§12-2）。
///
/// **取得中に PC がスリープすると、開始は昔・終了は今の観測ができる。** それを「終えてから
/// 0 秒」と読むと、寝る前の値を新しいとみなしてしまう。打ち切り（[`HOST_FREE_TIMEOUT`]）を
/// 越えて続く取得は本来ありえないので、それより長くかかった観測には例外を使わせない。
const MAX_FETCH_SPAN: Duration =
    Duration::from_secs(HOST_FREE_TIMEOUT.as_secs() + FRESH_AFTER_FINISH.as_secs());

/// 失敗が続いたときに、次の取得まで空ける秒数（設計§2-2）。以後は最後の値を使い続ける。
const RETRY_STEPS_SEC: [u64; 4] = [2, 5, 10, 30];

/// `failures_in_row` 回続けて失敗したあとに空ける長さ（設計§2-2）。
///
/// **押すたび・聞き直すたびに `powershell.exe` を立てない**ため。interop が無い構成の
/// ようにすぐ失敗する機械では、抑えないと押すたびに1本立つ。
pub fn retry_delay(failures_in_row: u32) -> Duration {
    let index = (failures_in_row.max(1) as usize - 1).min(RETRY_STEPS_SEC.len() - 1);
    Duration::from_secs(RETRY_STEPS_SEC[index])
}

/// 本物。`powershell.exe` に `Win32_OperatingSystem` を聞く。
///
/// **`wmic.exe` は使わない。** この Windows（build 26200）に**存在しない**——
/// 2026 年の更新で削除済みである（実測）。
#[derive(Debug, Clone, Copy, Default)]
pub struct PowerShellHostFree;

impl HostFreeProbe for PowerShellHostFree {
    fn read(&self) -> Result<u64, String> {
        // **打ち切りは `proc::run` に任せる。** 同じものを2つ持つと片方だけ
        // 打ち切りを忘れる（`proc` のモジュール説明がそう言っている）。
        // 中で `kill` してから `wait` するので、**時間切れでもゾンビにならない。**
        //
        // **ここでは行を残さない。** 成否・所要時間・理由は取得の終わり
        // （[`HostFree`] の `finish`）で1行にまとめる——2行出すと同じ失敗が2件に見える
        let outcome = crate::proc::run(
            std::process::Command::new(POWERSHELL).args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory",
            ]),
            HOST_FREE_TIMEOUT,
        );
        if !outcome.success {
            return Err(short_reason(
                outcome.output.trim(),
                "powershell.exe が失敗しました",
            ));
        }
        parse_host_free(&outcome.output).ok_or_else(|| {
            format!(
                "答えを数として読めませんでした: {}",
                short_reason(outcome.output.trim(), "（空）")
            )
        })
    }
}

/// 理由の文を、画面とログに載せられる長さへ詰める。**空なら `empty` を返す。**
///
/// `powershell.exe` のエラーは数十行になることがあり、そのまま運ぶと断りの文面が
/// 読めなくなる。
pub(crate) fn short_reason(text: &str, empty: &str) -> String {
    const MAX_CHARS: usize = 200;
    let first = text.lines().map(str::trim).find(|line| !line.is_empty());
    match first {
        None => empty.to_string(),
        Some(line) if line.chars().count() > MAX_CHARS => {
            format!("{}…", line.chars().take(MAX_CHARS).collect::<String>())
        }
        Some(line) => line.to_string(),
    }
}

/// `FreePhysicalMemory` の出力（kB）を MB へ直す。**外の世界へ出ない純関数。**
///
/// **単位を取り違えると 1024 倍ずれる。** [`parse_meminfo`] と同じ作法で割る。
pub fn parse_host_free(text: &str) -> Option<u64> {
    text.split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()
        .map(|kb| kb / 1024)
}

/// いまの時刻を、単調時計と壁時計の組で持つ（設計§2-1）。
///
/// **片方だけでは古さを数えられない。** Linux の `Instant` は `CLOCK_MONOTONIC` で、
/// 止まっていた（PC がスリープしていた）時間を数えないことがある。寝る前の値が
/// 「数秒前」に見えないよう、壁時計の経過も見て大きいほうを採る。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Now {
    pub mono: Instant,
    pub wall: SystemTime,
}

impl Now {
    pub fn current() -> Self {
        Self {
            mono: Instant::now(),
            wall: SystemTime::now(),
        }
    }
}

/// `then` からの古さ。**壁時計が巻き戻っていたら `None`**（＝期限切れとして扱う）。
///
/// 単調時計の経過と壁時計の経過の**大きいほう**。
pub fn age_since(then: Now, now: Now) -> Option<Duration> {
    let mono = now.mono.saturating_duration_since(then.mono);
    let wall = now.wall.duration_since(then.wall).ok()?;
    Some(mono.max(wall))
}

/// 聞けた1回（設計§2-1）。**時刻は取得を始めた時点で刻む。**
///
/// 取得に 1〜27 秒かかる間に通した起こし直しが「値より前」に見えないようにするため
/// （以前は取り終えた時点で刻んでいた）。終えた時点も持つのは、期限より長くかかった
/// 取得を延々と取り直さないため（[`usable`] の2つ目の道）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reading {
    /// 外側の空き（MB）
    pub mb: u64,
    /// 取得を始めた時刻
    pub started: Now,
    /// 取得を終えた時刻
    pub finished: Now,
}

impl Reading {
    /// 始めた時点からの古さ。**壁時計が巻き戻っていたら単調時計の経過**（表示用）。
    pub fn age(&self, now: Now) -> Duration {
        age_since(self.started, now)
            .unwrap_or_else(|| now.mono.saturating_duration_since(self.started.mono))
    }
}

/// この観測を判定に使ってよいか（設計§2-4）。**`confirm` の中でも、予約台帳のロックの中でも
/// これで確かめる**——2箇所で別の条件を書くと、確認を通った値がロックの中で通らない
/// （あるいは逆）ことが起こる。
///
/// 1. **失効の境界より後に始めた取得である**（境界が無ければ満たす）
/// 2. **新しい**：始めた時点からの古さが期限未満、**または**終えた時点からの古さが
///    [`FRESH_AFTER_FINISH`] 未満
///
/// 2つ目の道を「自分が待ち始めた後に始まった取得」にしないのは、`prefetch` で席待ちの前に
/// 起こした取得を捨てることになり、同じ取得を待った2人で採否が変わるため。
///
/// **2つ目の道は、取得にかかった時間が単調時計でも壁時計でも [`MAX_FETCH_SPAN`] 以内で、
/// 壁時計が巻き戻っていない観測にだけ使う**（設計§12-2）。取得中のスリープで「開始は昔・
/// 終了は今」になった観測を、新しいとみなさないため。
///
/// **表示（[`HostFree::outside`]）もこれで「新しい」を決める**（設計§12-1）。表示だけ別の
/// 条件にすると、判定が使わない値を表示が `fresh` と言う。
pub fn usable(reading: &Reading, required_after: Option<Instant>, ttl: Duration, now: Now) -> bool {
    fresh_for(reading, required_after, ttl, now).is_some()
}

/// この観測が、`now` から**あと何秒「新しい」ままか**（実装レビュー第2回 Astra 5）。
/// [`usable`] を満たさなければ `None`。
///
/// **[`usable`] はこれの有無で決まる。** 残りを別の規則で数えると、表示が「あと N 秒」と
/// 言う値を判定が使わない（あるいは逆）ことが起こる。
///
/// 2つの道（始めた時点からの期限・終えた時点からの例外）のうち、成り立っているほうの
/// 残りの**長いほう**を返す。失効の境界（`required_after`）が新しく立つと、残りがあっても
/// その場で使えなくなる——境界は予約が0件になった瞬間に立つので、先回りしては数えられない。
/// 答えるのは「ほかに何も起きなければ」の残りである。
pub fn fresh_for(
    reading: &Reading,
    required_after: Option<Instant>,
    ttl: Duration,
    now: Now,
) -> Option<Duration> {
    if required_after.is_some_and(|boundary| reading.started.mono < boundary) {
        return None;
    }
    let from_start = age_since(reading.started, now)
        .and_then(|age| ttl.checked_sub(age))
        .filter(|left| !left.is_zero());
    let span_mono = reading
        .finished
        .mono
        .saturating_duration_since(reading.started.mono);
    let span_ok = reading
        .finished
        .wall
        .duration_since(reading.started.wall)
        .is_ok_and(|span_wall| span_wall <= MAX_FETCH_SPAN && span_mono <= MAX_FETCH_SPAN);
    let from_finish = span_ok
        .then(|| age_since(reading.finished, now))
        .flatten()
        .and_then(|age| FRESH_AFTER_FINISH.checked_sub(age))
        .filter(|left| !left.is_zero());
    from_start.max(from_finish)
}

/// 判定が受け取る、確かめた結果（設計§2-3）。**作れるのは [`HostFree::confirm`] だけ。**
///
/// 判定（`reserve_memory`）はこれを引数に取るので、**確認を通っていない値を判定へ渡す道が
/// コンパイルで通らない。** ただし型が保証するのは「確認を通った」ことだけで、「今も有効」
/// ではない——予約台帳のロックの中で [`usable`] をもう一度見る。
#[derive(Debug, Clone)]
pub struct Confirmed {
    checked: Checked,
    waited: Duration,
}

impl Confirmed {
    /// 確かめた中身。
    pub fn checked(&self) -> &Checked {
        &self.checked
    }

    /// 確かめるのに待った長さ（判定のログに載せる）。
    pub fn waited(&self) -> Duration {
        self.waited
    }
}

/// 確かめた中身。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// 外側を見ない（WSL でない・期限 0）。いまと1ビットも変わらない
    NotWsl,
    /// 判定に使ってよい観測
    Known(Reading),
    /// 確かめられなかった（理由）。**判定は数えずに断る**
    Unconfirmed(String),
}

/// 聞いた結果（設計§2-1）。取得が終わるたびに `round` が1つ進み、待ち手が起きる。
#[derive(Debug, Clone, Default)]
struct Heard {
    /// 最後に成功した観測
    last_ok: Option<Reading>,
    /// 最後の失敗（時刻と理由）。成功で消える
    last_failure: Option<(Instant, String)>,
    /// 取得中なら、その取得を始めた時刻（同時に1本だけ）
    fetching_since: Option<Instant>,
    /// 失敗が続いたときに、次の取得を許す時刻
    retry_after: Option<Instant>,
    /// 連続失敗の回数
    failures_in_row: u32,
    /// 取得が終わるたびに1つ進む
    round: u64,
}

/// 外側を知るための一式——**聞く口・聞いた結果・待ち合わせ**（設計§2）。
///
/// # なぜ覚えるのか
///
/// 外側を聞くのに約 1〜27 秒かかるので、**表示のたびに聞くと画面が固まる。** かといって
/// 定期的に聞き続けると、押されていないときも `powershell.exe` を立て続けることになる
/// （**CPU を食う件と噛み合わない**）。
///
/// # 表示と判定で振る舞いが違う
///
/// - **表示**（[`HostFree::outside`]）は待たない。古い値も古さを添えて見せ、期限切れなら
///   取り直しを起こすだけ
/// - **判定**（[`HostFree::confirm`]）は、**新しい値が来るまで待つ。** 期限切れの値では
///   通さないし、聞けなければ数えずに「確かめられなかった」と断る
///
/// 以前は判定も表示と同じく待たず、期限切れなら `MemFree` で数えていた。暖まった WSL では
/// `MemFree` が常に余白を下回るので、**60 秒空けたあとの1回目は必ず 0 枚で断っていた**
/// （寝ているカードばかりなのに、メモリ不足でセッションを起こせない 原因調査）。
///
/// # 待ち合わせは `watch`
///
/// `Notify::notify_waiters` は呼んだ瞬間に待っている相手しか起こさないので、「状態を見る→
/// 待ち始める」の間に取得が終わると知らせを取りこぼし、上限まで眠って「確かめられなかった」
/// で断る——直そうとしている症状と同じ顔になる。`watch` は `borrow_and_update` 以後の変更を
/// `changed` が取りこぼさない。
///
/// # 予約を知らない
///
/// 失効の境界（予約が0件になった時刻）は予約台帳（`session::ReviveBudget`）が持ち、
/// [`HostFree::confirm`] へ引数で渡す。**測る道具と予約の台帳は別物**で、ロックの入れ子を作らない。
#[derive(Debug)]
pub struct HostFree {
    is_wsl: bool,
    probe: Arc<dyn HostFreeProbe>,
    /// 覚えた値をそのまま使ってよい期間。**0 なら外側を見ない**（＝いまの振る舞いに戻る逃げ道）
    ttl: Duration,
    /// 判定の確認段階全体の上限（設計§3）。テストで差し替える
    wait: Duration,
    heard: tokio::sync::watch::Sender<Heard>,
}

impl HostFree {
    /// 材料を全部渡して作る。**テストの入口でもある。** 確認段階の上限は [`CONFIRM_WAIT`]。
    pub fn new(is_wsl: bool, probe: Arc<dyn HostFreeProbe>, ttl: Duration) -> Arc<Self> {
        Self::with_wait(is_wsl, probe, ttl, CONFIRM_WAIT)
    }

    /// 確認段階の上限まで渡して作る（**テストが短くするため**）。
    pub fn with_wait(
        is_wsl: bool,
        probe: Arc<dyn HostFreeProbe>,
        ttl: Duration,
        wait: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            is_wsl,
            probe,
            ttl,
            wait,
            heard: tokio::sync::watch::Sender::new(Heard::default()),
        })
    }

    /// 実機から作る。**ここで1回だけ温めておく**（設計§2-6）。
    ///
    /// 温めなくても正しく動く——判定は新しい値を待つので、温めに失敗しても最初の
    /// 起こし直しは通る。温めておくと、その待ちが要らない場面が増える。
    pub fn from_config(config: &crate::config::SessionHostConfig) -> Arc<Self> {
        let host_free = Self::new(
            is_wsl(&WslSense::read()),
            Arc::new(PowerShellHostFree),
            Duration::from_secs(config.revive_host_free_ttl_sec),
        );
        host_free.kick(None);
        host_free
    }

    /// 外側を見るか。**WSL でない・`ttl = 0` なら見ない**（いまの振る舞いへ戻す逃げ道）。
    fn watching(&self) -> bool {
        self.is_wsl && !self.ttl.is_zero()
    }

    /// 判定の確認段階全体の上限。**締切は呼ぶ側が1回だけ作る**（設計§3）。
    pub fn wait(&self) -> Duration {
        self.wait
    }

    /// この観測を、いま判定に使ってよいか（[`usable`] に自分の期限を渡す）。
    pub fn usable_now(&self, reading: &Reading, required_after: Option<Instant>) -> bool {
        usable(reading, required_after, self.ttl, Now::current())
    }

    /// いまの外側の状態（設計§2-5・§12-1）。**待たない。** 上から順に最初に当たったものを返す。
    ///
    /// | 順 | 状態 | 答え | 取得を起こすか |
    /// |---|---|---|---|
    /// | 1 | WSL でない／期限 0 | `NotWsl` | 起こさない |
    /// | 2 | [`usable`] を満たす成功値がある | `Fresh` | 起こさない |
    /// | 3 | 取得中 | 成功値があれば `Stale`、無ければ `Checking` | 起こさない（既に1本） |
    /// | 4 | 抑え中（直前が失敗） | `Failed` | 起こさない |
    /// | 5 | それ以外 | 成功値があれば `Stale`、無ければ `Checking` | **起こす** |
    ///
    /// **失効の境界（`required_after`）を受け取る。** 予約が0件になった直後に、境界より前の
    /// 観測を `fresh` と言わないため——判定はそれを使わないので、表示と判定が食い違う。
    /// 境界を持つのは予約台帳なので、呼ぶ側が引数で渡す（`HostFree` は予約を知らない）。
    pub fn outside(self: &Arc<Self>, required_after: Option<Instant>) -> Outside {
        if !self.watching() {
            return Outside::NotWsl;
        }
        let now = Now::current();
        let heard = self.heard.borrow().clone();
        if let Some(reading) = &heard.last_ok
            && let Some(left) = fresh_for(reading, required_after, self.ttl, now)
        {
            return Outside::Fresh {
                mb: reading.mb,
                age: reading.age(now),
                fresh_for: left,
            };
        }
        let last = heard.last_ok.map(|reading| (reading.mb, reading.age(now)));
        let stale_or_checking = |last: Option<(u64, Duration)>| match last {
            Some((mb, age)) => Outside::Stale { mb, age },
            None => Outside::Checking,
        };
        if heard.fetching_since.is_some() {
            return stale_or_checking(last);
        }
        if heard.retry_after.is_some_and(|at| now.mono < at) {
            return Outside::Failed {
                reason: failure_reason(&heard),
                last,
            };
        }
        self.kick(required_after);
        stale_or_checking(last)
    }

    /// 起こし直しの受付時に、**判定に使える値が無ければ取りに行かせるだけ**（設計§2-3・§12-1）。
    ///
    /// 席待ちと取得を重ねるため。待たない。**起こす条件は [`HostFree::outside`] と同じ**
    /// （取得中・抑え中なら起こさない。境界より前の観測しかなければ起こす）——条件は
    /// [`HostFree::kick`] の1箇所にある。
    pub fn prefetch(self: &Arc<Self>, required_after: Option<Instant>) {
        self.kick(required_after);
    }

    /// 判定に使ってよい観測が得られるまで待つ（設計§2-4）。**期限切れの値は返さない。**
    ///
    /// | 場合 | 答え |
    /// |---|---|
    /// | WSL でない／期限 0 | すぐ `NotWsl` |
    /// | 条件（[`usable`]）を満たす観測がある | すぐ `Known` |
    /// | 満たさない | 取得中の1本があればその終わりを、無ければ起こして終わりを待つ |
    /// | 取得が失敗・抑え中・`deadline` を過ぎた | `Unconfirmed(理由)` |
    ///
    /// **締切は呼ぶ側が作って渡す。** 判定が2周しても、確認段階全体で [`HostFree::wait`] を
    /// 超えないようにするため（各周で作り直すと倍になる）。
    pub async fn confirm(
        self: &Arc<Self>,
        required_after: Option<Instant>,
        deadline: tokio::time::Instant,
    ) -> Confirmed {
        let began = Instant::now();
        let done = |checked: Checked| Confirmed {
            checked,
            waited: began.elapsed(),
        };
        if !self.watching() {
            return done(Checked::NotWsl);
        }
        let mut changes = self.heard.subscribe();
        loop {
            let heard = changes.borrow_and_update().clone();
            let now = Now::current();
            if let Some(reading) = heard.last_ok
                && usable(&reading, required_after, self.ttl, now)
            {
                return done(Checked::Known(reading));
            }
            if heard.fetching_since.is_none() {
                if heard.retry_after.is_some_and(|at| now.mono < at) {
                    return done(Checked::Unconfirmed(failure_reason(&heard)));
                }
                // **起こせなかったら、状態を見直す。** 起こせない理由は「他の誰かが今まさに
                // 起こした」か「今まさに失敗・成功が記録された」のどれかで、次の周がそれを見る
                // （実行時の取っ手はこの async の中では必ず在る）
                self.kick(required_after);
                continue;
            }
            match tokio::time::timeout_at(deadline, changes.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    // 送り手は `self` が持っているので閉じない。閉じていたら、待っても何も来ない
                    return done(Checked::Unconfirmed(
                        "Windows 側の空きを聞く仕組みが止まっていました".to_string(),
                    ));
                }
                Err(_) => {
                    return done(Checked::Unconfirmed(format!(
                        "{} 秒以内に答えが返りませんでした",
                        self.wait.as_secs()
                    )));
                }
            }
        }
    }

    /// 要れば取得を1本起こす。**起こせたら `true`。** 答えは待たない。
    ///
    /// **起こす条件はここ1箇所**（設計§12-1）。起こさないのは：外側を見ない／実行時の
    /// 取っ手が無い／判定に使える成功値がある（境界を見る）／既に1本走っている／抑え中。
    ///
    /// **確かめるのと印を立てるのは、`watch` の中で一度に行う**——見てから書くと2本立つ。
    /// **印を立てただけでは待ち手を起こさない**（閉包が `false` を返す）。待ち手が気にするのは
    /// 取得が終わったこと（`round` が進むこと）だけで、立てただけで起こすと空回りする。
    fn kick(self: &Arc<Self>, required_after: Option<Instant>) -> bool {
        if !self.watching() {
            return false;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return false;
        };
        let started = Now::current();
        let ttl = self.ttl;
        let mut kicked = false;
        self.heard.send_if_modified(|heard| {
            let fresh = heard
                .last_ok
                .is_some_and(|reading| usable(&reading, required_after, ttl, started));
            if fresh
                || heard.fetching_since.is_some()
                || heard.retry_after.is_some_and(|at| started.mono < at)
            {
                return false;
            }
            heard.fetching_since = Some(started.mono);
            kicked = true;
            false
        });
        if !kicked {
            return false;
        }
        let me = Arc::clone(self);
        // **終わりは同じ閉包の中で記録する。** 結果を別の async タスクで待つ形にすると、
        // そのタスクが落とされたとき（起こした実行時が畳まれたときなど）に取得中の印が
        // 戻らず、以後1度も取りに行かなくなる——判定は毎回締切まで待って断ることになる
        handle.spawn_blocking(move || {
            // **パニックも失敗として記録する**（設計§2-1）
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| me.probe.read()))
                .unwrap_or_else(|panic| {
                    Err(format!(
                        "聞いている途中で落ちました: {}",
                        panic_text(&*panic)
                    ))
                });
            me.finish(started, result);
        });
        true
    }

    /// 取得の終わり。**成功・失敗・パニックのどれでも必ず通る**（設計§2-1）。
    ///
    /// 取得中の印を戻し、`round` を進めて待ち手を起こす。
    fn finish(&self, started: Now, result: Result<u64, String>) {
        let finished = Now::current();
        // **理由は先頭の1行・200字までに詰める**（設計§12-5）。PowerShell の標準エラーが
        // そのまま入りうるうえ、資源を聞くたびに画面と CLI へ運ばれる
        let result = result.map_err(|reason| {
            short_reason(
                &reason,
                "Windows 側の空きを聞けませんでした（理由の文がありません）",
            )
        });
        let took_ms = u64::try_from(
            finished
                .mono
                .saturating_duration_since(started.mono)
                .as_millis(),
        )
        .unwrap_or(u64::MAX);
        match &result {
            Ok(mb) => tracing::info!(
                kind = "host_free_probe",
                ok = true,
                host_free_mb = *mb,
                took_ms,
                "Windows 側の空きを聞きました"
            ),
            Err(reason) => tracing::warn!(
                kind = "host_free_probe",
                ok = false,
                took_ms,
                reason = %reason,
                program = POWERSHELL,
                "Windows 側の空きを聞けませんでした"
            ),
        }
        self.heard.send_modify(|heard| {
            heard.fetching_since = None;
            heard.round += 1;
            match result {
                Ok(mb) => {
                    heard.last_ok = Some(Reading {
                        mb,
                        started,
                        finished,
                    });
                    heard.last_failure = None;
                    heard.retry_after = None;
                    heard.failures_in_row = 0;
                }
                Err(reason) => {
                    heard.failures_in_row = heard.failures_in_row.saturating_add(1);
                    heard.retry_after = Some(finished.mono + retry_delay(heard.failures_in_row));
                    heard.last_failure = Some((finished.mono, reason));
                }
            }
        });
    }

    /// 覚えている値を直に入れる（**テスト専用**）。**始めた時点も終えた時点も `at`**——
    /// 終えた時点を今にすると「終えてから5秒」の道で古い値が新しく見える。
    #[doc(hidden)]
    pub fn 覚えさせる(&self, mb: u64, at: Instant) {
        let now = Now::current();
        let ago = now.mono.saturating_duration_since(at);
        let then = Now {
            mono: at,
            wall: now.wall.checked_sub(ago).unwrap_or(now.wall),
        };
        self.heard.send_modify(|heard| {
            heard.last_ok = Some(Reading {
                mb,
                started: then,
                finished: then,
            });
        });
    }

    /// いま取りに行っているか（**テスト専用**）。
    #[doc(hidden)]
    pub fn 取りに行っているか(&self) -> bool {
        self.heard.borrow().fetching_since.is_some()
    }

    /// 取得が終わった回数（**テスト専用**）。
    #[doc(hidden)]
    pub fn 聞き終えた回数(&self) -> u64 {
        self.heard.borrow().round
    }
}

/// パニックの中身を文にする（`panic!` の文字列か、分からなければ一般的な文）。
fn panic_text(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "理由の分からないパニック".to_string())
}

/// 直前の失敗の理由。**無ければ一般的な文**（理由の無い断りを出さない）。
fn failure_reason(heard: &Heard) -> String {
    heard
        .last_failure
        .as_ref()
        .map(|(_, reason)| reason.clone())
        .unwrap_or_else(|| "Windows 側の空きを聞けませんでした".to_string())
}

/// いま何枚起こし直せるか。**数えないときは `None`。**
///
/// `(空き − 余白) ÷ 1枚あたりの見積もり` を切り捨てる。
///
/// **余白を引くのは、空きを 0 まで使わないため。** 戻したあとに何も動かせない機械が
/// 残ると、片付けることすらできなくなる。
///
/// **見積もりが 0 なら数えない**（`None`）。歯止めを外したい人のための逃げ道で、
/// 0 除算の防御を兼ねている。
///
/// # なぜ番兵ではなく `None` なのか
///
/// 以前はここで `u32::MAX` を返していた。**それを「数」として運ぶと、見せるところで
/// 1つずつ潰すことになる**——実際、`agentdashboard host resources local` が
/// 「いま 4294967295 枚まで起こし直せます」と出していた（コードレビュー対応2）。
/// 「数えない」は数ではないので、型で言う。
pub fn fits(available_mb: u64, headroom_mb: u64, estimate_mb: u64) -> Option<u32> {
    if estimate_mb == 0 {
        return None;
    }
    let usable = available_mb.saturating_sub(headroom_mb);
    Some(u32::try_from(usable / estimate_mb).unwrap_or(u32::MAX))
}

/// 数えるのに要るもの一式——**読む口と、2つの数字**（コードレビュー対応4）。
///
/// # なぜ束ねるのか
///
/// 以前は `(probe, estimate_mb, headroom_mb)` の3つ組が **3箇所**（`session/mod.rs`・
/// `link.rs`・`local.rs`）で別々に組み立てられていた。**裸の `u64` が2つ並ぶ**ので、
/// 見積もりと余白の取り違えを型が止められない。「数えるのはここ1箇所」という
/// [`snapshot`] の約束も、組み立てる側が増えた時点で既に破れていた。
///
/// **作る道を1つに絞ってある**（[`Gauge::from_config`]）。呼び出し側に裸の
/// `u64` を並べる場所がもう無いので、**取り違えようがない。**
///
/// # なぜ `ReviveBudget` ではないのか
///
/// **その名前は既に別のものが使っている**——`session::ReviveBudget` は「いま枠を
/// 握っている本数と、通したぶんを引いた見込み」を持つ**予約の台帳**で、こちらは
/// **測る道具**である。同じ回のレビューで両方が生まれたので、片方の名前を変えた
/// （`.claude/CLAUDE.md`「新しく紛らわしい語が出たら、表へ足してから言い換える」）。
#[derive(Clone)]
pub struct Gauge {
    probe: std::sync::Arc<dyn Probe>,
    /// 外側（Windows）を知るための一式。**器そのものを共有する**——`Gauge` は
    /// 押されるたびに組み直されるので、**覚えている値をここに置くと毎回消える。**
    host_free: std::sync::Arc<HostFree>,
    estimate_mb: u64,
    headroom_mb: u64,
}

impl std::fmt::Debug for Gauge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gauge")
            .field("estimate_mb", &self.estimate_mb)
            .field("headroom_mb", &self.headroom_mb)
            .finish_non_exhaustive()
    }
}

impl Gauge {
    /// 設定から作る。**ここが唯一の入口。**
    pub fn from_config(
        probe: std::sync::Arc<dyn Probe>,
        host_free: std::sync::Arc<HostFree>,
        config: &crate::config::SessionHostConfig,
    ) -> Self {
        Self {
            probe,
            host_free,
            estimate_mb: config.revive_estimate_mb,
            headroom_mb: config.revive_headroom_mb,
        }
    }

    /// 1枚あたりの見積もり（MB）。
    pub fn estimate_mb(&self) -> u64 {
        self.estimate_mb
    }

    /// 使い切らずに残す余白（MB）。
    pub fn headroom_mb(&self) -> u64 {
        self.headroom_mb
    }

    /// メモリを読む。**読めなければ `None`**（Linux 以外。異常ではない）。
    pub fn read_memory(&self) -> Option<Memory> {
        self.probe.read()
    }

    /// 外側を知る一式。判定（`revive`）は確認をこれに頼む。
    pub fn host_free(&self) -> &Arc<HostFree> {
        &self.host_free
    }

    /// いまの外側の状態。**待たない**（期限切れなら背景で取りに行くだけ）。表示用。
    /// 失効の境界は予約台帳が持つので、呼ぶ側が渡す（設計§12-1）。
    pub fn outside(&self, required_after: Option<Instant>) -> Outside {
        self.host_free.outside(required_after)
    }
}

/// 資源を読めなかった（コードレビュー対応4）。
///
/// **`Option` ではなく型にしてあるのは、`JoinError` と言い分けるため。**
/// ローカルモードは読み取りを別スレッドへ逃がしており、**逃がした先が落ちたこと**と
/// **この機械では読めないこと**は別の話である（前者は実装の誤り）。
#[derive(Debug, Clone)]
pub struct ReadError {
    pub reason: protocol::a2s::HostFailure,
    pub detail: String,
}

impl ReadError {
    /// 「この機械では読めない」（Linux 以外）。**異常ではない。**
    ///
    /// 理由は `Unavailable`。**`Unsupported` にすると 415 になり**、「メディア型が
    /// 非対応」という無関係な断りが出る（コードレビュー対応8）。
    pub fn unreadable() -> Self {
        Self {
            reason: protocol::a2s::HostFailure::Unavailable,
            detail: "この PC ではメモリの空きを読めません".to_string(),
        }
    }
}

/// いまの資源を1枚にまとめる（設計§18-2・§19）。
///
/// **数える規則はここ1箇所。** `SessionManager` からも、線の答えを作るところからも
/// これを通す——2箇所に書くと、画面が「入る」と言ったものを PC が断ることが起こる。
///
/// # `projected_mb` は「通したぶんを差し引いた見込み」
///
/// `MemAvailable` は**実際に確保されたぶんしか減らない**。起こし直しを通してから
/// claude が約 780MB を確保し終えるまでには間があり（実測：擬似ターミナルは 2.02 秒で
/// 揃い、RSS が落ち着いたのは +50 秒）、その間この値は**まだ空いている**と言い続ける。
///
/// 素直に信じると、同時に頼んだぶんが**互いを数えないまま全員「入る」**になる。
/// そこで、通したぶんを引いた見込みを持ち回り、**実測と見込みの小さいほう**で数える
/// （設計§19）。載る前は見込みが効き、載ったあとは実測が効くので、**二重には引かれない**。
///
/// 枠が1つも無ければ `None`＝実測をそのまま使う。
///
/// `required_after` は**失効の境界**（予約が0件になった時刻。設計§4-3・§12-1）。表示も
/// 判定と同じく、境界より前に始めた観測を `fresh` と言わない。
///
/// 読めなければ `None`。**読めないことは異常ではない**（Linux 以外）。
pub fn snapshot(
    gauge: &Gauge,
    projected_mb: Option<u64>,
    required_after: Option<Instant>,
) -> Option<protocol::HostResources> {
    // **ここは触らない。** `Probe` が読めなければ、この `?` で早く返る——
    // 外側の判定にも取得にも1度も到達しないので、**「メモリそのものを読めない」と
    // 「WSL の外側を読めない」が混ざらない**（設計§10-1）
    let memory = gauge.probe.read()?;
    let outside = gauge.outside(required_after);
    // **表示は案内であって門番ではない**（寝ているカードばかりなのに、メモリ不足で
    // セッションを起こせない 設計§2-5）。確かめられていない状態は床で数えて見せるが、
    // 判定は新しい値でしか通さない
    let assessment = assess(
        &memory,
        outside.basis(),
        projected_mb,
        gauge.estimate_mb,
        gauge.headroom_mb,
    );
    // **あと何秒新しいかは `fresh` のときだけ添える**（実装レビュー第2回 Astra 5）。画面は
    // 1つの周で全 PC に聞くので、先に答えた PC の値が、遅い PC を待つ間に期限を越えうる。
    // 秒は切り捨てる（0 秒＝もう新しくない、の側へ倒れる）
    let host_free_fresh_for_sec = match &outside {
        Outside::Fresh { fresh_for, .. } => Some(fresh_for.as_secs()),
        _ => None,
    };
    let (host_free_mb, host_free_age_sec, host_free_state, host_free_error) = match &outside {
        Outside::NotWsl => (None, None, None, None),
        Outside::Fresh { mb, age, .. } => (
            Some(*mb),
            Some(age.as_secs()),
            Some(protocol::HostFreeState::Fresh),
            None,
        ),
        Outside::Stale { mb, age } => (
            Some(*mb),
            Some(age.as_secs()),
            Some(protocol::HostFreeState::Stale),
            None,
        ),
        Outside::Checking => (None, None, Some(protocol::HostFreeState::Checking), None),
        // 前回の成功値は**参考として**添える（設計§2-5 の順4）。数えるのは床
        Outside::Failed { reason, last } => (
            last.map(|(mb, _)| mb),
            last.map(|(_, age)| age.as_secs()),
            Some(protocol::HostFreeState::Failed),
            Some(reason.clone()),
        ),
    };
    Some(protocol::HostResources {
        total_mb: memory.total_mb,
        // **機械が報告した値は書き換えない。** 見込みは数えるためのもので、
        // 「いくら空いているか」の答えではない
        available_mb: memory.available_mb,
        swap_free_mb: memory.swap_free_mb,
        estimate_mb: gauge.estimate_mb,
        headroom_mb: gauge.headroom_mb,
        host_free_mb,
        counted_mb: assessment.counted_mb,
        fits_now: assessment.fits,
        host_free_age_sec,
        host_free_state,
        host_free_error,
        effective_mb: Some(assessment.effective_mb),
        host_free_fresh_for_sec,
    })
}

/// 実測と見込みの、**小さいほう**（設計§19）。
///
/// 見込みが無ければ実測をそのまま使う。**数える規則を2箇所に書かない**ため、
/// 枠を取る側（`SessionManager::reserve_memory`）もこれを通す。
pub fn projected(available_mb: u64, projected_mb: Option<u64>) -> u64 {
    projected_mb.map_or(available_mb, |projected| available_mb.min(projected))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「この機械では読めない」は、**テキストとして読めないのとは別の理由**で断ること
    /// （コードレビュー対応8）。
    ///
    /// ここを `Unsupported` に戻すと、REST が **415**（メディア型が非対応）を返し、
    /// Linux 以外の PC へ聞いた人に**無関係な理由**が出る。写し先そのものは
    /// `server-core` の `status_of` が見ているので、ここでは**どちらの理由を選ぶか**だけを固定する。
    #[test]
    fn 読めない機械は理由をテキスト非対応と言い分ける() {
        let err = ReadError::unreadable();
        assert_eq!(err.reason, protocol::a2s::HostFailure::Unavailable);
        assert_ne!(err.reason, protocol::a2s::HostFailure::Unsupported);
        // 文言は変えない。**利用者が読むのはこちら**で、理由の綴りは見えない
        assert_eq!(err.detail, "この PC ではメモリの空きを読めません");
    }

    #[test]
    fn 空きから余白を引いた残りを見積もりで割る() {
        // (10000 - 2000) / 780 = 10.25… → 10
        assert_eq!(fits(10_000, 2_000, 780), Some(10));
    }

    #[test]
    fn 余白に届かなければ0枚() {
        assert_eq!(fits(2_000, 2_048, 780), Some(0));
        assert_eq!(fits(0, 2_048, 780), Some(0));
    }

    #[test]
    fn 境目はちょうど1枚を跨ぐ() {
        // 余白 + 見積もり ちょうどで 1 枚、1MB 足りなければ 0 枚
        assert_eq!(fits(2_048 + 780, 2_048, 780), Some(1));
        assert_eq!(fits(2_048 + 779, 2_048, 780), Some(0));
    }

    #[test]
    fn 見積もりが0なら数えない() {
        // **番兵を返さない。** 数として運ぶと、見せるところで1つずつ潰すことになる
        // （コードレビュー対応2。CLI が「4294967295 枚」と出していた）
        assert_eq!(fits(100, 2_048, 0), None);
    }

    /// 好きな空きを名乗るだけの口。
    #[derive(Debug)]
    struct 名乗る(u64);

    impl Probe for 名乗る {
        fn read(&self) -> Option<Memory> {
            Some(Memory {
                total_mb: 16_000,
                available_mb: self.0,
                swap_free_mb: 0,
                // **外側を聞けたときは使われない値。** 抑えを試すテストは
                // `名乗る外側あり` のほうを使う
                free_mb: self.0,
            })
        }
    }

    /// 好きな外側を名乗るだけの口。**`None` は「聞けなかった」。**
    #[derive(Debug)]
    struct 外側(Option<u64>);

    impl HostFreeProbe for 外側 {
        fn read(&self) -> Result<u64, String> {
            self.0
                .ok_or_else(|| "聞けませんでした（テスト）".to_string())
        }
    }

    /// WSL でない機械の一式。
    fn wslでない() -> std::sync::Arc<HostFree> {
        HostFree::new(
            false,
            std::sync::Arc::new(外側(None)),
            std::time::Duration::from_secs(60),
        )
    }

    /// WSL の機械の一式。**覚えている値を直に入れておく**ので、背景の取得は要らない。
    fn wslで外側が(mb: Option<u64>) -> std::sync::Arc<HostFree> {
        let host_free = HostFree::new(
            true,
            std::sync::Arc::new(外側(mb)),
            std::time::Duration::from_secs(60),
        );
        if let Some(mb) = mb {
            host_free.覚えさせる(mb, std::time::Instant::now());
        }
        host_free
    }

    /// **入口を増やさない。** 設定から作る道（`from_config`）をテストでも通す
    fn 物差し(available_mb: u64, estimate_mb: u64, headroom_mb: u64) -> Gauge {
        物差しで外側が(available_mb, estimate_mb, headroom_mb, wslでない())
    }

    fn 物差しで外側が(
        available_mb: u64,
        estimate_mb: u64,
        headroom_mb: u64,
        host_free: std::sync::Arc<HostFree>,
    ) -> Gauge {
        let config = crate::config::SessionHostConfig {
            revive_estimate_mb: estimate_mb,
            revive_headroom_mb: headroom_mb,
            ..Default::default()
        };
        Gauge::from_config(
            std::sync::Arc::new(名乗る(available_mb)),
            host_free,
            &config,
        )
    }

    #[test]
    fn 通したぶんを引いた見込みで数える() {
        // (12,000 − 2,000) / 1,000 = 10 枚。3枚ぶん通してあれば見込みは 9,000
        let 見込みなし = snapshot(&物差し(12_000, 1_000, 2_000), None, None).expect("読めること");
        assert_eq!(見込みなし.fits_now, Some(10));
        let 見込みあり =
            snapshot(&物差し(12_000, 1_000, 2_000), Some(9_000), None).expect("読めること");
        assert_eq!(見込みあり.fits_now, Some(7));
        // **空きそのものは動かさない。** 見込みは数えるためのもので、機械が報告した
        // 空きを書き換えてよいわけではない
        assert_eq!(見込みあり.available_mb, 12_000);
    }

    #[test]
    fn 実測が見込みより下がっていれば実測を採る() {
        // **これが二重に引かないための要点。** 通したぶんが実際に載れば、実測が
        // 見込みを下回る。両方引くと、入るのに断り続けることになる
        assert_eq!(projected(3_000, Some(9_000)), 3_000, "実測のほうが小さい");
        assert_eq!(
            projected(12_000, Some(9_000)),
            9_000,
            "見込みのほうが小さい"
        );
        assert_eq!(projected(12_000, None), 12_000, "枠が無ければ実測そのまま");
    }

    #[test]
    fn 見込みが余白を割っても負にならない() {
        let resources = snapshot(&物差し(3_000, 1_000, 2_000), Some(0), None).expect("読めること");
        assert_eq!(resources.fits_now, Some(0));
    }

    #[test]
    fn meminfoの3行を読む() {
        let text = "MemTotal:       16073624 kB\n\
                    MemFree:         1234000 kB\n\
                    MemAvailable:   13385216 kB\n\
                    SwapFree:        4194304 kB\n";
        let memory = parse_meminfo(text).expect("読めること");
        assert_eq!(memory.total_mb, 15_696);
        assert_eq!(memory.available_mb, 13_071);
        assert_eq!(memory.swap_free_mb, 4_096);
        assert_eq!(memory.free_mb, 1_205);
    }

    #[test]
    fn memfreeが欠けても0として続く() {
        // **`SwapFree` と同じ扱い。** 必ず在る行だが、欠けたからといって「分からない」
        // へ倒すと、**外側を聞けるかどうかと無関係に床が効かなくなる**
        let text = "MemTotal: 16073624 kB\nMemAvailable: 13385216 kB\n";
        let memory = parse_meminfo(text).expect("読めること");
        assert_eq!(memory.free_mb, 0);
    }

    #[test]
    fn 頭が同じだけの行に釣られない() {
        // `MemAvailable` を探して `MemTotal` に当たらないこと。**前方一致だけで
        // 探すと `MemFree` が `MemFreeFoo` に当たる**ような取り違えが起きる
        let text = "MemTotalSomething: 999 kB\nMemTotal: 16073624 kB\nMemAvailable: 13385216 kB\n";
        let memory = parse_meminfo(text).expect("読めること");
        assert_eq!(memory.total_mb, 15_696);
    }

    #[test]
    fn 要る行が欠けていたら分からないと言う() {
        assert!(parse_meminfo("MemTotal: 16073624 kB\n").is_none());
        assert!(parse_meminfo("").is_none());
    }

    #[test]
    fn スワップが無い機械でも読める() {
        let text = "MemTotal: 16073624 kB\nMemAvailable: 13385216 kB\n";
        assert_eq!(parse_meminfo(text).expect("読めること").swap_free_mb, 0);
    }

    // -----------------------------------------------------------------------
    // WSL の検出（設計§4）
    // -----------------------------------------------------------------------

    fn 材料(osrelease: &str, run_wsl_exists: bool) -> WslSense {
        WslSense {
            osrelease: osrelease.to_string(),
            run_wsl_exists,
        }
    }

    #[test]
    fn wslの中なら真() {
        assert!(is_wsl(&材料("6.6.87.2-microsoft-standard-WSL2", true)));
    }

    #[test]
    fn 素のlinuxなら偽() {
        assert!(!is_wsl(&材料("6.8.0-45-generic", false)));
    }

    /// **これが `make ci` の毎回通る道である。**
    ///
    /// docker コンテナはホストのカーネルを共有するので、`osrelease` は WSL の文字列を
    /// そのまま返す。**`/run/WSL` が無いことだけがコンテナの中と外を分ける**ので、
    /// ここが偽にならないと**ビルドのたびに「ここは WSL だ」と誤答する。**
    #[test]
    fn dockerコンテナの中は偽() {
        assert!(!is_wsl(&材料("6.6.87.2-microsoft-standard-WSL2", false)));
    }

    #[test]
    fn run_wslだけ在っても偽() {
        assert!(!is_wsl(&材料("6.8.0-45-generic", true)));
    }

    #[test]
    fn 読めなければ偽() {
        assert!(!is_wsl(&材料("", false)));
        assert!(!is_wsl(&材料("", true)));
    }

    /// WSL1 は大文字の `Microsoft` を返すとされている。**実測していないので断定しないが、
    /// 大小を無視しておけば両方拾える**（外れても損がない）。
    #[test]
    fn wsl1想定の大文字も拾う() {
        assert!(is_wsl(&材料("4.4.0-19041-Microsoft", true)));
    }

    // -----------------------------------------------------------------------
    // 数える値を決める（設計§7-1）
    // -----------------------------------------------------------------------

    fn 姿(available_mb: u64, free_mb: u64) -> Memory {
        Memory {
            total_mb: 24_000,
            available_mb,
            swap_free_mb: 0,
            free_mb,
        }
    }

    #[test]
    fn wslでなければ抑えない() {
        // **`None` は「抑えていない」。** WSL でない機械の答えが1ビットも変わらない
        // ことを、ここで固定する
        assert_eq!(counted_available(&姿(18_000, 500), Basis::NoOutside), None);
    }

    #[test]
    fn 外側が小さければ外側で数える() {
        // 要件が引いている 2026-09-13 22:07:11 の実測。**いまの式なら 21 枚と答える**
        assert_eq!(
            counted_available(&姿(18_983, 465), Basis::Outside(1_792)),
            Some(1_792)
        );
    }

    #[test]
    fn 外側が大きければ内側で数える() {
        // **`min` が効く。** 外側が潤沢でも、WSL の中が細ければそちらが天井になる
        assert_eq!(
            counted_available(&姿(4_000, 500), Basis::Outside(20_000)),
            Some(4_000)
        );
    }

    #[test]
    fn 外側を聞けなければmemfreeで抑える() {
        // **キャッシュを当てにしない値で抑える。** 0 枚固定ではないので、機械が
        // 空いていれば素直に増える
        assert_eq!(counted_available(&姿(18_983, 465), Basis::Floor), Some(465));
    }

    #[test]
    fn 外側の空きはkbからmbへ直す() {
        // **取り違えると 1024 倍ずれる。** `powershell.exe` は kB で答える
        assert_eq!(parse_host_free("1834864\r\n"), Some(1_791));
        assert_eq!(parse_host_free("  12345  "), Some(12));
        assert_eq!(parse_host_free(""), None);
        assert_eq!(parse_host_free("なにか別のもの"), None);
    }

    // -----------------------------------------------------------------------
    // 覚えておく仕組み（寝ているカードばかりなのに、メモリ不足でセッションを
    // 起こせない 設計§2・§8-2）
    // -----------------------------------------------------------------------

    /// 呼ばれた回数を数える口。**眠り・答え・パニックを選べる**ので、取得の終わり方を
    /// 1つずつ作れる。
    #[derive(Debug)]
    struct 数える外側 {
        回数: std::sync::atomic::AtomicUsize,
        眠り: Duration,
        答え: Option<u64>,
        落ちる: bool,
    }

    impl 数える外側 {
        fn 答える(mb: u64) -> Arc<Self> {
            Self::作る(Some(mb), Duration::ZERO, false)
        }
        fn 遅れて答える(mb: u64, 眠り: Duration) -> Arc<Self> {
            Self::作る(Some(mb), 眠り, false)
        }
        fn 聞けない() -> Arc<Self> {
            Self::作る(None, Duration::ZERO, false)
        }
        fn 落ちる() -> Arc<Self> {
            Self::作る(None, Duration::ZERO, true)
        }
        fn 作る(答え: Option<u64>, 眠り: Duration, 落ちる: bool) -> Arc<Self> {
            Arc::new(Self {
                回数: std::sync::atomic::AtomicUsize::new(0),
                眠り,
                答え,
                落ちる,
            })
        }
        fn 回数(&self) -> usize {
            self.回数.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl HostFreeProbe for 数える外側 {
        fn read(&self) -> Result<u64, String> {
            self.回数.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // **眠りは有限にする。** 実行時は落ちるときに blocking の仕事を待つので、
            // 終わらない口はテストの最後で固まる
            std::thread::sleep(self.眠り);
            assert!(!self.落ちる, "わざと落ちる口");
            self.答え
                .ok_or_else(|| "起動できません: テストの口".to_string())
        }
    }

    fn wslの一式(probe: Arc<数える外側>, ttl: Duration) -> Arc<HostFree> {
        HostFree::new(true, probe, ttl)
    }

    fn 締切() -> tokio::time::Instant {
        tokio::time::Instant::now() + CONFIRM_WAIT
    }

    /// 取得が1回終わるまで待つ（表示の経路は待たないので、テストの側で待つ）。
    async fn 聞き終えるまで(host_free: &Arc<HostFree>, 回: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while host_free.聞き終えた回数() < 回 {
            assert!(tokio::time::Instant::now() < deadline, "取得が終わらない");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn wslでなければ外側を見ない() {
        assert_eq!(wslでない().outside(None), Outside::NotWsl);
    }

    #[test]
    fn 期限内なら覚えている値を使う() {
        let host_free = wslで外側が(Some(1_792));
        assert!(matches!(
            host_free.outside(None),
            Outside::Fresh { mb: 1_792, .. }
        ));
    }

    /// 以前の `期限が切れたら古すぎる値で答えない` を置き換えた1本目（設計§8-2）。
    ///
    /// **表示は古い値も古さを添えて見せる。** 判定はこれを使わない（次の2本）。
    #[tokio::test]
    async fn 期限切れの値は古さを添えて表示に使い取得を起こす() {
        let probe = 数える外側::答える(5_000);
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(1_792, Instant::now() - Duration::from_secs(3_600));

        match host_free.outside(None) {
            Outside::Stale { mb, age } => {
                assert_eq!(mb, 1_792, "古い値を見せること");
                assert!(
                    age >= Duration::from_secs(3_600),
                    "古さを添えること: {age:?}"
                );
            }
            other => panic!("期限切れの値は Stale で見せること: {other:?}"),
        }
        聞き終えるまで(&host_free, 1).await;
        assert_eq!(probe.回数(), 1, "取り直しを起こしていること");
        assert!(matches!(
            host_free.outside(None),
            Outside::Fresh { mb: 5_000, .. }
        ));
    }

    /// 置き換えた2本目。**判定は期限切れの値で数えず、取り直しを待つ。**
    #[tokio::test]
    async fn 判定は期限切れの値を使わず取得を待つ() {
        let probe = 数える外側::遅れて答える(5_000, Duration::from_millis(100));
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(1_792, Instant::now() - Duration::from_secs(3_600));

        let confirmed = host_free.confirm(None, 締切()).await;
        match confirmed.checked() {
            Checked::Known(reading) => assert_eq!(reading.mb, 5_000, "取り直した値で答えること"),
            other => panic!("取り直しを待って答えること: {other:?}"),
        }
        assert_eq!(probe.回数(), 1);
        assert!(
            confirmed.waited() >= Duration::from_millis(100),
            "待ったこと"
        );
    }

    #[tokio::test]
    async fn 取得が失敗したら古い値で答えない() {
        let probe = 数える外側::聞けない();
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(1_792, Instant::now() - Duration::from_secs(3_600));

        match host_free.confirm(None, 締切()).await.checked() {
            Checked::Unconfirmed(reason) => assert!(
                reason.contains("起動できません"),
                "聞けなかった理由を運ぶこと: {reason}"
            ),
            other => panic!("★古い値で答えないこと: {other:?}"),
        }
    }

    #[tokio::test]
    async fn 取得が時間切れなら待つのをやめる() {
        // **眠りは上限より少し長いだけ。** 無期限に眠らせると、実行時が落ちるときに固まる
        let probe = 数える外側::遅れて答える(5_000, Duration::from_secs(3));
        let wait = Duration::from_millis(300);
        let host_free = HostFree::with_wait(true, probe, Duration::from_secs(60), wait);

        let began = Instant::now();
        let confirmed = host_free
            .confirm(None, tokio::time::Instant::now() + host_free.wait())
            .await;
        let Checked::Unconfirmed(reason) = confirmed.checked() else {
            panic!("時間切れなら確かめられなかったと答えること: {confirmed:?}");
        };
        assert!(reason.contains("答えが返りませんでした"), "{reason}");
        assert!(
            began.elapsed() < Duration::from_secs(2),
            "上限で待つのをやめること（取得の終わりまで待たない）: {:?}",
            began.elapsed()
        );
    }

    #[tokio::test]
    async fn 期限内の値は取り直さない() {
        let probe = 数える外側::答える(5_000);
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(4_000, Instant::now());

        let confirmed = host_free.confirm(None, 締切()).await;
        assert!(matches!(
            confirmed.checked(),
            Checked::Known(Reading { mb: 4_000, .. })
        ));
        host_free.prefetch(None);
        let _ = host_free.outside(None);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(probe.回数(), 0, "期限内なら外へ聞かないこと");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 判定する人が何人いても外へ聞くのは1本() {
        let probe = 数える外側::遅れて答える(5_000, Duration::from_millis(200));
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));

        let waiters: Vec<_> = (0..8)
            .map(|_| {
                let host_free = Arc::clone(&host_free);
                tokio::spawn(async move { host_free.confirm(None, 締切()).await })
            })
            .collect();
        for waiter in waiters {
            let confirmed = waiter.await.expect("落ちていないこと");
            assert!(
                matches!(
                    confirmed.checked(),
                    Checked::Known(Reading { mb: 5_000, .. })
                ),
                "全員が同じ1本の結果を受け取ること: {confirmed:?}"
            );
        }
        assert_eq!(probe.回数(), 1, "外へ聞くのは1本だけであること");
    }

    #[test]
    fn 失敗が続くと次の取得を空ける() {
        let 秒 = |n| retry_delay(n).as_secs();
        assert_eq!(
            [秒(1), 秒(2), 秒(3), 秒(4), 秒(5), 秒(100)],
            [2, 5, 10, 30, 30, 30]
        );
    }

    #[tokio::test]
    async fn 抑え中は取得を起こさずすぐ確認不能() {
        let probe = 数える外側::聞けない();
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));

        assert!(matches!(
            host_free.confirm(None, 締切()).await.checked(),
            Checked::Unconfirmed(_)
        ));
        assert_eq!(probe.回数(), 1);

        let began = Instant::now();
        let again = host_free.confirm(None, 締切()).await;
        assert!(matches!(again.checked(), Checked::Unconfirmed(_)));
        assert!(
            began.elapsed() < Duration::from_secs(1),
            "待たずに答えること"
        );
        assert!(
            matches!(host_free.outside(None), Outside::Failed { .. }),
            "表示も失敗を言うこと"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            probe.回数(),
            1,
            "★抑え中は外へ聞かないこと（押すたびに powershell.exe を立てない）"
        );
    }

    #[tokio::test]
    async fn 取得を始めた時点で刻む() {
        let probe = 数える外側::遅れて答える(5_000, Duration::from_secs(1));
        let host_free = wslの一式(probe, Duration::from_secs(60));

        let before = Instant::now();
        let confirmed = host_free.confirm(None, 締切()).await;
        let Checked::Known(reading) = confirmed.checked() else {
            panic!("聞けること: {confirmed:?}");
        };
        assert!(
            reading.started.mono < before + Duration::from_millis(500),
            "★始めた時点で刻むこと（取り終えた時点ではない）"
        );
        assert!(
            reading.finished.mono.duration_since(reading.started.mono) >= Duration::from_secs(1),
            "終えた時点も持つこと"
        );
    }

    #[tokio::test]
    async fn 失効境界より前に始めた観測は判定に使わない() {
        let probe = 数える外側::答える(2_000);
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(9_000, Instant::now() - Duration::from_millis(10));

        let confirmed = host_free.confirm(Some(Instant::now()), 締切()).await;
        match confirmed.checked() {
            Checked::Known(reading) => assert_eq!(
                reading.mb, 2_000,
                "★境界より前に始めた 9,000 を使わず、取り直した値で答えること"
            ),
            other => panic!("取り直して答えること: {other:?}"),
        }
        assert_eq!(probe.回数(), 1);
    }

    #[test]
    fn 壁時計の経過が単調時計より大きければそちらで古さを数える() {
        // PC のスリープ明け。**単調時計は 1 秒しか進んでいないが、壁時計は 100 秒進んだ**
        let then = Now::current();
        let now = Now {
            mono: then.mono + Duration::from_secs(1),
            wall: then.wall + Duration::from_secs(100),
        };
        assert_eq!(age_since(then, now), Some(Duration::from_secs(100)));
        let reading = Reading {
            mb: 5_000,
            started: then,
            finished: then,
        };
        assert!(
            !usable(&reading, None, Duration::from_secs(60), now),
            "★寝る前の値を「1 秒前」と読まないこと"
        );
    }

    #[tokio::test]
    async fn 取得がパニックしても取得中の印が戻り待ち手が起きる() {
        let probe = 数える外側::落ちる();
        let host_free = wslの一式(probe, Duration::from_secs(60));

        let confirmed = host_free.confirm(None, 締切()).await;
        let Checked::Unconfirmed(reason) = confirmed.checked() else {
            panic!("落ちたら確かめられなかったと答えること: {confirmed:?}");
        };
        assert!(reason.contains("落ちました"), "{reason}");
        assert!(
            !host_free.取りに行っているか(),
            "★取得中の印が戻っていること（戻らないと以後1度も取りに行かない）"
        );
    }

    /// `watch` を選んだ理由を固定する（設計§2-1）。**すぐ終わる取得でも、待ちが上限まで
    /// 伸びない**——状態を見てから待ち始めるまでの間に終わった知らせを取りこぼすと、
    /// 待ちは締切まで眠る。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn 状態を見た直後に取得が終わっても待ち手が起きる() {
        for _ in 0..50 {
            let host_free = wslの一式(数える外側::答える(5_000), Duration::from_secs(60));
            let began = Instant::now();
            let confirmed = host_free.confirm(None, 締切()).await;
            assert!(matches!(confirmed.checked(), Checked::Known(_)));
            assert!(
                began.elapsed() < Duration::from_secs(5),
                "★知らせを取りこぼして待ちが伸びていないこと: {:?}",
                began.elapsed()
            );
        }
    }

    #[test]
    fn usableの総当たり() {
        let ttl = Duration::from_secs(60);
        let t0 = Now::current();
        let at = |secs: f64| Now {
            mono: t0.mono + Duration::from_secs_f64(secs),
            wall: t0.wall + Duration::from_secs_f64(secs),
        };
        let 読み = |started: Now, finished: Now| Reading {
            mb: 5_000,
            started,
            finished,
        };

        // 境界の前後
        let reading = 読み(at(0.0), at(1.0));
        assert!(
            usable(&reading, Some(t0.mono), ttl, at(2.0)),
            "境界ちょうどに始めたものは使える"
        );
        assert!(
            usable(
                &reading,
                Some(t0.mono - Duration::from_millis(1)),
                ttl,
                at(2.0)
            ),
            "境界より後に始めたものは使える"
        );
        assert!(
            !usable(&reading, Some(at(0.001).mono), ttl, at(2.0)),
            "境界より前に始めたものは使わない"
        );

        // 始めた時点からの古さが期限の前後（終えてから5秒は過ぎている）
        let reading = 読み(at(0.0), at(0.0));
        assert!(usable(&reading, None, ttl, at(59.9)));
        assert!(!usable(&reading, None, ttl, at(60.0)));

        // 終えた時点から5秒の前後（期限 10 秒より長くかかった 30 秒の取得）
        let short_ttl = Duration::from_secs(10);
        let reading = 読み(at(0.0), at(30.0));
        assert!(
            usable(&reading, None, short_ttl, at(34.9)),
            "終えてから5秒未満なら使う"
        );
        assert!(
            !usable(&reading, None, short_ttl, at(35.0)),
            "5秒を過ぎたら使わない"
        );
        // 取得に打ち切り＋5秒（35 秒）より長くかかった観測には例外を使わない（設計§12-2）
        let reading = 読み(at(0.0), at(70.0));
        assert!(
            !usable(&reading, None, ttl, at(70.1)),
            "取得にかかった時間が長すぎる観測は、終えたばかりでも使わない"
        );

        // 壁時計の巻き戻し
        let rewound = Now {
            mono: at(1.0).mono,
            wall: t0.wall - Duration::from_secs(10),
        };
        assert!(
            !usable(&読み(at(0.0), at(0.5)), None, ttl, rewound),
            "壁時計が巻き戻っていたら期限切れとして扱う"
        );
    }

    /// あと何秒「新しい」ままかは、[`usable`] と同じ規則の残り（実装レビュー第2回 Astra 5）。
    /// 別の規則で数えると、画面が「まだ新しい」と言う値を PC の判定は使わない。
    #[test]
    fn あと何秒新しいかはusableと同じ規則の残り() {
        let ttl = Duration::from_secs(60);
        let t0 = Now::current();
        let at = |secs: f64| Now {
            mono: t0.mono + Duration::from_secs_f64(secs),
            wall: t0.wall + Duration::from_secs_f64(secs),
        };
        let 読み = |started: Now, finished: Now| Reading {
            mb: 5_000,
            started,
            finished,
        };

        // 始めた時点からの道：残り＝期限−古さ。期限ちょうどで尽きる（`usable` と同じく未満）
        let reading = 読み(at(0.0), at(1.0));
        assert_eq!(
            fresh_for(&reading, None, ttl, at(10.0)),
            Some(Duration::from_secs(50))
        );
        assert_eq!(fresh_for(&reading, None, ttl, at(60.0)), None);

        // 終えた時点からの道（期限 10 秒より長くかかった 30 秒の取得）：残り＝5 秒−終えてからの古さ
        let short_ttl = Duration::from_secs(10);
        let reading = 読み(at(0.0), at(30.0));
        assert_eq!(
            fresh_for(&reading, None, short_ttl, at(32.0)),
            Some(Duration::from_secs(3))
        );
        assert_eq!(fresh_for(&reading, None, short_ttl, at(35.0)), None);

        // 両方の道が成り立つなら長いほう（始めてから 6 秒＝残り 4 秒、終えてから 2 秒＝残り 3 秒）
        let reading = 読み(at(0.0), at(4.0));
        assert_eq!(
            fresh_for(&reading, None, short_ttl, at(6.0)),
            Some(Duration::from_secs(4))
        );

        // 境界より前に始めた観測・壁時計の巻き戻しは、残りを持たない
        let reading = 読み(at(0.0), at(0.5));
        assert_eq!(
            fresh_for(&reading, Some(at(0.001).mono), ttl, at(2.0)),
            None
        );
        let rewound = Now {
            mono: at(1.0).mono,
            wall: t0.wall - Duration::from_secs(10),
        };
        assert_eq!(fresh_for(&reading, None, ttl, rewound), None);

        // **有無は `usable` と必ず一致する**（上の総当たりの点を全部通す）
        for (started, finished, now, ttl) in [
            (0.0, 1.0, 59.9, 60.0),
            (0.0, 0.0, 60.0, 60.0),
            (0.0, 30.0, 34.9, 10.0),
            (0.0, 30.0, 35.0, 10.0),
            (0.0, 70.0, 70.1, 60.0),
        ] {
            let reading = 読み(at(started), at(finished));
            let ttl = Duration::from_secs_f64(ttl);
            assert_eq!(
                fresh_for(&reading, None, ttl, at(now)).is_some(),
                usable(&reading, None, ttl, at(now)),
                "始め {started}・終え {finished}・今 {now}"
            );
        }
    }

    /// 画面は1つの周で全 PC に聞き、全台が落ち着いてから「何枚戻すか」を決める（実装レビュー
    /// 第2回 Astra 5）。**先に答えた PC の `fresh` が、遅い PC を待つ間に期限を越えたかを
    /// 画面が判断できる**よう、`fresh` の答えには残りの秒数を添える。
    #[test]
    fn freshの答えにはあと何秒新しいかを添える() {
        let host_free = HostFree::new(true, Arc::new(外側(Some(5_000))), Duration::from_secs(60));
        host_free.覚えさせる(5_000, Instant::now() - Duration::from_secs(20));
        let resources = snapshot(&物差しで外側が(12_000, 1_000, 2_000, host_free), None, None)
            .expect("読めること");
        assert_eq!(
            resources.host_free_state,
            Some(protocol::HostFreeState::Fresh)
        );
        let left = resources
            .host_free_fresh_for_sec
            .expect("★fresh の答えに、あと何秒新しいかを添えていない");
        assert!(
            (39..=40).contains(&left),
            "期限 60 秒で 20 秒前に始めた値なら、残りは 40 秒（切り捨て）: {left}"
        );

        // 期限を過ぎた値・WSL でない機械には添えない（`fresh` でないものに残りは無い）
        let host_free = HostFree::new(true, Arc::new(外側(Some(5_000))), Duration::from_secs(60));
        host_free.覚えさせる(5_000, Instant::now() - Duration::from_secs(120));
        let resources = snapshot(&物差しで外側が(12_000, 1_000, 2_000, host_free), None, None)
            .expect("読めること");
        assert_eq!(
            resources.host_free_state,
            Some(protocol::HostFreeState::Stale)
        );
        assert_eq!(resources.host_free_fresh_for_sec, None);
        let resources = snapshot(&物差し(12_000, 1_000, 2_000), None, None).expect("読めること");
        assert_eq!(resources.host_free_fresh_for_sec, None);
    }

    #[tokio::test]
    async fn prefetchで始めた取得の値をconfirmが使う() {
        // **期限（100ms）より取得（300ms）が長い。** 「始めた時点から」では期限切れだが、
        // 終えてから5秒の道で使える——席待ちの前に起こした取得を捨てない
        let probe = 数える外側::遅れて答える(3_000, Duration::from_millis(300));
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_millis(100));

        host_free.prefetch(None);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let confirmed = host_free.confirm(None, 締切()).await;

        assert!(
            matches!(
                confirmed.checked(),
                Checked::Known(Reading { mb: 3_000, .. })
            ),
            "{confirmed:?}"
        );
        assert_eq!(probe.回数(), 1, "★prefetch の1本をそのまま使うこと");
    }

    #[tokio::test]
    async fn 締切は確認段階全体で1回() {
        // 1周目が 1 秒、失効で2周目に入ってもう 1 秒。締切 1.8 秒を共有していれば
        // 2周目は間に合わずに確かめられないで終わり、**合計は締切を大きく超えない**
        let probe = 数える外側::遅れて答える(3_000, Duration::from_secs(1));
        let host_free = HostFree::with_wait(
            true,
            probe,
            Duration::from_secs(60),
            Duration::from_millis(1_800),
        );
        let began = Instant::now();
        let deadline = tokio::time::Instant::now() + host_free.wait();

        let first = host_free.confirm(None, deadline).await;
        assert!(matches!(first.checked(), Checked::Known(_)));
        let second = host_free.confirm(Some(Instant::now()), deadline).await;
        assert!(
            matches!(second.checked(), Checked::Unconfirmed(_)),
            "{second:?}"
        );
        assert!(
            began.elapsed() < Duration::from_millis(2_600),
            "★合計の待ちが上限を超えないこと: {:?}",
            began.elapsed()
        );
    }

    // 表示の優先順位（設計§2-5 の表の5行）

    #[test]
    fn 期限が0なら外側を見ない() {
        // 順1。**逃げ道が効くこと**
        let host_free = HostFree::new(true, Arc::new(外側(Some(1_792))), Duration::ZERO);
        assert_eq!(host_free.outside(None), Outside::NotWsl);
    }

    #[tokio::test]
    async fn 表示の優先順位() {
        // 順2：期限内の成功値 → Fresh（起こさない）
        let probe = 数える外側::遅れて答える(5_000, Duration::from_secs(1));
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(4_000, Instant::now());
        assert!(matches!(
            host_free.outside(None),
            Outside::Fresh { mb: 4_000, .. }
        ));
        assert_eq!(probe.回数(), 0);

        // 順5 → 順3：期限切れ・取得中でない → Stale で起こす。次は取得中なので Stale のまま起こさない
        host_free.覚えさせる(4_000, Instant::now() - Duration::from_secs(120));
        assert!(matches!(
            host_free.outside(None),
            Outside::Stale { mb: 4_000, .. }
        ));
        assert!(host_free.取りに行っているか(), "順5 は取得を起こすこと");
        assert!(matches!(
            host_free.outside(None),
            Outside::Stale { mb: 4_000, .. }
        ));
        聞き終えるまで(&host_free, 1).await;
        assert_eq!(probe.回数(), 1, "取得中は2本目を起こさないこと");

        // 順3（成功値なし）：取得中 → Checking
        let probe = 数える外側::遅れて答える(5_000, Duration::from_secs(1));
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        assert_eq!(host_free.outside(None), Outside::Checking);
        assert_eq!(host_free.outside(None), Outside::Checking);
        聞き終えるまで(&host_free, 1).await;
        assert_eq!(probe.回数(), 1);

        // 順4：抑え中 → Failed（前回の成功値を参考に添える・起こさない）
        let probe = 数える外側::聞けない();
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(4_000, Instant::now() - Duration::from_secs(120));
        let _ = host_free.outside(None);
        聞き終えるまで(&host_free, 1).await;
        match host_free.outside(None) {
            Outside::Failed { reason, last } => {
                assert!(reason.contains("起動できません"), "{reason}");
                assert_eq!(
                    last.map(|(mb, _)| mb),
                    Some(4_000),
                    "前回の値を参考に添えること"
                );
            }
            other => panic!("抑え中は Failed: {other:?}"),
        }
        assert_eq!(probe.回数(), 1, "抑え中は起こさないこと");
    }

    #[test]
    fn 一度も読めていなければ確かめていると言う() {
        let host_free = wslで外側が(None);
        assert_eq!(host_free.outside(None), Outside::Checking);
    }

    /// **実行時の取っ手が無くても落ちない。** 取りに行けないことは異常ではない。
    #[test]
    fn 取っ手が無い場面でも落ちない() {
        let host_free = wslで外側が(None);
        assert_eq!(host_free.outside(None), Outside::Checking);
        assert!(
            !host_free.取りに行っているか(),
            "取っ手が無いのだから、取りに行った印も立たないこと"
        );
    }

    #[tokio::test]
    async fn 同時に2本取りに行かない() {
        // **1〜27 秒かかるものを、押すたびに積み上げない**
        let probe = 数える外側::遅れて答える(1_000, Duration::from_secs(1));
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        for _ in 0..5 {
            assert_eq!(host_free.outside(None), Outside::Checking);
        }
        聞き終えるまで(&host_free, 1).await;
        assert_eq!(
            probe.回数(),
            1,
            "5回押しても、外側へ聞きに行くのは1本だけであること"
        );
        // 取れたら次からは覚えている値で即答する
        assert!(matches!(
            host_free.outside(None),
            Outside::Fresh { mb: 1_000, .. }
        ));
    }

    // -----------------------------------------------------------------------
    // 第4回の検分で改めたこと（設計§12）
    // -----------------------------------------------------------------------

    /// 取得中に PC がスリープした観測（設計§12-2）。**開始は1時間前（壁時計）、終了は今、
    /// 単調時計では数秒。** 「終えてから0秒」と読んで判定に使ってはいけない。
    #[test]
    fn 取得中にスリープを挟んだ観測は終えてから5秒の例外を使わない() {
        let now = Now::current();
        let started = Now {
            mono: now.mono - Duration::from_secs(3),
            wall: now.wall - Duration::from_secs(3_600),
        };
        let reading = Reading {
            mb: 5_000,
            started,
            finished: now,
        };
        assert!(
            !usable(&reading, None, Duration::from_secs(60), now),
            "★寝る前に始めた取得を、終えたばかりだからと新しいとみなさないこと"
        );
        // 取得にかかった時間が上限ちょうどまでなら、例外を使う
        let started = Now {
            mono: now.mono - MAX_FETCH_SPAN,
            wall: now.wall - MAX_FETCH_SPAN,
        };
        let reading = Reading {
            mb: 5_000,
            started,
            finished: now,
        };
        assert!(usable(&reading, None, Duration::from_secs(1), now));
    }

    /// 予約が0件になった直後、表示が境界より前の観測で `fresh` と答えない（設計§12-1）。
    #[tokio::test]
    async fn 表示も境界より前の観測をfreshと言わず取得を起こす() {
        let probe = 数える外側::答える(2_000);
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(5_000, Instant::now() - Duration::from_millis(10));
        assert!(matches!(
            host_free.outside(None),
            Outside::Fresh { mb: 5_000, .. }
        ));

        let boundary = Instant::now();
        match host_free.outside(Some(boundary)) {
            Outside::Stale { mb, .. } => assert_eq!(mb, 5_000, "古い値は参考に見せる"),
            other => panic!("★境界より前の観測を fresh と言わないこと: {other:?}"),
        }
        聞き終えるまで(&host_free, 1).await;
        assert_eq!(probe.回数(), 1, "取得を起こしていること");
        assert!(matches!(
            host_free.outside(Some(boundary)),
            Outside::Fresh { mb: 2_000, .. }
        ));
    }

    /// `prefetch` は `outside` と同じ条件で起こす（設計§12-1）。
    #[tokio::test]
    async fn prefetchは境界より前の観測しかなければ起こし取得中なら起こさない() {
        let probe = 数える外側::遅れて答える(2_000, Duration::from_millis(500));
        let host_free = wslの一式(Arc::clone(&probe), Duration::from_secs(60));
        host_free.覚えさせる(5_000, Instant::now() - Duration::from_millis(10));

        host_free.prefetch(None);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(probe.回数(), 0, "境界が無く期限内なら起こさない");

        let boundary = Some(Instant::now());
        host_free.prefetch(boundary);
        host_free.prefetch(boundary);
        let _ = host_free.outside(boundary);
        聞き終えるまで(&host_free, 1).await;
        assert_eq!(
            probe.回数(),
            1,
            "★境界より前の観測しか無ければ起こし、取得中は2本目を起こさない"
        );
    }

    /// 印を立てただけでは待ち手を起こさない（設計§12-1）。待ち手が気にするのは取得の終わりだけ。
    #[tokio::test]
    async fn 印を立てただけでは待ち手を起こさない() {
        let probe = 数える外側::遅れて答える(2_000, Duration::from_millis(300));
        let host_free = wslの一式(probe, Duration::from_secs(60));
        let mut changes = host_free.heard.subscribe();
        changes.borrow_and_update();

        host_free.prefetch(None);
        assert!(host_free.取りに行っているか());
        assert!(
            !changes.has_changed().expect("送り手が居ること"),
            "★印を立てただけで待ち手を起こさないこと"
        );
        聞き終えるまで(&host_free, 1).await;
        assert!(
            changes.has_changed().expect("送り手が居ること"),
            "取得の終わりでは起こすこと"
        );
    }

    /// 聞けなかった理由は先頭の1行・200字まで（設計§12-5）。
    #[tokio::test]
    async fn 聞けなかった理由は先頭の1行200字までに詰める() {
        #[derive(Debug)]
        struct 長い失敗;
        impl HostFreeProbe for 長い失敗 {
            fn read(&self) -> Result<u64, String> {
                Err(format!("\n{}\n2行目のスタック\n3行目", "あ".repeat(500)))
            }
        }
        let host_free = HostFree::new(true, Arc::new(長い失敗), Duration::from_secs(60));
        let confirmed = host_free.confirm(None, 締切()).await;
        let Checked::Unconfirmed(reason) = confirmed.checked() else {
            panic!("聞けないこと: {confirmed:?}");
        };
        assert!(!reason.contains('\n'), "1行にすること: {reason:?}");
        assert!(!reason.contains("2行目"), "先頭の1行だけ: {reason:?}");
        assert!(
            reason.chars().count() <= 201,
            "200字まで（＋省略の印）: {}",
            reason.chars().count()
        );
        match host_free.outside(None) {
            Outside::Failed { reason, .. } => assert!(reason.chars().count() <= 201),
            other => panic!("抑え中は Failed: {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // 数える規則の1本（設計§4-1）
    // -----------------------------------------------------------------------

    #[test]
    fn assessの総当たり() {
        // 中が制約（WSL でない機械もここ）
        let a = assess(&姿(5_000, 500), Basis::NoOutside, None, 1_000, 2_000);
        assert_eq!(
            (a.counted_mb, a.effective_mb, a.fits, a.next_mb, a.limit),
            (None, 5_000, Some(3), 4_000, Limit::Wsl)
        );
        let a = assess(&姿(5_000, 500), Basis::Outside(9_000), None, 1_000, 2_000);
        assert_eq!((a.counted_mb, a.limit), (Some(5_000), Limit::Wsl));

        // Windows が制約。**見込みの起点は effective**（MemAvailable 20,000 へ戻らない）
        let a = assess(&姿(20_000, 400), Basis::Outside(4_000), None, 1_000, 2_000);
        assert_eq!(
            (a.counted_mb, a.effective_mb, a.fits, a.next_mb, a.limit),
            (Some(4_000), 4_000, Some(2), 3_000, Limit::Windows)
        );

        // 床が制約（表示の経路でだけ出る）
        let a = assess(&姿(20_000, 2_500), Basis::Floor, None, 1_000, 2_000);
        assert_eq!(
            (a.counted_mb, a.effective_mb, a.fits, a.limit),
            (Some(2_500), 2_500, Some(0), Limit::Floor)
        );

        // 予約が制約
        let a = assess(
            &姿(20_000, 400),
            Basis::Outside(5_000),
            Some(3_500),
            1_000,
            2_000,
        );
        assert_eq!(
            (a.counted_mb, a.effective_mb, a.fits, a.next_mb, a.limit),
            (Some(5_000), 3_500, Some(1), 2_500, Limit::Reserved)
        );

        // **予約を引いても枚数が変わらないなら、決めたのは土台の側**（実装レビュー Fable 1）。
        // 実機の数：Windows 側 2,800・余白 2,048・1枚 780・見込み 2,700。予約が無くても
        // (2,800 − 2,048) ÷ 780 = 0 枚なので、「1分待てば通る」は嘘になる
        let a = assess(
            &姿(20_000, 400),
            Basis::Outside(2_800),
            Some(2_700),
            780,
            2_048,
        );
        assert_eq!(
            (a.counted_mb, a.effective_mb, a.fits, a.limit),
            (Some(2_800), 2_700, Some(0), Limit::Windows),
            "★予約が枚数を変えていないのに、予約のせいにしている"
        );
        // 通すときも同じ（引く前も引いた後も 2 枚）
        let a = assess(
            &姿(20_000, 400),
            Basis::Outside(4_500),
            Some(4_200),
            1_000,
            2_000,
        );
        assert_eq!((a.fits, a.limit), (Some(2), Limit::Windows));
        // 中が制約の機械でも同じ（引く前 3,500 ÷ 1,000 も、引いた後 3,100 ÷ 1,000 も 3 枚）
        let a = assess(&姿(5_500, 500), Basis::NoOutside, Some(5_100), 1_000, 2_000);
        assert_eq!(
            (a.effective_mb, a.fits, a.limit),
            (5_100, Some(3), Limit::Wsl)
        );

        // 見積もり 0 は数えない。**枚数を比べられないので、予約のせいにもしない**
        let a = assess(&姿(20_000, 400), Basis::Outside(5_000), None, 0, 2_000);
        assert_eq!(a.fits, None);
        let a = assess(
            &姿(20_000, 400),
            Basis::Outside(5_000),
            Some(3_000),
            0,
            2_000,
        );
        assert_eq!((a.fits, a.limit), (None, Limit::Windows));
    }

    // -----------------------------------------------------------------------
    // 答えの3通り（設計§3 の表）
    // -----------------------------------------------------------------------

    #[test]
    fn wslでない機械の答えは1ビットも変わらない() {
        let resources = snapshot(&物差し(12_000, 1_000, 2_000), None, None).expect("読めること");
        assert_eq!(resources.fits_now, Some(10));
        assert_eq!(resources.host_free_mb, None);
        assert_eq!(resources.counted_mb, None, "抑えていないこと");
    }

    #[test]
    fn 外側を聞けたら少ないほうで数える() {
        let gauge = 物差しで外側が(12_000, 1_000, 2_000, wslで外側が(Some(5_000)));
        let resources = snapshot(&gauge, None, None).expect("読めること");
        // (5,000 − 2,000) / 1,000 = 3 枚。**外側で抑えなければ 10 枚**
        assert_eq!(resources.fits_now, Some(3));
        assert_eq!(resources.host_free_mb, Some(5_000));
        assert_eq!(resources.counted_mb, Some(5_000));
        // **機械が報告した空きは書き換えない**
        assert_eq!(resources.available_mb, 12_000);
    }

    /// 要件が引いている 2026-09-13 22:07:11 の実測を、そのまま再現する。
    ///
    /// **いまの式なら 21 枚**（`(18,983 − 2,048) / 780`）と答える。同じ瞬間、
    /// Windows の物理空きは 1,792 MB しかなかった。
    #[test]
    fn 実測の再現_外側が逼迫していれば0枚() {
        let gauge = 物差しで外側が(18_983, 780, 2_048, wslで外側が(Some(1_792)));
        let resources = snapshot(&gauge, None, None).expect("読めること");
        assert_eq!(
            resources.fits_now,
            Some(0),
            "Windows に 1.75 GB しか無いのに「21 枚入る」と答えないこと"
        );
        assert_eq!(resources.host_free_mb, Some(1_792));
        assert_eq!(resources.counted_mb, Some(1_792));
    }

    #[test]
    fn 外側を聞けないときはmemfreeで抑えて枚数が増えない() {
        // `名乗る` は `free_mb` も同じ値を名乗るので、ここでは別の口を使う
        #[derive(Debug)]
        struct 空きとフリーが違う(u64, u64);
        impl Probe for 空きとフリーが違う {
            fn read(&self) -> Option<Memory> {
                Some(Memory {
                    total_mb: 24_000,
                    available_mb: self.0,
                    swap_free_mb: 0,
                    free_mb: self.1,
                })
            }
        }
        let config = crate::config::SessionHostConfig {
            revive_estimate_mb: 780,
            revive_headroom_mb: 2_048,
            ..Default::default()
        };
        let 抑えた = snapshot(
            &Gauge::from_config(
                std::sync::Arc::new(空きとフリーが違う(18_983, 3_000)),
                wslで外側が(None),
                &config,
            ),
            None,
            None,
        )
        .expect("読めること");
        let 抑えない = snapshot(
            &Gauge::from_config(
                std::sync::Arc::new(空きとフリーが違う(18_983, 3_000)),
                wslでない(),
                &config,
            ),
            None,
            None,
        )
        .expect("読めること");
        // (3,000 − 2,048) / 780 = 1 枚。抑えなければ 21 枚
        assert_eq!(抑えた.fits_now, Some(1));
        assert_eq!(抑えない.fits_now, Some(21));
        assert!(
            抑えた.fits_now <= 抑えない.fits_now,
            "★外側を聞けないときに、枚数が「増えて」いないこと。\
             ここが増える向きに倒れていると、いちばん危ない側へ静かに倒れる"
        );
        // **「まだ聞けていません」が読み分けられること**
        assert_eq!(抑えた.host_free_mb, None);
        assert_eq!(抑えた.counted_mb, Some(3_000));
    }
}
