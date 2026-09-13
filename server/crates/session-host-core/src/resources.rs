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
    let field = |name: &str| -> Option<u64> {
        text.lines()
            .find(|line| line.starts_with(name) && line[name.len()..].starts_with(':'))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u64>().ok())
            .map(|kb| kb / 1024)
    };
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

/// 外側（WSL から見た Windows）の空きの状態。
///
/// **3通りしかない。** どれに当たるかで、数えるのに使う値が変わる（[`counted_available`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outside {
    /// WSL ではない。**外側という概念が無い**ので、いまと1ビットも変わらない
    NotWsl,
    /// WSL で、外側の空きを聞けた（MB）
    Known(u64),
    /// WSL だが、外側をまだ聞けていない。**少なく言う側へ倒れる**
    Unknown,
}

/// 数えるのに使う空き（MB）。**抑えていないなら `None`**（＝`available_mb` をそのまま使う）。
///
/// **外の世界へ出ない純関数。** [`parse_meminfo`] と同じ作法で、テストから総当たりできる。
///
/// # なぜ `Unknown` で `MemFree` を使うのか
///
/// 理由は3つ。
///
/// 1. **材料が WSL の中だけで揃う。** 外の世界へ出られないときの答えを、外の世界に
///    頼らずに出せる
/// 2. **`MemAvailable` より遥かに小さい**（実測：`MemAvailable` 15.25 GiB に対し
///    `MemFree` 0.44 GiB）。**キャッシュを当てにしない値**なので保守的
/// 3. **0 枚固定ではない。** 「WSL だが interop の無い構成」でも使えなくならず、
///    機械が空いていれば素直に増える
pub fn counted_available(memory: &Memory, outside: Outside) -> Option<u64> {
    match outside {
        Outside::NotWsl => None,
        Outside::Known(host_mb) => Some(memory.available_mb.min(host_mb)),
        Outside::Unknown => Some(memory.available_mb.min(memory.free_mb)),
    }
}

/// 外側（Windows）の空きを聞く口。
///
/// **トレイトにしてあるのはテストのため**（[`Probe`] と同じ理由）。「聞けた」
/// 「聞けなかった」の2通りを、**外の世界へ出ずに**作れる。
///
/// **同期で書いてある。** 呼ぶのは背景の仕事の中（[`HostFree::outside`]）なので、
/// **呼ぶ側が待つことはない。**
pub trait HostFreeProbe: Send + Sync + std::fmt::Debug {
    /// 外側の空き（MB）。**聞けなければ `None`。**
    fn read(&self) -> Option<u64>;
}

/// `powershell.exe` の置き場所（**絶対パス**）。
///
/// PATH に Windows の道が載らない構成（`appendWindowsPath=false`）でも通るように、
/// 探さずに直に指す。**`pwsh.exe` は既定で入っていないので使わない。**
const POWERSHELL: &str = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/// 外側を聞くのを諦めるまでの時間。
///
/// 実測は 6〜27 秒で、**逼迫しているときほど遅い**。**待つのは背景の仕事なので
/// 長めでよい**——画面は待たない。
const HOST_FREE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 本物。`powershell.exe` に `Win32_OperatingSystem` を聞く。
///
/// **`wmic.exe` は使わない。** この Windows（build 26200）に**存在しない**——
/// 2026 年の更新で削除済みである（実測）。
#[derive(Debug, Clone, Copy, Default)]
pub struct PowerShellHostFree;

