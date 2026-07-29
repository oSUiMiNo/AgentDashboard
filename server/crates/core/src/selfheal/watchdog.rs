//! 「フォーマットが変わった」ことに気づく部分（設計§9 の二段検知）。
//!
//! # なぜ二段なのか
//!
//! - **予防的（版）** … 知らない `version` を初めて見たら、壊れる前に確かめにいく
//! - **事後的（率）** … 実際にパースが失敗し始めたら、版に関係なく発報する
//!
//! 版だけを見ていると、版が据え置きのまま中身が変わったときに気づけない。率だけを見て
//! いると、気づくのが「もう壊れている」あとになる。両方を持って初めて、
//! 「更新された → 確かめる → 必要なら直す」という順番が成立する。
//!
//! # ここは判定だけを持つ
//!
//! パーサ（修復される側）は観測値を数えるだけで、閾値の判定は core（このモジュール）が
//! する。修復対象のコードに自分の故障判定を持たせると、フォーマット変更で判定そのものが
//! 壊れたときに、壊れたことに誰も気づけなくなる。

use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// 率を見る窓の大きさ（レコード数）。設計§9 の「直近1000レコード窓」。
const WINDOW_RECORDS: u64 = 1_000;

/// 判定を始めるのに要る最小のレコード数。
///
/// 窓が埋まるまで待つと、**全滅しているのに何百行も黙って読み続ける**ことになる。
/// かといって数件で判定すると、1件の失敗が 33% のような極端な率になって誤発報する。
/// 「そこそこ読んで、それでも失敗が多い」を見るための下限。
const MIN_SAMPLE: u64 = 200;

/// パースの失敗率のしきい値（設計§9）。
const PARSE_ERROR_RATIO: f64 = 0.05;
/// 親に繋がらないレコードの率のしきい値（設計§9）。
const ORPHAN_RATIO: f64 = 0.10;

/// パーサが報告してくる累計のカウンタ（[`protocol::ipc::ParserEvent::Stats`] の中身）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counters {
    pub records_total: u64,
    pub parse_errors: u64,
    pub orphans: u64,
}

/// 検知の理由。修復セッションへ渡す手掛かりにもなる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    /// 知らない版を初めて見た（予防的）
    UnknownVersion { version: String },
    /// 直近の窓でパースの失敗が多すぎる（事後的）
    ParseErrors {
        errors: u64,
        records: u64,
        unknown_types: BTreeMap<String, u64>,
    },
    /// 直近の窓で親に繋がらないレコードが多すぎる（事後的）
    Orphans { orphans: u64, records: u64 },
}

impl Trigger {
    /// 画面と修復プロンプトに出す説明。
    pub fn detail(&self) -> String {
        match self {
            Trigger::UnknownVersion { version } => {
                format!("知らない Claude Code の版を見つけました: {version}")
            }
            Trigger::ParseErrors {
                errors,
                records,
                unknown_types,
            } => {
                let kinds: Vec<String> = unknown_types
                    .iter()
                    .map(|(name, count)| format!("{name}×{count}"))
                    .collect();
                let kinds = if kinds.is_empty() {
                    String::new()
                } else {
                    format!("。知らないレコード種別: {}", kinds.join(", "))
                };
                format!("直近 {records} 件中 {errors} 件のパースに失敗しました{kinds}")
            }
            Trigger::Orphans { orphans, records } => {
                format!("直近 {records} 件中 {orphans} 件が親に繋がりませんでした")
            }
        }
    }
}

/// カード1枚ぶんの窓。
///
/// パーサのカウンタは単調増加なので、**前回との差分**を溜めて窓を作る。累計のまま率を
/// 見ると、セッションの序盤に起きた失敗がいつまでも分母に残り、直ったことにも壊れたことにも
/// 気づけなくなる。
#[derive(Debug, Default)]
struct CardWindow {
    previous: Option<Counters>,
    deltas: VecDeque<Counters>,
    records: u64,
    errors: u64,
    orphans: u64,
}

