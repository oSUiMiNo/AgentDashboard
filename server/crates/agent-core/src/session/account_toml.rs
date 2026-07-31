//! セッションが名乗るアカウントを `.agent-dashboard.toml` から読む（セルフホスト化設計§8-5）。
//!
//! # これは権限ではない
//!
//! **権限の源はペアリングトークン**で、記録に残る帰属を決めるのはサーバ側（§5-1 の手順4）。
//! ここが返すのは「このプロジェクトはこのアカウントのものだと思う」という**申告**にすぎず、
//! トークンのアカウントと食い違えば無視される。
//!
//! 逆に言うと、ここで読み間違えても事故にはならない。だから**読めないものは黙って諦める**
//! （壊れた toml でセッションの起動を止めない）。警告だけ残せば、利用者は気づける。
//!
//! # なぜ上へ辿るのか
//!
//! セッションの作業ディレクトリは、リポジトリの中の任意の深さになる（`app/web` で起こす
//! ことも `app` で起こすこともある）。ファイルはリポジトリの根に1枚置いて済ませたいので、
//! **cwd から上へ辿って最初に見つかった1枚**を採る。2枚目以降を見ないのは、
//! 近いほうが具体的だから——親の指定を子が上書きできる形にしておく。

use std::path::Path;

/// 探すファイルの名前。
pub const FILE_NAME: &str = ".agent-dashboard.toml";

/// 読み取る唯一のキー。
const ACCOUNT_KEY: &str = "account";

/// `cwd` から上へ辿って、最初に見つかった `.agent-dashboard.toml` の `account` を返す。
///
/// 見つからない・読めない・キーが無い・空文字、のいずれも `None`。**理由で呼び分けない**のは、
/// 呼び出し側にできることが「申告なし」として扱う以外に無いため。
pub fn lookup(cwd: &Path) -> Option<String> {
    for dir in cwd.ancestors() {
        let path = dir.join(FILE_NAME);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        // **見つけた時点で打ち切る。** 壊れていても上へ辿り直さない——近いほうが
        // 具体的だと決めた以上、その1枚が答えであり、直す先も利用者から見て明確になる
        return match parse(&text) {
            Ok(account) => {
                if account.is_none() {
                    tracing::warn!(
                        "{} に {ACCOUNT_KEY} がありません（申告なしとして扱います）",
                        path.display()
                    );
                }
                account
            }
            Err(err) => {
                tracing::warn!("{} を読めません: {err}", path.display());
                None
            }
        };
    }
    None
}

/// toml の本文から `account` を取り出す。
fn parse(text: &str) -> Result<Option<String>, toml::de::Error> {
    let table: toml::Table = text.parse()?;
    Ok(table
        .get(ACCOUNT_KEY)
        .and_then(|value| value.as_str())
        .map(str::trim)
        // 空文字は「書いたが埋めていない」。名前として使うと空のバッジが出るだけなので、
        // 書かれていないのと同じ扱いにする
        .filter(|account| !account.is_empty())
        .map(str::to_string))
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-account-toml-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        dir
    }

    #[test]
    fn 上へ辿って最初の1枚が効く() {
        // リポジトリの根に1枚置けば、その下のどこで起こしても効くこと
        let root = temp_dir("ancestors");
        let deep = root.join("app").join("web").join("src");
        std::fs::create_dir_all(&deep).expect("作れること");
        std::fs::write(root.join(FILE_NAME), "account = \"わたし\"\n").expect("書けること");

        assert_eq!(lookup(&deep), Some("わたし".to_string()));
        assert_eq!(lookup(&root), Some("わたし".to_string()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn 近いほうが親を上書きする() {
        // 親の指定を子が上書きできる形にしておかないと、モノレポの一部だけを
        // 別のアカウントへ寄せることができない
        let root = temp_dir("nearest");
        let child = root.join("app");
        std::fs::create_dir_all(&child).expect("作れること");
        std::fs::write(root.join(FILE_NAME), "account = \"おや\"\n").expect("書けること");
        std::fs::write(child.join(FILE_NAME), "account = \"こ\"\n").expect("書けること");

        assert_eq!(lookup(&child), Some("こ".to_string()));
        assert_eq!(lookup(&root), Some("おや".to_string()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ファイルが無ければ申告なし() {
        let dir = temp_dir("missing");
        assert_eq!(lookup(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 壊れたファイルでも起動を止めない() {
        // ここで読み違えても帰属は動かない（権限の源はトークン）。**セッションの起動を
        // 巻き添えにしないこと**のほうが大事なので、諦めて申告なしにする
        let dir = temp_dir("broken");
        std::fs::write(dir.join(FILE_NAME), "account = = \"x\"\n").expect("書けること");
        assert_eq!(lookup(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 空の名前は書かれていないのと同じ() {
        let dir = temp_dir("empty");
        std::fs::write(dir.join(FILE_NAME), "account = \"   \"\n").expect("書けること");
        assert_eq!(lookup(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 見つけた1枚にキーが無ければ上へ辿り直さない() {
        // 近いほうが具体的だと決めた以上、その1枚が答え。辿り直すと、
        // 「子で無効にしたつもりが親の指定に戻る」という説明の付かない動きになる
        let root = temp_dir("stop");
        let child = root.join("app");
        std::fs::create_dir_all(&child).expect("作れること");
        std::fs::write(root.join(FILE_NAME), "account = \"おや\"\n").expect("書けること");
        std::fs::write(child.join(FILE_NAME), "# 何も書いていない\n").expect("書けること");

        assert_eq!(lookup(&child), None);

        let _ = std::fs::remove_dir_all(root);
    }
}
