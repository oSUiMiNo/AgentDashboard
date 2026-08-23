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

/// いま何枚起こし直せるか。
///
/// `(空き − 余白) ÷ 1枚あたりの見積もり` を切り捨てる。
///
/// **余白を引くのは、空きを 0 まで使わないため。** 戻したあとに何も動かせない機械が
/// 残ると、片付けることすらできなくなる。
///
/// **見積もりが 0 なら数えない**（`u32::MAX`）。歯止めを外したい人のための逃げ道で、
/// 0 除算の防御を兼ねている。
pub fn fits(available_mb: u64, headroom_mb: u64, estimate_mb: u64) -> u32 {
    if estimate_mb == 0 {
        return u32::MAX;
    }
    let usable = available_mb.saturating_sub(headroom_mb);
    u32::try_from(usable / estimate_mb).unwrap_or(u32::MAX)
}

/// いまの資源を1枚にまとめる（設計§18-2）。
///
/// **数える規則はここ1箇所。** `SessionManager` からも、線の答えを作るところからも
/// これを通す——2箇所に書くと、画面が「入る」と言ったものを PC が断ることが起こる。
///
/// 読めなければ `None`。**読めないことは異常ではない**（Linux 以外）。
pub fn snapshot(
    probe: &dyn Probe,
    estimate_mb: u64,
    headroom_mb: u64,
) -> Option<protocol::HostResources> {
    let memory = probe.read()?;
    Some(protocol::HostResources {
        total_mb: memory.total_mb,
        available_mb: memory.available_mb,
        swap_free_mb: memory.swap_free_mb,
        estimate_mb,
        headroom_mb,
        fits_now: fits(memory.available_mb, headroom_mb, estimate_mb),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空きから余白を引いた残りを見積もりで割る() {
        // (10000 - 2000) / 780 = 10.25… → 10
        assert_eq!(fits(10_000, 2_000, 780), 10);
    }

    #[test]
    fn 余白に届かなければ0枚() {
        assert_eq!(fits(2_000, 2_048, 780), 0);
        assert_eq!(fits(0, 2_048, 780), 0);
    }

    #[test]
    fn 境目はちょうど1枚を跨ぐ() {
        // 余白 + 見積もり ちょうどで 1 枚、1MB 足りなければ 0 枚
        assert_eq!(fits(2_048 + 780, 2_048, 780), 1);
        assert_eq!(fits(2_048 + 779, 2_048, 780), 0);
    }

    #[test]
    fn 見積もりが0なら数えない() {
        assert_eq!(fits(100, 2_048, 0), u32::MAX);
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
