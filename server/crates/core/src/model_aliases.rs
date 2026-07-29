//! 別名がこの環境で何に解決されるかを、実測から覚える（設計§12）。
//!
//! # なぜ覚える必要があるのか
//!
//! 画面のプルダウンに並ぶのは切り替え先の**別名**（`opus`）だが、利用者が見たいのは
//! **版番号入りの名前**（`Opus 5`）である。ところが別名と版番号の対応は、
//! こちらの表には書けない。
//!
//! - **古びる。** モデルは定期的に更新される
//! - **環境によって違う。** `opus` は Anthropic API なら Opus 5、Microsoft Foundry なら
//!   Opus 4.6 に解決される
//!
//! CLI にモデル一覧を名乗らせる入口も無い（`claude --help` の `--model` に choices が
//! 出ない。権限モードとはここが違う）。
//!
//! そこで**切り替えた結果 CLI が名乗った値を覚える**。表に版番号を持たないまま、
//! 実測だけで版番号を出せる。
//!
//! # 推測で埋めない
//!
//! 一度も選んでいない別名は、ここに現れない。「この環境でその別名が何に解決されるか」を
//! ダッシュボードは知らないからで、知らないものを埋めるとそれは嘘になる。
//! 画面では括弧が付かないだけで、機能は何も損なわれない。

use crate::jsonfile;
use protocol::ModelId;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// 状態ディレクトリに置くファイル名。
const FILE_NAME: &str = "model-aliases.json";

/// 別名1つ分の実測結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AliasSeen {
    /// 送った別名（`opus`）
    pub alias: ModelId,
    /// CLI が名乗ったフルID（`claude-opus-5`）
    pub id: ModelId,
    /// CLI が名乗った表示名（`Opus 5`）
    pub display_name: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    seen: Vec<AliasSeen>,
}

/// 学習した対応表。
pub struct ModelAliases {
    /// 残す先。`None` なら覚えるだけで永続化しない（統合テスト用）
    path: Option<PathBuf>,
    state: Mutex<Vec<AliasSeen>>,
}

impl ModelAliases {
    /// 状態ディレクトリから読み込む。
    ///
    /// 読めなければ空から始める（[`jsonfile::load_or_default`] の約束）。ここが
    /// 壊れても失うのは括弧の中身だけで、切替も表示も動き続ける。
    pub fn load(state_dir: Option<PathBuf>) -> Self {
        let path = state_dir.map(|dir| dir.join(FILE_NAME));
        let seen = match path.as_deref() {
            Some(path) => jsonfile::load_or_default::<Stored>(path).seen,
            None => Vec::new(),
        };
        Self {
            path,
            state: Mutex::new(seen),
        }
    }

    /// 覚えていない状態から始める（テスト用）。
    pub fn in_memory() -> Self {
        Self {
            path: None,
            state: Mutex::new(Vec::new()),
        }
    }

    /// その別名が解決される先。覚えていなければ `None`。
    pub fn resolve(&self, alias: &ModelId) -> Option<ModelId> {
        self.state
            .lock()
            .expect("ロックが壊れていない")
            .iter()
            .find(|entry| &entry.alias == alias)
            .map(|entry| entry.id.clone())
    }

    /// 画面へ配る一覧。
    pub fn all(&self) -> Vec<AliasSeen> {
        self.state.lock().expect("ロックが壊れていない").clone()
    }

    /// 実測を1件覚える。変わったときだけ `true`。
    ///
    /// 同じ別名を2回目に観測したときは**上書きする**。モデルが更新されて解決先が
    /// 変わることがあるので、古い対応を握り続けてはいけない。
    pub fn learn(&self, alias: &ModelId, id: &ModelId, display_name: &str) -> bool {
        let entry = AliasSeen {
            alias: alias.clone(),
            id: id.clone(),
            display_name: display_name.to_string(),
        };

        {
            let mut seen = self.state.lock().expect("ロックが壊れていない");
            match seen.iter_mut().find(|known| known.alias == entry.alias) {
                Some(known) if *known == entry => return false,
                Some(known) => *known = entry,
                None => seen.push(entry),
            }
        }

        self.persist();
        true
    }

    fn persist(&self) {
        let Some(path) = self.path.as_deref() else {
            return;
        };
        let stored = Stored { seen: self.all() };
        // 書けなくても動作は止めない。次回また学び直すだけ
        jsonfile::save(path, &stored);
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn id(value: &str) -> ModelId {
        ModelId::new(value)
    }

    #[test]
    fn 覚えていない別名は解決できない() {
        // 推測で埋めない。知らないものは知らないと答える
        let aliases = ModelAliases::in_memory();
        assert_eq!(aliases.resolve(&id("opus")), None);
        assert!(aliases.all().is_empty());
    }

    #[test]
    fn 覚えた別名は解決できる() {
        let aliases = ModelAliases::in_memory();
        assert!(aliases.learn(&id("opus"), &id("claude-opus-5"), "Opus 5"));
        assert_eq!(aliases.resolve(&id("opus")), Some(id("claude-opus-5")));
        assert_eq!(
            aliases.all(),
            vec![AliasSeen {
                alias: id("opus"),
                id: id("claude-opus-5"),
                display_name: "Opus 5".to_string(),
            }]
        );
    }

    #[test]
    fn 同じ実測を繰り返しても増えない() {
        let aliases = ModelAliases::in_memory();
        assert!(aliases.learn(&id("opus"), &id("claude-opus-5"), "Opus 5"));
        assert!(
            !aliases.learn(&id("opus"), &id("claude-opus-5"), "Opus 5"),
            "変わっていなければ false"
        );
        assert_eq!(aliases.all().len(), 1);
    }

    #[test]
    fn 解決先が変わったら上書きする() {
        // モデルが更新されると別名の解決先も変わる。古い対応を握り続けてはいけない
        let aliases = ModelAliases::in_memory();
        aliases.learn(&id("opus"), &id("claude-opus-5"), "Opus 5");
        assert!(aliases.learn(&id("opus"), &id("claude-opus-6"), "Opus 6"));
        assert_eq!(aliases.resolve(&id("opus")), Some(id("claude-opus-6")));
        assert_eq!(aliases.all().len(), 1, "増えずに置き換わること");
    }

    #[test]
    fn 別名ごとに独立して覚える() {
        let aliases = ModelAliases::in_memory();
        aliases.learn(&id("opus"), &id("claude-opus-5"), "Opus 5");
        aliases.learn(&id("sonnet"), &id("claude-sonnet-5"), "Sonnet 5");
        assert_eq!(aliases.resolve(&id("opus")), Some(id("claude-opus-5")));
        assert_eq!(aliases.resolve(&id("sonnet")), Some(id("claude-sonnet-5")));
    }

    #[test]
    fn 保存して読み直せる() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-model-aliases-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let aliases = ModelAliases::load(Some(dir.clone()));
        aliases.learn(&id("fable"), &id("claude-fable-5"), "Fable 5");

        let reloaded = ModelAliases::load(Some(dir.clone()));
        assert_eq!(reloaded.resolve(&id("fable")), Some(id("claude-fable-5")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 置き場所が無くても動く() {
        // 状態ディレクトリを解決できない環境でも、覚えるところまでは働く
        let aliases = ModelAliases::load(None);
        assert!(aliases.learn(&id("haiku"), &id("claude-haiku-4-5"), "Haiku 4.5"));
        assert_eq!(aliases.resolve(&id("haiku")), Some(id("claude-haiku-4-5")));
    }
}
