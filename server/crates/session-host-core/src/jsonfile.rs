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
///
/// **まだ無いのは初回起動の正常な道**なので黙る。それ以外（権限・I/O）と、中身が
/// JSON として読めない場合は、諦めた事実だけを残す（設計§10-1）。冒頭が言っている
/// 「壊れて残ると厄介」を実際に踏んだとき、いままで何も出ていなかった。
pub fn load_or_default<T: Default + DeserializeOwned>(path: &Path) -> T {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return T::default(),
        Err(err) => {
            load_gave_up(path, &format!("{err}"));
            return T::default();
        }
    };
    match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            load_gave_up(path, &format!("中身が JSON として読めない: {err}"));
            T::default()
        }
    }
}

/// 一時ファイル経由で置き換える。書けなかった場合は諦める。
///
/// 保存できないこと自体は動作を止める理由にならない（次回は先頭から読み直すだけ）。
/// **判断は変えない。諦めたことと、その理由だけを残す**（設計§10-1）。
///
/// 諦め口は**5つある**。1回の呼び出しで通るのは必ず1つなので、5つとも残しても
/// 行数は増えない。1つだけ残すと、残り4つの無音がどこにも映らないまま残る。
pub fn save<T: Serialize>(path: &Path, value: &T) {
    let Some(dir) = path.parent() else {
        save_gave_up(path, "置き場所（親フォルダ）が決まらない");
        return;
    };
    if let Err(err) = std::fs::create_dir_all(dir) {
        save_gave_up(path, &format!("置き場所を作れない: {err}"));
        return;
    }
    let text = match serde_json::to_string(value) {
        Ok(text) => text,
        Err(err) => {
            save_gave_up(path, &format!("JSON にできない: {err}"));
            return;
        }
    };
    let temporary = path.with_extension("tmp");
    match std::fs::write(&temporary, text) {
        Ok(()) => {
            if let Err(err) = std::fs::rename(&temporary, path) {
                save_gave_up(path, &format!("一時ファイルを置き換えられない: {err}"));
            }
        }
        Err(err) => save_gave_up(path, &format!("一時ファイルへ書けない: {err}")),
    }
}

/// 諦めたことだけを残す。**動作は止めない**（この関数の存在理由がそれ）。
///
/// `debug` なのは、諦めること自体が設計判断だから（設計§10-1）。既定の
/// `log_file_level` が `debug` なのでファイルには残り、端末は汚さない。
fn save_gave_up(path: &Path, why: &str) {
    tracing::debug!(path = %path.display(), "状態ファイルを保存できないので諦めます: {why}");
}

fn load_gave_up(path: &Path, why: &str) {
    tracing::debug!(path = %path.display(), "状態ファイルを読めないので既定から始めます: {why}");
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

    /// 諦めた口ごとに1行残ること（設計§10-1）。
    ///
    /// **判断は変えない**——どの口も動作を止めず、既定へ落ちる。変えたのは
    /// 「諦めたことが誰にも見えない」ところだけである。
    mod 諦めた口が声を持つ {
        use super::*;
        use crate::logging::capture;

        /// `mark` から後で、本文にこの語を含む行。
        fn 諦めの行(mark: usize, 含む: &str) -> Vec<serde_json::Value> {
            capture::sink()
                .since(mark)
                .into_iter()
                .filter(|line| {
                    line.get("msg")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|msg| msg.contains(含む))
                })
                .collect()
        }

        #[test]
        fn 置き場所が決まらない() {
            let sink = capture::sink();
            let mark = sink.mark();
            // 根には親が無い
            save(
                std::path::Path::new("/"),
                &BTreeMap::from([("a".to_string(), 1u32)]),
            );
            let lines = 諦めの行(mark, "置き場所（親フォルダ）が決まらない");
            assert_eq!(lines.len(), 1, "{lines:#?}");
            assert_eq!(lines[0]["level"], "DEBUG");
        }

        #[test]
        fn 置き場所を作れない() {
            // **読み取り専用ディレクトリ（0o555）は使わない**——CI が root だと効かない。
            // 置き場所の位置にファイルを置けば、どの権限でも作れない
            let dir = temp_dir("nodir");
            std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
            std::fs::write(&dir, "邪魔").unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            save(
                &dir.join("state.json"),
                &BTreeMap::from([("a".to_string(), 1u32)]),
            );

            assert_eq!(諦めの行(mark, "置き場所を作れない").len(), 1);
            let _ = std::fs::remove_file(&dir);
        }

        #[test]
        fn json_にできない() {
            let dir = temp_dir("unserializable");
            let sink = capture::sink();
            let mark = sink.mark();
            // 組の鍵は JSON の鍵になれない
            save(
                &dir.join("state.json"),
                &BTreeMap::from([((1u8, 2u8), 3u32)]),
            );
            assert_eq!(諦めの行(mark, "JSON にできない").len(), 1);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn 一時ファイルへ書けない() {
            let dir = temp_dir("tmpblocked");
            std::fs::create_dir_all(&dir).unwrap();
            // 一時ファイルの位置をディレクトリで塞ぐ
            std::fs::create_dir_all(dir.join("state.tmp")).unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            save(
                &dir.join("state.json"),
                &BTreeMap::from([("a".to_string(), 1u32)]),
            );

            assert_eq!(諦めの行(mark, "一時ファイルへ書けない").len(), 1);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn 置き換えられない() {
            let dir = temp_dir("renameblocked");
            std::fs::create_dir_all(&dir).unwrap();
            // 本体の位置をディレクトリで塞ぐ（ファイル → ディレクトリの置き換えは通らない）
            std::fs::create_dir_all(dir.join("state.json")).unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            save(
                &dir.join("state.json"),
                &BTreeMap::from([("a".to_string(), 1u32)]),
            );

            assert_eq!(諦めの行(mark, "一時ファイルを置き換えられない").len(), 1);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn まだ無いのは黙る() {
            // 初回起動の正常な道。ここで鳴ると、起こすたびに読まれない行が増える
            let dir = temp_dir("absent");
            let sink = capture::sink();
            let mark = sink.mark();
            let loaded: BTreeMap<String, u32> = load_or_default(&dir.join("state.json"));
            assert!(loaded.is_empty());
            assert!(諦めの行(mark, "既定から始めます").is_empty());
        }

        #[test]
        fn 読めない中身は理由ごと残す() {
            let dir = temp_dir("unreadable");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("state.json"), "{壊れている").unwrap();

            let sink = capture::sink();
            let mark = sink.mark();
            let loaded: BTreeMap<String, u32> = load_or_default(&dir.join("state.json"));

            assert!(loaded.is_empty(), "判断は変えない（既定で始める）");
            let lines = 諦めの行(mark, "中身が JSON として読めない");
            assert_eq!(lines.len(), 1, "{lines:#?}");
            assert_eq!(lines[0]["level"], "DEBUG");
            let _ = std::fs::remove_dir_all(dir);
        }
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