impl CardWindow {
    /// 新しい累計を受け取り、窓を更新する。
    fn observe(&mut self, current: Counters) {
        // 初回は 0 からの差分として扱う。パーサは core が起動する子プロセスなので、
        // カウンタは**必ず 0 から始まる**。ここを「差分が取れない」と捨てると、
        // 差し替え直後に読んだ最初の一群が検知の目に入らなくなる
        let previous = self.previous.replace(current).unwrap_or_default();
        // パーサを差し替えるとカウンタは 0 から数え直しになる。減っていたら窓を捨てる
        if current.records_total < previous.records_total {
            self.reset();
            return;
        }

        let delta = Counters {
            records_total: current.records_total - previous.records_total,
            parse_errors: current.parse_errors.saturating_sub(previous.parse_errors),
            orphans: current.orphans.saturating_sub(previous.orphans),
        };
        if delta.records_total == 0 {
            return;
        }

        self.records += delta.records_total;
        self.errors += delta.parse_errors;
        self.orphans += delta.orphans;
        self.deltas.push_back(delta);

        // 窓からはみ出したぶんを古い方から落とす。
        // 直近の1件だけは必ず残す — 1回の報告が窓より大きいことがあり（巨大な
        // トランスクリプトを一気に読んだ場合）、全部落とすと窓が空になって
        // 「標本が足りない」と判断し続けてしまう
        while self.records > WINDOW_RECORDS && self.deltas.len() > 1 {
            let Some(oldest) = self.deltas.pop_front() else {
                break;
            };
            self.records -= oldest.records_total;
            self.errors -= oldest.parse_errors;
            self.orphans -= oldest.orphans;
        }
    }

    fn reset(&mut self) {
        self.deltas.clear();
        self.records = 0;
        self.errors = 0;
        self.orphans = 0;
    }

    fn verdict(&self, unknown_types: &BTreeMap<String, u64>) -> Option<Trigger> {
        if self.records < MIN_SAMPLE {
            return None;
        }
        let records = self.records as f64;
        if self.errors as f64 / records > PARSE_ERROR_RATIO {
            return Some(Trigger::ParseErrors {
                errors: self.errors,
                records: self.records,
                unknown_types: unknown_types.clone(),
            });
        }
        if self.orphans as f64 / records > ORPHAN_RATIO {
            return Some(Trigger::Orphans {
                orphans: self.orphans,
                records: self.records,
            });
        }
        None
    }
}

/// 全カードぶんの見張り。
#[derive(Debug, Default)]
pub struct Watchdog {
    windows: BTreeMap<String, CardWindow>,
}

impl Watchdog {
    pub fn new() -> Self {
        Self::default()
    }

    /// stats を1件受け取り、発報すべきなら理由を返す。
    ///
    /// `known_versions` には「パースできることを確認済みの版」を渡す。版の判定を率より
    /// 先に見るのは、**壊れる前に確かめる**のが予防的検知の目的だから。
    pub fn observe(
        &mut self,
        card_id: &str,
        counters: Counters,
        unknown_types: &BTreeMap<String, u64>,
        versions: &BTreeSet<String>,
        known_versions: &BTreeSet<String>,
    ) -> Option<Trigger> {
        let window = self.windows.entry(card_id.to_string()).or_default();
        window.observe(counters);
        let rate_verdict = window.verdict(unknown_types);

        if let Some(version) = versions
            .iter()
            .find(|version| !known_versions.contains(*version))
        {
            return Some(Trigger::UnknownVersion {
                version: version.clone(),
            });
        }
        rate_verdict
    }

    /// 発報したあと、同じ窓で連続して発報しないように畳む。
    ///
    /// これが無いと、1回の異常で修復が走っている最中に次々と発報が積み上がる。
    pub fn forget(&mut self, card_id: &str) {
        self.windows.remove(card_id);
    }

