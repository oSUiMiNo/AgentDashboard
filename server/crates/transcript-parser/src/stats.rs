//! パースの健康状態の集計（設計§8/§9）。
//!
//! ここは**観測に徹する**。「率が閾値を超えたら異常」という判定は core 側（設計§9）に置く。
//! 修復対象のコード（このクレート）に自分の故障判定を持たせると、フォーマット変更で
//! 判定そのものが壊れたときに、壊れたことに誰も気づけなくなる。

use std::collections::{BTreeMap, BTreeSet};

/// 単調増加のカウンタ群。core がこれを見て率を計算する。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    /// 率の分母。設計§9 は率で判定するので必須
    pub records_total: u64,
    pub parse_errors: u64,
    /// 未知の type とその出現数。修復セッションへ渡す手掛かりになる
    pub unknown_types: BTreeMap<String, u64>,
    /// 親を指しているのに親が見つからなかったレコードの数
    pub orphans: u64,
    /// 観測した `version` の集合。
    ///
    /// 1ファイル内に複数バージョンが混在しうる（compact / resume を跨ぐため）ので、
    /// 「ファイルの版」ではなく「観測した版の集合」として持つ。
    pub versions: BTreeSet<String>,
}

impl Stats {
    pub fn record(&mut self) {
        self.records_total += 1;
    }

    pub fn parse_error(&mut self) {
        self.parse_errors += 1;
    }

    pub fn unknown_type(&mut self, record_type: &str) {
        *self
            .unknown_types
            .entry(record_type.to_string())
            .or_insert(0) += 1;
    }

    pub fn orphan(&mut self) {
        self.orphans += 1;
    }

    pub fn version(&mut self, version: &str) {
        if !self.versions.contains(version) {
            self.versions.insert(version.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    #[test]
    fn 未知の種別は種別ごとに数える() {
        let mut stats = Stats::default();
        stats.unknown_type("brand-new");
        stats.unknown_type("brand-new");
        stats.unknown_type("another");
        assert_eq!(stats.unknown_types.get("brand-new"), Some(&2));
        assert_eq!(stats.unknown_types.get("another"), Some(&1));
    }

    #[test]
    fn 版は集合として溜まる() {
        // 1ファイルに複数バージョンが混ざる実例があるため、上書きではなく集合にする
        let mut stats = Stats::default();
        stats.version("2.1.196");
        stats.version("2.1.220");
        stats.version("2.1.220");
        assert_eq!(stats.versions.len(), 2);
    }
}
