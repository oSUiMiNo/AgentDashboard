//! 自己修復が回をまたいで覚えておくこと（設計§9）。
//!
//! 置き場所は `<state_dir>/selfheal.json`。ここが消えても動作は続くが、
//! **対応済みの版を忘れる**ので、次の起動でもう一度カナリアが走る（＝クォータを使う）。
//! ビルド成果物の中や一時領域に置いてはいけない理由はパーサの再開位置と同じ。
//!
//! # 日時はエポックミリ秒で持つ
//!
//! 状態ファイルは人が開いて直すこともあるので、時刻の表現に解釈の余地を残さない。
//! ローカル時刻の文字列にすると「どのタイムゾーンで書かれたのか」が分からなくなる。
//! protocol の [`Timestamp`] と同じ扱いに揃えてある。

use crate::jsonfile;
use protocol::Timestamp;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// 版ごとの、直せなかった記録。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    /// 続けて失敗した回数
    pub attempts: u32,
    /// この時刻まで同じ版への再挑戦を控える（エポックミリ秒）
    pub cooldown_until: Timestamp,
}

/// 回をまたいで残す記録。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SelfhealState {
    /// パースできることを確かめ済みの Claude Code の版（設計§9 の「対応表」）
    pub known_versions: BTreeSet<String>,
    /// 版 → 直せなかった記録
    pub failures: BTreeMap<String, Failure>,
    /// 差し替え前に使っていたパーサ。悪化したときに戻す先
    pub previous_parser: Option<PathBuf>,
    /// この時刻までは、版に関わらず新しい修復を始めない（エポックミリ秒）。
    ///
    /// 版ごとのクールダウンだけでは足りない。**どのパーサでも読めないデータ**が
    /// 混ざっている場合、率の検知は版に関係なく何度でも発報するので、
    /// 「直す → 戻す → また直す」を延々と繰り返してカナリアと修復セッションを
    /// 起こし続けてしまう（クォータを使い切る）。
    pub next_attempt_at: Timestamp,
}

impl SelfhealState {
    pub fn path(state_dir: &Path) -> PathBuf {
        state_dir.join("selfheal.json")
    }

    pub fn load(state_dir: &Path) -> Self {
        jsonfile::load_or_default(&Self::path(state_dir))
    }

    pub fn save(&self, state_dir: &Path) {
        jsonfile::save(&Self::path(state_dir), self);
    }

    /// いま、この版に挑戦してよいか。
    pub fn in_cooldown(&self, version: &str, now: Timestamp) -> bool {
        self.failures
            .get(version)
            .is_some_and(|failure| now < failure.cooldown_until)
    }

    /// 直せなかったことを記録し、クールダウンに入れる。
    ///
    /// 呼ばれる時点で**その回の再試行は使い切っている**（設計§9-6 の「3回失敗 →
    /// 縮退＋24hクールダウン」）。ここでさらに回数を数えて待つかどうかを決めると、
    /// 上限の意味が二重になって「3×3回まで修復セッションが起動する」ことになる。
    pub fn record_failure(&mut self, version: &str, now: Timestamp, cooldown_hours: u64) {
        let failure = self.failures.entry(version.to_string()).or_default();
        failure.attempts += 1;
        failure.cooldown_until = now + hours(cooldown_hours);
        self.hold_off(now, cooldown_hours);
    }

    /// 版に関わらず、しばらく新しい修復を始めないようにする。
    pub fn hold_off(&mut self, now: Timestamp, cooldown_hours: u64) {
        self.next_attempt_at = self.next_attempt_at.max(now + hours(cooldown_hours));
    }

    /// いま新しい修復を始めてよいか。
    pub fn can_start(&self, now: Timestamp) -> bool {
        now >= self.next_attempt_at
    }

    /// 対応できたので、その版を対応表へ入れて失敗の記録を消す。
    pub fn record_success(&mut self, version: &str) {
        self.known_versions.insert(version.to_string());
        self.failures.remove(version);
    }
}

fn hours(count: u64) -> Timestamp {
    (count as i64) * 60 * 60 * 1_000
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-selfheal-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn 対応表は保存して読み直せる() {
        let dir = temp_dir("known");
        let mut state = SelfhealState::default();
        state.record_success("2.1.221");
        state.save(&dir);

        let loaded = SelfhealState::load(&dir);

        assert!(loaded.known_versions.contains("2.1.221"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 失敗したら設定した時間だけ再挑戦を控える() {
        let mut state = SelfhealState::default();
        let now = 1_700_000_000_000;

        state.record_failure("2.1.221", now, 24);

        assert!(state.in_cooldown("2.1.221", now));
        assert!(state.in_cooldown("2.1.221", now + 23 * 60 * 60 * 1_000));
        assert!(!state.in_cooldown("2.1.221", now + 25 * 60 * 60 * 1_000));
    }

    #[test]
    fn 戻したあとはしばらくどの版でも始めない() {
        // どのパーサでも読めないデータが混ざっていると、率の検知は版に関係なく
        // 何度でも発報する。版ごとの記録だけでは「直す → 戻す → また直す」が止まらない
        let mut state = SelfhealState::default();
        let now = 1_700_000_000_000;

        state.hold_off(now, 24);

        assert!(!state.can_start(now));
        assert!(!state.can_start(now + 23 * 60 * 60 * 1_000));
        assert!(state.can_start(now + 25 * 60 * 60 * 1_000));
    }

    #[test]
    fn 待ち時間は短いほうへ縮まらない() {
        // 後から短いクールダウンを足しても、先に決まった待ちを縮めない
        let mut state = SelfhealState::default();
        let now = 1_700_000_000_000;

        state.hold_off(now, 24);
        state.hold_off(now, 1);

        assert!(!state.can_start(now + 2 * 60 * 60 * 1_000));
    }

    #[test]
    fn 別の版はクールダウンに巻き込まれない() {
        // 版ごとに記録するのは、1つの版でつまずいたせいで次の更新に追随できなく
        // なることを避けるため
        let mut state = SelfhealState::default();
        let now = 1_700_000_000_000;

        state.record_failure("2.1.221", now, 24);

        assert!(!state.in_cooldown("2.1.222", now));
    }

    #[test]
    fn 対応できたら失敗の記録は消える() {
        // 消さないと、次に同じ版でつまずいたとき最初からクールダウン扱いになる
        let mut state = SelfhealState::default();
        let now = 1_700_000_000_000;
        state.record_failure("2.1.221", now, 24);

        state.record_success("2.1.221");

        assert!(!state.failures.contains_key("2.1.221"));
        assert!(state.known_versions.contains("2.1.221"));
    }

    #[test]
    fn 知らないキーが増えていても読める() {
        // 将来このファイルに項目が増えても、古い core が起動できなくなっては困らない
        let dir = temp_dir("forward");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            SelfhealState::path(&dir),
            r#"{"known_versions":["2.1.220"],"未来の項目":42}"#,
        )
        .unwrap();

        let loaded = SelfhealState::load(&dir);

        assert!(loaded.known_versions.contains("2.1.220"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