    /// いま窓に溜まっている失敗率（ロールバックの判定に使う）。
    ///
    /// 標本が足りないうちは `None`。少ない標本で「悪化した」と判断して戻すほうが害が大きい。
    pub fn error_ratio(&self, card_id: &str) -> Option<f64> {
        let window = self.windows.get(card_id)?;
        (window.records >= MIN_SAMPLE).then(|| window.errors as f64 / window.records as f64)
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn counters(records: u64, errors: u64, orphans: u64) -> Counters {
        Counters {
            records_total: records,
            parse_errors: errors,
            orphans,
        }
    }

    fn versions(all: &[&str]) -> BTreeSet<String> {
        all.iter().map(|v| v.to_string()).collect()
    }

    fn observe(
        watchdog: &mut Watchdog,
        current: Counters,
        known: &BTreeSet<String>,
    ) -> Option<Trigger> {
        watchdog.observe(
            "card",
            current,
            &BTreeMap::new(),
            &versions(&["2.1.220"]),
            known,
        )
    }

    #[test]
    fn 初回の観測も0からの差分として数える() {
        // パーサは core が起動する子プロセスなので、カウンタは必ず 0 から始まる。
        // 初回を捨てると、差し替えた直後に読んだ最初の一群を見逃す
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        let trigger = observe(&mut watchdog, counters(5_000, 4_000, 0), &known);
        assert!(
            matches!(trigger, Some(Trigger::ParseErrors { .. })),
            "実際: {trigger:?}"
        );
    }

    #[test]
    fn 標本が少ないうちは発報しない() {
        // 3件中1件の失敗を 33% と読んで発報すると、起動直後に必ず誤発報する
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        observe(&mut watchdog, counters(0, 0, 0), &known);
        assert_eq!(observe(&mut watchdog, counters(3, 1, 0), &known), None);
    }

    #[test]
    fn 失敗率が5パーセントを超えたら発報する() {
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        observe(&mut watchdog, counters(0, 0, 0), &known);

        // 300件中 20件（6.7%）
        let trigger = observe(&mut watchdog, counters(300, 20, 0), &known);

        assert!(
            matches!(
                trigger,
                Some(Trigger::ParseErrors {
                    errors: 20,
                    records: 300,
                    ..
                })
            ),
            "実際: {trigger:?}"
        );
    }

    #[test]
    fn 失敗率が5パーセント以内なら発報しない() {
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        observe(&mut watchdog, counters(0, 0, 0), &known);
        assert_eq!(observe(&mut watchdog, counters(300, 15, 0), &known), None);
    }

    #[test]
    fn 孤児率が10パーセントを超えたら発報する() {
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        observe(&mut watchdog, counters(0, 0, 0), &known);

        let trigger = observe(&mut watchdog, counters(300, 0, 40), &known);

        assert!(
            matches!(
                trigger,
                Some(Trigger::Orphans {
                    orphans: 40,
                    records: 300
                })
            ),
            "実際: {trigger:?}"
        );
    }

    #[test]
    fn 古い失敗は窓から出ていく() {
        // 序盤に失敗が固まっても、そのあと正常に読めているなら直っている
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        observe(&mut watchdog, counters(0, 0, 0), &known);
        assert!(observe(&mut watchdog, counters(300, 100, 0), &known).is_some());

        // 以降 1200件を失敗なしで読む（窓 1000 からは古い300件が押し出される）
        let mut total = 300;
        let mut last = None;
        for _ in 0..12 {
            total += 100;
            last = observe(&mut watchdog, counters(total, 100, 0), &known);
        }
        assert_eq!(last, None, "窓から出た失敗で発報し続けている");
    }

    #[test]
    fn カウンタが巻き戻ったら窓を作り直す() {
        // パーサを差し替えると 0 から数え直しになる。差分が負になるので、
        // そのまま引くと巨大な値になって誤発報する
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        observe(&mut watchdog, counters(0, 0, 0), &known);
        observe(&mut watchdog, counters(500, 0, 0), &known);

        assert_eq!(observe(&mut watchdog, counters(10, 0, 0), &known), None);
        assert_eq!(watchdog.error_ratio("card"), None, "窓が作り直されていない");
    }

    #[test]
    fn 知らない版は率より先に発報する() {
        // 壊れてから気づくのでは予防にならない
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.219"]);
        let trigger = observe(&mut watchdog, counters(0, 0, 0), &known);
        assert_eq!(
            trigger,
            Some(Trigger::UnknownVersion {
                version: "2.1.220".to_string()
            })
        );
    }

    #[test]
    fn 対応済みの版では発報しない() {
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        assert_eq!(observe(&mut watchdog, counters(0, 0, 0), &known), None);
    }

    #[test]
    fn 発報したカードの窓は畳める() {
        let mut watchdog = Watchdog::new();
        let known = versions(&["2.1.220"]);
        observe(&mut watchdog, counters(0, 0, 0), &known);
        observe(&mut watchdog, counters(300, 100, 0), &known);
        assert!(watchdog.error_ratio("card").is_some());

        watchdog.forget("card");

        assert_eq!(watchdog.error_ratio("card"), None);
    }
}