impl HostFreeProbe for PowerShellHostFree {
    fn read(&self) -> Option<u64> {
        // **打ち切りは `proc::run` に任せる。** 同じものを2つ持つと片方だけ
        // 打ち切りを忘れる（`proc` のモジュール説明がそう言っている）。
        // 中で `kill` してから `wait` するので、**時間切れでもゾンビにならない。**
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
            tracing::warn!(
                program = POWERSHELL,
                timeout = ?HOST_FREE_TIMEOUT,
                detail = %outcome.output.trim(),
                "WSL の外側（Windows）の空きを聞けませんでした"
            );
            return None;
        }
        parse_host_free(&outcome.output)
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

/// 外側を知るための一式——**判定・聞く口・覚えている値**。
///
/// # なぜ覚えるのか
///
/// 外側を聞くのに 6〜27 秒かかるので、**押されるたびに聞くと画面が固まる。**
/// かといって定期的に聞き続けると、押されていないときも `powershell.exe` を
/// 立て続けることになる（**CPU を食う件と噛み合わない**）。
///
/// そこで**押されたときに、期限切れなら背景で取りに行き、答えそのものは待たない。**
/// 次に押したときには新しい値が在る。
///
/// # 弱点と、その手当て
///
/// **一度も読めていないうちは、機械が健康でも少なく言う。** 放置すると「壊れている」と
/// 読まれるので、**画面と CLI に「まだ聞けていません」と出す**（`HostResources` の
/// `host_free_mb` が `None` のまま `counted_mb` が入っている状態）。
#[derive(Debug)]
pub struct HostFree {
    is_wsl: bool,
    probe: std::sync::Arc<dyn HostFreeProbe>,
    /// 覚えておく期限。**0 なら外側を見ない**（＝いまの振る舞いに戻る逃げ道）
    ttl: std::time::Duration,
    last: std::sync::Mutex<Option<(u64, std::time::Instant)>>,
    /// **いま取りに行っているか。** 同時に2本起こさないための印
    fetching: std::sync::atomic::AtomicBool,
}

impl HostFree {
    /// 材料を全部渡して作る。**テストの入口でもある。**
    pub fn new(
        is_wsl: bool,
        probe: std::sync::Arc<dyn HostFreeProbe>,
        ttl: std::time::Duration,
    ) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            is_wsl,
            probe,
            ttl,
            last: std::sync::Mutex::new(None),
            fetching: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// 実機から作る。**ここで1回だけ温めておく**（設計§6-2）。
    ///
    /// 温めておくと、常駐しているダッシュボードでは**利用者が最初に押すときには
    /// もう値が在る**。温めなくても正しく動く（`Unknown` へ倒れるだけ）が、
    /// 1回目だけ少なく言う場面が減る。
    pub fn from_config(config: &crate::config::SessionHostConfig) -> std::sync::Arc<Self> {
        let host_free = Self::new(
            is_wsl(&WslSense::read()),
            std::sync::Arc::new(PowerShellHostFree),
            std::time::Duration::from_secs(config.revive_host_free_ttl_sec),
        );
        host_free.kick();
        host_free
    }

    /// いまの外側の状態。**待たない。**
    ///
    /// 期限切れの値は使わない——**古すぎる値で答えるくらいなら、少なく言うほうがよい。**
    pub fn outside(self: &std::sync::Arc<Self>) -> Outside {
        // **`ttl = 0` は「外側を見ない」。** いまの振る舞いへ戻す逃げ道で、
        // WSL でない機械と同じ答えになる
        if !self.is_wsl || self.ttl.is_zero() {
            return Outside::NotWsl;
        }
        let fresh = self
            .last
            .lock()
            .expect("ロックが壊れていない")
            .and_then(|(mb, at)| (at.elapsed() < self.ttl).then_some(mb));
        match fresh {
            Some(mb) => Outside::Known(mb),
            None => {
                self.kick();
                Outside::Unknown
            }
        }
    }

