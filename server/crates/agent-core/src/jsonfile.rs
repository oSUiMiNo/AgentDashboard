//! 状態ファイル（JSON）の読み書き。
//!
//! パーサの再開位置（[`crate::parser`]）と自己修復の記録（[`crate::selfheal`]）で使う。
//! どちらも**消えても動き続けるが、壊れて残ると厄介**という性質が同じなので、扱いを
//! 1箇所にまとめてある。
//!
//! 守っている約束は2つ。
//!
//! - **読めない中身は既定値として扱う**。ここで落とすと、状態ファイルが1つ壊れただけで
//!   ダッシュボードが起動しなくなる。位置や記録は作り直せるが、起動できないのは困る
//! - **書くときは一時ファイルへ書いてから置き換える**。途中で落ちても、半分だけ書かれた
//!   JSON が残らない（次回の読み込みが必ず成功する）

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::Path;

/// 読めなければ既定値を返す。
pub fn load_or_default<T: Default + DeserializeOwned>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 一時ファイル経由で置き換える。書けなかった場合は黙って諦める。
///
/// 保存できないこと自体は動作を止める理由にならない（次回は先頭から読み直すだけ）。
pub fn save<T: Serialize>(path: &Path, value: &T) {
    let Some(dir) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(text) = serde_json::to_string(value) else {
        return;
    };
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, text).is_ok() {
        let _ = std::fs::rename(&temporary, path);
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use std::collections::BTreeMap;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-jsonfile-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn 書いたものを読み直せる() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("state.json");
        let mut value = BTreeMap::new();
        value.insert("版".to_string(), 3u32);

        save(&path, &value);
        let loaded: BTreeMap<String, u32> = load_or_default(&path);

        assert_eq!(loaded.get("版"), Some(&3));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 壊れた中身は既定値として読む() {
        // ここで落とすと、状態ファイルが壊れただけで起動できなくなる
        let dir = temp_dir("broken");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        std::fs::write(&path, "{壊れている").unwrap();

        let loaded: BTreeMap<String, u32> = load_or_default(&path);

        assert!(loaded.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 保存の途中経過が本体として残らない() {
        // 一時ファイルへ書いてから置き換えるので、本体は常に読める状態になっている
        let dir = temp_dir("atomic");
        let path = dir.join("state.json");
        save(&path, &BTreeMap::from([("a".to_string(), 1u32)]));
        save(&path, &BTreeMap::from([("b".to_string(), 2u32)]));

        let loaded: BTreeMap<String, u32> = load_or_default(&path);

        assert_eq!(loaded.get("b"), Some(&2));
        assert!(!dir.join("state.tmp").exists(), "一時ファイルが残っている");
        let _ = std::fs::remove_dir_all(dir);
    }
}
