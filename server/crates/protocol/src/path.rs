//! 書き込みを許可する場所の規則（ファイルビュアにエディタ機能を追加 設計§3）。
//!
//! # 規則はこのモジュールの1つだけである
//!
//! 「そのパスは、許可された根の配下か」を決めるのは [`is_under`] ただ1つ。
//! サーバと PC の2箇所でこれを呼ぶが、**それは規則が2つあるという意味ではない**。
//! 2箇所あるのは**この関数へ渡す材料を用意する場所**であって、規則そのものはここにしか
//! 無い。**ここを直せば両方が同時に直る。**
//!
//! | 誰が | 何を渡すか | なぜそこでしか確かめられないか |
//! |---|---|---|
//! | サーバ | **字句**（`..` を畳んだ文字列） | 画面と CLI を素通りさせないため、入口で速く断る |
//! | PC | **実体**（`canonicalize` したパス） | リンクの解決はファイルシステムに触るので、当該の機械にしかできない |
//!
//! # 畳むのは呼ぶ側の仕事である
//!
//! この関数は**文字列しか見ない**。`..` を畳んだりリンクを辿ったりはしない。
//! ここで畳むと「材料を用意する場所」が3つになり、どれが正なのか読めなくなる。
//!
//! # ブラウザ側の同名の関数は、表示用である
//!
//! `web/src/lib/hostfs.ts` の `isUnder` は**画面の見せ方を決めるためのもの**で、
//! 「保存ボタンを出すか」にしか使わない。**弾く責任は持たない。正はこちら側である。**
//!
//! # ハンドラの中へ判定を書かないこと
//!
//! 書くと本当に二重実装になり、[`crate::fs`] の口が増えたときに三重になる。
//! 内側かどうかを見るときは、必ずここを通す。

/// `path` が `root` そのものか、その内側にあるか。
///
/// **区切りまで見る。** 素の前方一致で書くと、`/dev/app` の内側の判定に
/// `/dev/app-old` や `/dev/app2` が通ってしまう。名前の頭が同じ兄弟フォルダは
/// 珍しくないので、**許可した根の外へ抜ける道**がそこに残る。
///
/// **大文字小文字は区別する。** 独自に小文字化しない——照合を緩める方向の改変は、
/// 緩めすぎた分がそのまま穴になる。
pub fn is_under(root: &str, path: &str) -> bool {
    path == trim_end(root) || path.starts_with(&prefix_of(root))
}

/// いずれかの根の配下か。**一覧が空なら、どこへも書けない。**
///
/// 既定を「空＝全部許可」にしてはいけない。設定を書き忘れた利用者が、
/// いちばん緩い状態で使うことになる。
pub fn is_writable(roots: &[String], path: &str) -> bool {
    roots.iter().any(|root| is_under(root, path))
}

/// 実際に効く根の一覧——**設定の根に、開いている PJT の配下を足したもの**。
///
/// **PJT を足すのはコードの側である**（設計§3-5）。設定に PJT を書かせると、
/// PJT を足すたびに設定も直す必要が出る。
pub fn effective_roots(configured: &[String], project_root: Option<&str>) -> Vec<String> {
    let mut roots: Vec<String> = Vec::with_capacity(configured.len() + 1);
    if let Some(project) = project_root {
        if !project.is_empty() {
            roots.push(trim_end(project).to_string());
        }
    }
    for root in configured {
        if root.is_empty() {
            continue;
        }
        let trimmed = trim_end(root).to_string();
        if !roots.contains(&trimmed) {
            roots.push(trimmed);
        }
    }
    roots
}

/// 末尾の区切りを落とす。**ルート（`/`）だけは落とさない。**
fn trim_end(path: &str) -> &str {
    if path.len() > 1 {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    }
}