    /// 背景で取りに行く。**答えは待たない。**
    ///
    /// **実行時の取っ手が無ければ、静かに何もしない。** 取りに行けないことは
    /// 異常ではない（テストなど）——`Outside::Unknown` へ倒れるだけで、
    /// **答えは安全側に出る。**
    fn kick(self: &std::sync::Arc<Self>) {
        if !self.is_wsl || self.ttl.is_zero() {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        // **既に1本走っていれば増やさない。** 6〜27 秒かかるものを、押すたびに
        // 積み上げない
        if self
            .fetching
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let me = std::sync::Arc::clone(self);
        handle.spawn_blocking(move || {
            let read = me.probe.read();
            if let Some(mb) = read {
                *me.last.lock().expect("ロックが壊れていない") =
                    Some((mb, std::time::Instant::now()));
            }
            // **印は必ず戻す。** 戻し忘れると、以後1度も取りに行かなくなる
            me.fetching
                .store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }

    /// 覚えている値を直に入れる（**テスト専用**）。期限の判定はそのまま効く。
    #[doc(hidden)]
    pub fn 覚えさせる(&self, mb: u64, at: std::time::Instant) {
        *self.last.lock().expect("ロックが壊れていない") = Some((mb, at));
    }

    /// いま取りに行っているか（**テスト専用**）。
    #[doc(hidden)]
    pub fn 取りに行っているか(&self) -> bool {
        self.fetching.load(std::sync::atomic::Ordering::SeqCst)
    }
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

    /// いまの外側の状態。**待たない**（期限切れなら背景で取りに行くだけ）。
    pub fn outside(&self) -> Outside {
        self.host_free.outside()
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
/// 読めなければ `None`。**読めないことは異常ではない**（Linux 以外）。
pub fn snapshot(gauge: &Gauge, projected_mb: Option<u64>) -> Option<protocol::HostResources> {
    // **ここは触らない。** `Probe` が読めなければ、この `?` で早く返る——
    // 外側の判定にも取得にも1度も到達しないので、**「メモリそのものを読めない」と
    // 「WSL の外側を読めない」が混ざらない**（設計§10-1）
    let memory = gauge.probe.read()?;
    let outside = gauge.outside();
    let counted = counted_available(&memory, outside);
    Some(protocol::HostResources {
        total_mb: memory.total_mb,
        // **機械が報告した値は書き換えない。** 見込みは数えるためのもので、
        // 「いくら空いているか」の答えではない
        available_mb: memory.available_mb,
        swap_free_mb: memory.swap_free_mb,
        estimate_mb: gauge.estimate_mb,
        headroom_mb: gauge.headroom_mb,
        host_free_mb: match outside {
            Outside::Known(mb) => Some(mb),
            Outside::NotWsl | Outside::Unknown => None,
        },
        counted_mb: counted,
        fits_now: fits(
            // **抑えているならそちらで数える。** `projected` も `fits` も1文字も
            // 変えていない——渡す値が変わるだけである
            projected(counted.unwrap_or(memory.available_mb), projected_mb),
            gauge.headroom_mb,
            gauge.estimate_mb,
        ),
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
        fn read(&self) -> Option<u64> {
            self.0
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
        let 見込みなし = snapshot(&物差し(12_000, 1_000, 2_000), None).expect("読めること");
        assert_eq!(見込みなし.fits_now, Some(10));
        let 見込みあり = snapshot(&物差し(12_000, 1_000, 2_000), Some(9_000)).expect("読めること");
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
        let resources = snapshot(&物差し(3_000, 1_000, 2_000), Some(0)).expect("読めること");
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
        assert_eq!(counted_available(&姿(18_000, 500), Outside::NotWsl), None);
    }

    #[test]
    fn 外側が小さければ外側で数える() {
        // 要件が引いている 2026-09-13 22:07:11 の実測。**いまの式なら 21 枚と答える**
        assert_eq!(
            counted_available(&姿(18_983, 465), Outside::Known(1_792)),
            Some(1_792)
        );
    }

    #[test]
    fn 外側が大きければ内側で数える() {
        // **`min` が効く。** 外側が潤沢でも、WSL の中が細ければそちらが天井になる
        assert_eq!(
            counted_available(&姿(4_000, 500), Outside::Known(20_000)),
            Some(4_000)
        );
    }

    #[test]
    fn 外側を聞けなければmemfreeで抑える() {
        // **キャッシュを当てにしない値で抑える。** 0 枚固定ではないので、機械が
        // 空いていれば素直に増える
        assert_eq!(
            counted_available(&姿(18_983, 465), Outside::Unknown),
            Some(465)
        );
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
    // 覚えておく仕組み（設計§6）
    // -----------------------------------------------------------------------

    #[test]
    fn wslでなければ外側を見ない() {
        assert_eq!(wslでない().outside(), Outside::NotWsl);
    }

    #[test]
    fn 期限内なら覚えている値を使う() {
        let host_free = wslで外側が(Some(1_792));
        assert_eq!(host_free.outside(), Outside::Known(1_792));
    }

    #[test]
    fn 期限が切れたら古すぎる値で答えない() {
        // **古すぎる値で答えるくらいなら、少なく言うほうがよい**
        let host_free = HostFree::new(
            true,
            std::sync::Arc::new(外側(Some(1_792))),
            std::time::Duration::from_millis(1),
        );
        host_free.覚えさせる(
            1_792,
            std::time::Instant::now() - std::time::Duration::from_secs(3_600),
        );
        assert_eq!(host_free.outside(), Outside::Unknown);
    }

    #[test]
    fn 一度も読めていなければ聞けていないと言う() {
        // 起動直後。**背景で取りに行くが、答えは待たない**
        let host_free = wslで外側が(None);
        assert_eq!(host_free.outside(), Outside::Unknown);
    }

    /// **逃げ道が効くこと。** いまの振る舞いへ戻せないと、判定が外れたときに
    /// 設定で回避できない。
    #[test]
    fn 期限が0なら外側を見ない() {
        let host_free = HostFree::new(
            true,
            std::sync::Arc::new(外側(Some(1_792))),
            std::time::Duration::ZERO,
        );
        assert_eq!(host_free.outside(), Outside::NotWsl);
    }

    /// **実行時の取っ手が無くても落ちない。** 取りに行けないことは異常ではない——
    /// `Unknown` へ倒れるだけで、**答えは安全側に出る。**
    #[test]
    fn 取っ手が無い場面でも落ちない() {
        let host_free = wslで外側が(None);
        assert_eq!(host_free.outside(), Outside::Unknown);
        assert!(
            !host_free.取りに行っているか(),
            "取っ手が無いのだから、取りに行った印も立たないこと"
        );
    }

    #[tokio::test]
    async fn 同時に2本取りに行かない() {
        // **6〜27 秒かかるものを、押すたびに積み上げない**
        #[derive(Debug)]
        struct 終わらない外側(std::sync::Arc<std::sync::atomic::AtomicUsize>);
        impl HostFreeProbe for 終わらない外側 {
            fn read(&self) -> Option<u64> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(300));
                Some(1_000)
            }
        }
        let 回数 = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let host_free = HostFree::new(
            true,
            std::sync::Arc::new(終わらない外側(std::sync::Arc::clone(&回数))),
            std::time::Duration::from_secs(60),
        );
        for _ in 0..5 {
            assert_eq!(host_free.outside(), Outside::Unknown);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(
            回数.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "5回押しても、外側へ聞きに行くのは1本だけであること"
        );
        // 取れたら次からは覚えている値で即答する
        assert_eq!(host_free.outside(), Outside::Known(1_000));
    }

    // -----------------------------------------------------------------------
    // 答えの3通り（設計§3 の表）
    // -----------------------------------------------------------------------

    #[test]
    fn wslでない機械の答えは1ビットも変わらない() {
        let resources = snapshot(&物差し(12_000, 1_000, 2_000), None).expect("読めること");
        assert_eq!(resources.fits_now, Some(10));
        assert_eq!(resources.host_free_mb, None);
        assert_eq!(resources.counted_mb, None, "抑えていないこと");
    }

    #[test]
    fn 外側を聞けたら少ないほうで数える() {
        let gauge = 物差しで外側が(12_000, 1_000, 2_000, wslで外側が(Some(5_000)));
        let resources = snapshot(&gauge, None).expect("読めること");
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
        let resources = snapshot(&gauge, None).expect("読めること");
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
        )
        .expect("読めること");
        let 抑えない = snapshot(
            &Gauge::from_config(
                std::sync::Arc::new(空きとフリーが違う(18_983, 3_000)),
                wslでない(),
                &config,
            ),
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
