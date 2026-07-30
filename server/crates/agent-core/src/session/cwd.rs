//! 起動フォームに入力された作業ディレクトリを解釈する。
//!
//! 本アプリは WSL の上で動き、利用者は Windows 側のエクスプローラからパスを貼ることがある。
//! そのため入力は `\` 区切りだったり、引用符が付いていたり、先頭の区切りが抜けていたりする。
//! ここでは**入力を書き換えるのではなく、試すべき解釈を順に並べて最初に当たったものを採る**。
//!
//! 入力そのままを必ず先頭に置くのが要点で、これで従来の解釈は一切変わらない
//! （Linux では `\` もフォルダ名に使える文字なので、無条件に読み替えると実在のフォルダを壊す）。

use std::path::PathBuf;

/// 入力を解釈した結果。
#[derive(Debug, PartialEq, Eq)]
pub enum Resolution {
    /// フォルダとして開けるものが見つかった
    Found(PathBuf),
    /// 存在はしたがフォルダではなかった
    NotDirectory(PathBuf),
    /// どの解釈でも見つからなかった。`interpreted` は最後まで読み替えた形
    /// （入力そのままと同じなら `None`。同じものを二度見せない）
    NotFound { interpreted: Option<PathBuf> },
}

/// 試すべきパスを優先順に返す。ファイルシステムには触らない。
pub fn candidates(input: &str) -> Vec<PathBuf> {
    let cleaned = cleanup(input);
    if cleaned.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    push_unique(&mut out, cleaned.to_string());

    let unified = cleaned.replace('\\', "/");
    push_unique(&mut out, unified.clone());

    if let Some(rest) = strip_unc(&unified) {
        push_unique(&mut out, rest);
    } else if let Some(mounted) = mount_drive(&unified) {
        push_unique(&mut out, mounted);
    } else if !unified.starts_with('/') {
        // 先頭の区切りを打ち忘れた形。相対パスとしての解釈を先に試したうえでの保険なので、
        // サーバのカレントからの相対指定は今までどおり効く
        push_unique(&mut out, format!("/{unified}"));
    }

    out
}

/// 候補を順に当てて、最初にフォルダだったものを採る。
pub fn resolve(input: &str) -> Resolution {
    let list = candidates(input);
    let mut existing = None;
    for candidate in &list {
        if candidate.is_dir() {
            return Resolution::Found(candidate.clone());
        }
        // フォルダではないが存在はする（＝ファイルを指している）ことは、
        // 「見つからない」とは別の理由として伝えたい
        if existing.is_none() && candidate.exists() {
            existing = Some(candidate.clone());
        }
    }

    match existing {
        Some(path) => Resolution::NotDirectory(path),
        None => Resolution::NotFound {
            interpreted: if list.len() > 1 {
                list.last().cloned()
            } else {
                None
            },
        },
    }
}

/// 前後の空白と引用符を落とす。Windows の「パスとしてコピー」は `"..."` を付けてくる。
fn cleanup(input: &str) -> &str {
    input.trim().trim_matches('"').trim()
}

/// `//wsl.localhost/<ディストリ>/...` と `//wsl$/<ディストリ>/...` を WSL 内の絶対パスにする。
///
/// ディストリ名が今動いている環境と一致するかは見ていない。別のディストリの中身は
/// そもそもここからは見えないので、一致しなければ「存在しない」として落ちる。
fn strip_unc(unified: &str) -> Option<String> {
    let rest = unified.strip_prefix("//")?;
    let (host, rest) = rest.split_once('/')?;
    let host = host.to_ascii_lowercase();
    if host != "wsl.localhost" && host != "wsl$" {
        return None;
    }
    let (_distro, rest) = rest.split_once('/')?;
    Some(format!("/{rest}"))
}

/// `C:/...` を WSL のマウント先 `/mnt/c/...` にする。
fn mount_drive(unified: &str) -> Option<String> {
    let mut chars = unified.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    let rest = unified[2..].strip_prefix('/').unwrap_or(&unified[2..]);
    Some(format!("/mnt/{}/{}", letter.to_ascii_lowercase(), rest))
}