/// 内側を表す前置き。**ルートは `//` にしない**（そこだけ区切りが元から在る）。
fn prefix_of(root: &str) -> String {
    let base = trim_end(root);
    if base.ends_with('/') {
        base.to_string()
    } else {
        format!("{base}/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    // --- テスト計画 3-1 の4項目 ---

    #[test]
    fn 畳んだ結果が根の外を指すなら断る() {
        // `..` を畳むのは呼ぶ側の仕事なので、**畳んだ後の文字列**を渡す形で確かめる。
        assert!(!is_under("/home/u/pjt", "/etc/passwd"));
        assert!(!is_under("/home/u/pjt", "/home/u"));
    }

    #[test]
    fn 解決済みの外向きパスを断る() {
        // リンクの実解決は PC 側の仕事。ここで確かめるのは
        // 「`canonicalize` の結果が外を指していたら断る」ことだけである。
        assert!(!is_under("/home/u/pjt", "/var/tmp/somewhere"));
    }

    #[test]
    fn 頭が同じ兄弟フォルダを通さない() {
        // 素の前方一致で書くと、ここが通ってしまう。
        assert!(!is_under("/dev/app", "/dev/app-old"));
        assert!(!is_under("/dev/app", "/dev/app2"));
        assert!(!is_under("/dev/app", "/dev/app-old/src/main.rs"));
        assert!(is_under("/dev/app", "/dev/app/src/main.rs"));
    }

    #[test]
    fn 絶対パスで直接外を指すなら断る() {
        assert!(!is_under("/home/u/pjt", "/etc/shadow"));
    }

    // --- 規則の細部（設計§3-2） ---

    #[test]
    fn 根そのものは内側とみなす() {
        assert!(is_under("/dev/app", "/dev/app"));
        assert!(is_under("/dev/app/", "/dev/app"));
    }

    #[test]
    fn 根の末尾の区切りは結果を変えない() {
        assert_eq!(
            is_under("/dev/app", "/dev/app/src"),
            is_under("/dev/app/", "/dev/app/src")
        );
        assert!(is_under("/dev/app/", "/dev/app/src"));
    }

    #[test]
    fn 根がルートのとき二重の区切りを作らない() {
        assert!(is_under("/", "/etc/passwd"));
        assert!(is_under("/", "/"));
    }

    #[test]
    fn 許可する場所がいずれか1つに当たれば書ける() {
        let allowed = roots(&["/dev/app", "/home/u/notes"]);
        assert!(is_writable(&allowed, "/home/u/notes/todo.md"));
        assert!(is_writable(&allowed, "/dev/app/src/main.rs"));
        assert!(!is_writable(&allowed, "/etc/passwd"));
    }

    #[test]
    fn 許可する場所の一覧が空ならどこへも書けない() {
        assert!(!is_writable(&[], "/home/u/notes/todo.md"));
        assert!(!is_writable(&[], "/"));
    }

    // --- 実際に効く根の組み立て ---

    #[test]
    fn 開いているPJTはコードの側で足される() {
        let effective = effective_roots(&[], Some("/dev/app"));
        assert_eq!(effective, roots(&["/dev/app"]));
        assert!(is_writable(&effective, "/dev/app/src/main.rs"));
    }

    #[test]
    fn 設定の根とPJTの両方が効く() {
        let effective = effective_roots(&roots(&["/home/u/notes"]), Some("/dev/app"));
        assert!(is_writable(&effective, "/dev/app/src/main.rs"));
        assert!(is_writable(&effective, "/home/u/notes/todo.md"));
        assert!(!is_writable(&effective, "/etc/passwd"));
    }

    #[test]
    fn 同じ根を二重に持たない() {
        let effective = effective_roots(&roots(&["/dev/app", "/dev/app/"]), Some("/dev/app"));
        assert_eq!(effective, roots(&["/dev/app"]));
    }

    #[test]
    fn PJTが無くても設定の根だけで効く() {
        let effective = effective_roots(&roots(&["/home/u/notes"]), None);
        assert_eq!(effective, roots(&["/home/u/notes"]));
        assert!(!is_writable(&effective, "/dev/app/src/main.rs"));
    }
}
