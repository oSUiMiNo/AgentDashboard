//! 版を切り替えてよいかを、**行き先の実行ファイル自身に聞く**門（CICD設計§9）。
//!
//! 消す道（`scripts/uninstall.sh`）が記録の置き場所を `agentdashboard state-dir` に
//! 聞いているのと同じ形。置き場所を自分で組み立てないのと同じ理由で、**行き先が何を
//! 知っているかも自分で推し量らない**——推し量ると、実装を変えたときに黙って食い違う。
//!
//! # 何を防ぐのか
//!
//! いちばん重いのは記録の形の後退である。適用済みの形の中に行き先が知らないものが
//! 混じっていると、その版は**起動できない**（記録の道具が拒む。設計§20-3 で実測）。
//! 画面が出ないとポインタも直せないので、**門の目的は破損を防ぐことではなく、
//! 袋小路を作らないこと**にある。
//!
//! # 材料集めと判定を分ける
//!
//! [`ask`] がプロセスを起こして材料を集め、[`judge`] が結論を出す。判定が純粋関数なので、
//! テストは実行ファイルを用意せずに全部の枝を通せる。
//!
//! # 聞く相手は自分たちが置いたものだけ
//!
//! 起こすのは保管庫の実行ファイルなので、打ち切りの仕掛けは持たない。3つの問いは
//! どれも標準入力を塞いで起こすので、入力待ちで止まることはない。

use std::path::Path;

/// 門の結論。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verdict {
    /// 切り替えてよい。
    Ready,
    /// **確かめられなかった。** 断らずに、そう言って明示の同意を取る。
    ///
    /// 断ってしまうと、いちばん戻りたい先——この機能を入れる直前の版——へ永久に
    /// 戻れなくなる。あの版は形の一覧に答えられないので、必ずこの経路を通る。
    Unverified { reason: String },
    /// 切り替えてはいけない。
    Refused { reason: String },
}

/// 行き先に聞いた答え。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answers {
    /// 行き先が知っている記録の形。**聞けなかったときは `None`**（この機能より前の版）。
    pub schema_names: Option<Vec<String>>,
}

/// 起こして標準出力と標準エラーを採る。
fn run(target: &Path, args: &[&std::ffi::OsStr]) -> Result<std::process::Output, String> {
    std::process::Command::new(target)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|err| format!("起こせません: {err}"))
}

/// 失敗したときの理由。**標準エラーを混ぜる**——「終了コード 1」だけでは直しようがない。
fn why(output: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr);
    let line = text.lines().find(|line| !line.trim().is_empty());
    line.unwrap_or("理由を出さずに終わりました")
        .trim()
        .to_string()
}

/// 行き先の実行ファイルに聞く（設計§9 の3つ）。
///
/// `config_path` は**親が `--config` を受け取ったときだけ** `Some` を渡す。常に渡すと、
/// 設定ファイルを置いていない利用者を「設定が壊れている」と誤判定する——`--config` 無しの
/// 起動は、カレントに設定が無くても**空の設定として成功する**（設計§20-3 で実測）。
pub fn ask(target: &Path, config_path: Option<&Path>) -> Result<Answers, String> {
    // 1. そもそも起動できるか（別のアーキ向け・壊れたダウンロード・足りないライブラリ）
    let version = run(target, &["--version".as_ref()])?;
    if !version.status.success() {
        return Err(format!("起動できません（{}）", why(&version)));
    }

    // 2. いまの設定を読めるか。**知らないキーがあると起動を拒む**仕様なので、
    //    新しい版が増やしたキーが書かれていると古い版は起動すらできない
    let mut args: Vec<&std::ffi::OsStr> = Vec::new();
    if let Some(path) = config_path {
        args.push("--config".as_ref());
        args.push(path.as_ref());
    }
    args.push("config".as_ref());
    let config = run(target, &args)?;
    if !config.status.success() {
        return Err(format!("いまの設定を読めません（{}）", why(&config)));
    }

    // 3. 知っている記録の形。**目印の形で読めたときだけ「聞けた」**（終了コードは当てにしない）
    let schema = run(target, &["migrations".as_ref()])?;
    let printed = String::from_utf8_lossy(&schema.stdout);
    let schema_names = printed
        .strip_prefix(crate::cli::SCHEMA_NAMES_MARKER)
        .map(|rest| {
            rest.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        });

    Ok(Answers { schema_names })
}

/// 聞いた答えと、その DB に適用済みの形を突き合わせて結論を出す（純粋関数）。
pub fn judge(answers: &Answers, applied: &[String]) -> Verdict {
    let Some(known) = &answers.schema_names else {
        return Verdict::Unverified {
            reason: "この版は記録の形を答えられません（この機能より前の版です）".to_string(),
        };
    };

    let unknown: Vec<&str> = applied
        .iter()
        .map(String::as_str)
        .filter(|name| !known.iter().any(|known| known == name))
        .collect();

    if unknown.is_empty() {
        return Verdict::Ready;
    }
    Verdict::Refused {
        reason: format!(
            "この版が知らない記録の形が適用済みです（{}）。切り替えると起動できなくなります",
            unknown.join(" / ")
        ),
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn 答え(names: Option<&[&str]>) -> Answers {
        Answers {
            schema_names: names.map(|names| names.iter().map(|n| n.to_string()).collect()),
        }
    }

    #[test]
    fn 行き先が知らない形が適用済みなら断る() {
        let verdict = judge(
            &答え(Some(&["m1_init"])),
            &["m1_init".to_string(), "m2_あとから".to_string()],
        );
        let Verdict::Refused { reason } = verdict else {
            panic!("断っていない: {verdict:?}");
        };
        assert!(
            reason.contains("m2_あとから"),
            "何が引っかかったか: {reason}"
        );
    }

    #[test]
    fn 行き先が全部知っていれば通す() {
        assert_eq!(
            judge(
                &答え(Some(&["m1_init", "m2_あとから"])),
                &["m1_init".to_string()]
            ),
            Verdict::Ready,
            "行き先のほうが多く知っているのは前へ進むだけ"
        );
    }

    #[test]
    fn 形を答えられない版は断らずに確かめられないと言う() {
        // 断ると、いちばん戻りたい先（この機能を入れる直前の版）へ永久に戻れない
        let verdict = judge(&答え(None), &["m1_init".to_string()]);
        assert!(
            matches!(verdict, Verdict::Unverified { .. }),
            "断ってしまっている: {verdict:?}"
        );
    }
}
