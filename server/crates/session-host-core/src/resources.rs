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

/// `/proc/meminfo` の本文から3つを取り出す。
///
/// 単位は kB 固定（カーネルがそう書く）。**行が1つでも欠けたら `None`**——
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
    })
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
        config: &crate::config::SessionHostConfig,
    ) -> Self {
        Self {
            probe,
            estimate_mb: config.revive_estimate_mb,
            headroom_mb: config.revive_headroom_mb,
        }
    }

    /// 1枚あたりの見積もり（MB）。
    pub fn estimate_mb(&self) -> u64 {
        self.estimate_mb
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
    let memory = gauge.probe.read()?;
    Some(protocol::HostResources {
        total_mb: memory.total_mb,
        // **機械が報告した値は書き換えない。** 見込みは数えるためのもので、
        // 「いくら空いているか」の答えではない
        available_mb: memory.available_mb,
        swap_free_mb: memory.swap_free_mb,
        estimate_mb: gauge.estimate_mb,
        headroom_mb: gauge.headroom_mb,
        fits_now: fits(
            projected(memory.available_mb, projected_mb),
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
            })
        }
    }

    /// **入口を増やさない。** 設定から作る道（`from_config`）をテストでも通す
    fn 物差し(available_mb: u64, estimate_mb: u64, headroom_mb: u64) -> Gauge {
        let config = crate::config::SessionHostConfig {
            revive_estimate_mb: estimate_mb,
            revive_headroom_mb: headroom_mb,
            ..Default::default()
        };
        Gauge::from_config(std::sync::Arc::new(名乗る(available_mb)), &config)
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
}