fn push_unique(out: &mut Vec<PathBuf>, value: String) {
    let path = PathBuf::from(value);
    if !out.contains(&path) {
        out.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(input: &str) -> Vec<String> {
        candidates(input)
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn 入力そのままが常に先頭の候補になる() {
        // ここが崩れると、`\` を名前に含む実在のフォルダを開けなくなる
        assert_eq!(
            resolved("/home/example/dev/app")[0],
            "/home/example/dev/app"
        );
        assert_eq!(
            resolved(r"/home/example/変な\名前")[0],
            r"/home/example/変な\名前"
        );
    }

    #[test]
    fn バックスラッシュ区切りを読み替える() {
        assert_eq!(
            resolved(r"\home\example\dev\app"),
            [r"\home\example\dev\app", "/home/example/dev/app"]
        );
    }

    #[test]
    fn 先頭の区切り忘れを補う() {
        assert_eq!(
            resolved("home/example/dev/app"),
            ["home/example/dev/app", "/home/example/dev/app"]
        );
    }

    #[test]
    fn 区切り忘れとバックスラッシュが同時に来ても補う() {
        assert_eq!(
            resolved(r"home\example\dev\app"),
            [
                r"home\example\dev\app",
                "home/example/dev/app",
                "/home/example/dev/app"
            ]
        );
    }

    #[test]
    fn wslのネットワークパスからディストリ名を落とす() {
        assert_eq!(
            resolved(r"\\wsl.localhost\Ubuntu-24.04\home\example\app")
                .last()
                .unwrap(),
            "/home/example/app"
        );
        assert_eq!(
            resolved(r"\\wsl$\Ubuntu-24.04\home\example\app")
                .last()
                .unwrap(),
            "/home/example/app"
        );
    }

    #[test]
    fn 知らないホストのネットワークパスは読み替えない() {
        // 他所の共有フォルダを勝手にローカルのパスへ読み替えてはいけない
        assert_eq!(
            resolved(r"\\fileserver\share\app"),
            [r"\\fileserver\share\app", "//fileserver/share/app"]
        );
    }

    #[test]
    fn ドライブレターをマウント先へ読み替える() {
        assert_eq!(
            resolved(r"C:\Users\me\proj").last().unwrap(),
            "/mnt/c/Users/me/proj"
        );
        assert_eq!(resolved("d:/work").last().unwrap(), "/mnt/d/work");
    }

    #[test]
    fn 前後の空白と引用符を落とす() {
        // 「パスとしてコピー」した文字列をそのまま貼れるように
        assert_eq!(
            resolved("  \"/home/example/dev/app\"  ")[0],
            "/home/example/dev/app"
        );
    }

    #[test]
    fn 候補は重複しない() {
        assert_eq!(resolved("/home/example/dev/app").len(), 1);
    }

    #[test]
    fn 空の入力では候補が無い() {
        assert!(candidates("").is_empty());
        assert!(candidates("   ").is_empty());
        assert!(candidates("\"\"").is_empty());
    }

    #[test]
    fn 見つからないときは読み替えた形を添える() {
        let Resolution::NotFound { interpreted } = resolve(r"\存在しないはずのフォルダ")
        else {
            panic!("見つかってはいけない");
        };
        assert_eq!(
            interpreted.unwrap().to_string_lossy(),
            "/存在しないはずのフォルダ"
        );

        // 読み替える余地が無いときは添えない（同じ文字列を二度見せない）
        let Resolution::NotFound { interpreted } = resolve("/存在しないはずのフォルダ")
        else {
            panic!("見つかってはいけない");
        };
        assert!(interpreted.is_none());
    }

    #[test]
    fn 実在するフォルダは読み替えずに見つかる() {
        assert_eq!(resolve("/tmp"), Resolution::Found(PathBuf::from("/tmp")));
        // 先頭の区切りが抜けていても辿り着く
        assert_eq!(resolve(r"\tmp"), Resolution::Found(PathBuf::from("/tmp")));
    }
}
