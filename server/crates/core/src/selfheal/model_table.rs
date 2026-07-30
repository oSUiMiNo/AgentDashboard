//! 別名の表を、公式ドキュメントから追随させる（設計§14）。
//!
//! # なぜ機械では足りないのか
//!
//! 正式名と通称の対応（`claude-opus-5` → `Opus 5`）は CLI バイナリから取れる
//! （[`crate::model_catalog`]）。しかし**バイナリのモデル表に入っているのは実在する
//! モデルだけ**で、`opusplan` / `best` / `default` / `opus[1m]` は1件も入っていない。
//! これらはモデルではなく別名・モードだからである。
//!
//! | 何 | バイナリ | 意味の理解 |
//! |---|---|---|
//! | `claude-opus-5` → `Opus 5` | ある | 不要 |
//! | 別名のラインナップ（`opusplan` が増えた） | **無い** | **要る** |
//! | 説明文（「プラン中は Opus、実行は Sonnet」） | **無い** | **要る** |
//! | 解決先が状況で変わるか（`fixed`） | **無い** | **要る** |
//!
//! 右側はドキュメントを読んで意味を汲まないと書けない。だからここだけエージェントに任せる。
//!
//! # 契機は「観測」ではなく「CLI のバージョン変化」
//!
//! 当初の設計（§8）は「表に無い別名を繰り返し観測したとき」を検知の契機にしていた。
//! **これでは足りない。** 誰も使っていない新しい別名は永久に観測されないので、
//! `opusplan` のような概念が増えても、利用者がそれを知って打つまで気づけない。
//!
//! 新しい概念は CLI のバージョンと一緒に来る。**バージョンが上がったら見直す**のが正しい。
//!
//! # 言葉で縛らず、機械で見る
//!
//! [`super::repair`] と同じ立場。プロンプトには「触ってよいのはこのファイルだけ」と
//! 書くが、それは担保にならない。触った範囲と表の形は、こちらで機械的に確かめる。

use crate::jsonfile;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 見直しの記録を残すファイル名。
const FILE_NAME: &str = "model-table-review.json";

/// 別名の表の場所（リポジトリ相対）。**修復セッションが触ってよい唯一のファイル。**
///
/// 設計§3 が「表は単独のファイルに閉じる」としてあるのは、まさにこの範囲を
/// 1ファイルに限れるようにするため。
pub const TABLE_PATH: &str = "web/src/lib/models.ts";

/// 表が持っていなければならないキー。数が揃っていることで形の崩れを見る。
const REQUIRED_KEYS: &[&str] = &["value:", "label:", "description:", "fixed:"];

/// 参照させる公式ドキュメント。
const DOC_URL: &str = "https://code.claude.com/docs/en/model-config";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Review {
    /// 最後に表を見直したときの CLI のバージョン
    reviewed_cli_version: String,
}

/// 見直しが要るか。要るなら `true`。
///
/// **バージョンが読めないときは要らないと答える。** 分からないことを理由に
/// 無人のセッションを起こすのは割に合わない。
pub fn needs_review(state_dir: &Path, cli_version: &str) -> bool {
    if cli_version.is_empty() {
        return false;
    }
    let review = jsonfile::load_or_default::<Review>(&state_dir.join(FILE_NAME));
    review.reviewed_cli_version != cli_version
}

/// 見直しが済んだことを記録する。
///
/// **失敗したときも記録する。** 同じバージョンで何度も無人セッションを起こしても、
/// 同じ結果になるだけで資源を捨てることになる。次のバージョンで再挑戦すればよい。
pub fn mark_reviewed(state_dir: &Path, cli_version: &str) {
    jsonfile::save(
        &state_dir.join(FILE_NAME),
        &Review {
            reviewed_cli_version: cli_version.to_string(),
        },
    );
}

/// 見直しセッションへ渡す指示を組み立てる。
///
/// `observed` は、これまでに実際に観測した別名。**消させないための材料**として渡す。
pub fn review_prompt(cli_version: &str, observed: &[String]) -> String {
    let observed_list = if observed.is_empty() {
        "（まだ観測なし）".to_string()
    } else {
        observed.join(", ")
    };

    format!(
        "あなたは AgentDashboard のモデル別名表を最新に保つ担当です。\
        この作業ディレクトリは修復専用の git worktree で、本体の作業ツリーではありません。\n\
        \n\
        ## 何をしてほしいか\n\
        Claude Code が {cli_version} に上がりました。`/model` で指定できる**別名の\
        ラインナップと意味**が変わっているかもしれないので、確かめて表を合わせてください。\n\
        \n\
        1. {DOC_URL} を読み、いま指定できる別名の一覧と、それぞれが何をするのかを把握する\n\
        2. `{TABLE_PATH}` の `MODELS` を、その内容に合わせる\n\
        \n\
        ## 表の書き方\n\
        1件は次の4つを持ちます。**この形は変えないでください。**\n\
        \n\
        - `value` … `/model` へ渡す別名そのもの\n\
        - `label` … 画面に出す短い名前。**版番号を書いてはいけません**\
        （別名がどの版に解決されるかは環境で変わるので、この表には書けません。\
        版番号は CLI から実測して別途埋めています）\n\
        - `description` … マウスを乗せたときに出る説明。何が起きるかを1行で\n\
        - `fixed` … **特定のモデル1つを指す別名なら `true`**。\
        `default` / `best` / `opusplan` のように解決先が状況で変わるものは `false`。\
        この印が `true` のものだけ、実測した版番号で名前を置き換えます\n\
        - `family` … CLI のモデル表でいう系統名（`opus` など）。`fixed` が `true` で、\
        系統が決まっているものだけ書きます\n\
        \n\
        ## 守ること\n\
        - **変更してよいのは `{TABLE_PATH}` だけ**です。ほかを変更した場合、\
        テストの結果によらず不合格になります\n\
        - **いま表にある別名を消さないでください。** 特に次は実際に使われた実績があります：\
        {observed_list}\n\
        - 変更が要らないと判断したら、**何も変えずに**そう報告して終えてください。\
        無理に変える必要はありません\n\
        - 確認は `cd web && npx tsc -b && npm run test` で行います\n\
        - 完了したら、何を変えたのか（または変えなかったのか）を1〜2行で報告して\
        ターンを終えてください。コミットはこちらで行うので不要です"
    )
}

/// 範囲外を触っていないか確かめる。触っていたらその一覧を返す。
pub fn scope_violations(changed: &[String]) -> Vec<String> {
    changed
        .iter()
        .filter(|path| path.as_str() != TABLE_PATH)
        .cloned()
        .collect()
}

/// 表の形が保たれているかを見る。壊れていたら理由を返す。
///
/// TypeScript を解析はしない。**崩れていることが分かれば十分**で、そのときは
/// 採用せずに戻すだけだから。見るのは3点。
///
/// 1. 表そのものが残っているか
/// 2. 4つ組の形が崩れていないか（キーの数が揃っているか）
/// 3. 実際に使われた実績のある別名が消えていないか
pub fn table_violations(source: &str, observed: &[String]) -> Vec<String> {
    let mut problems = Vec::new();

    let Some(body) = models_body(source) else {
        problems.push("MODELS の定義が見当たらない".to_string());
        return problems;
    };

    let counts: Vec<usize> = REQUIRED_KEYS
        .iter()
        .map(|key| body.matches(key).count())
        .collect();
    let entries = counts[0];
    if entries == 0 {
        problems.push("表が空になっている".to_string());
    }
    for (key, count) in REQUIRED_KEYS.iter().zip(&counts) {
        if *count != entries {
            problems.push(format!(
                "{key} の数が {count} 件で、value の {entries} 件と揃っていない"
            ));
        }
    }

    for alias in observed {
        if !body.contains(&format!("value: '{alias}'"))
            && !body.contains(&format!("value: \"{alias}\""))
        {
            problems.push(format!("実際に使われた別名 {alias} が消えている"));
        }
    }
    problems
}

/// `export const MODELS = [ ... ]` の**中身だけ**を切り出す。
///
/// # 全体を数えてはいけない
///
/// 以前はキーの出現数を `source` 全体で数えていた。表の外にある
/// `interface ModelInfo { value: ModelId, ... }` や、`value` という名前の**関数の引数**まで
/// 数に入るので、`value:` だけが他より多くなる。**実物の表がその状態で、見直しは
/// 何を書いても「形が壊れている」で棄却されていた**（画面側のゲートを直して初めて、
/// その先にあるこれが見えた）。
///
/// 開き括弧は `=` より後ろを探す。`ModelInfo[]` の `[` を掴むと中身が空になる。
fn models_body(source: &str) -> Option<&str> {
    let start = source.find("export const MODELS")?;
    let eq = start + source[start..].find('=')?;
    let open = eq + source[eq..].find('[')?;

    // 別名には `opus[1m]` のように括弧を含むものがある。文字列の中は数えない
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (offset, ch) in source[open..].char_indices() {
        if let Some(open_quote) = quote {
            match ch {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                _ if ch == open_quote => quote = None,
                _ => {}
            }
            continue;
        }
        match ch {
            '\'' | '"' | '`' => quote = Some(ch),
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&source[open + 1..open + offset]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    const TABLE: &str = r#"
export const MODELS: ModelInfo[] = [
  { value: 'default', label: '既定', description: '指定を消す', fixed: false },
  { value: 'opus', label: 'Opus', description: '複雑な推論', fixed: true, family: 'opus' },
]
"#;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-model-table-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 初めての版では見直しが要る() {
        let dir = temp_dir("first");
        assert!(needs_review(&dir, "2.1.220"));
    }

    #[test]
    fn 同じ版なら二度と見直さない() {
        // 起動のたびに無人セッションを起こしてはいけない
        let dir = temp_dir("same");
        mark_reviewed(&dir, "2.1.220");
        assert!(!needs_review(&dir, "2.1.220"));
    }

    #[test]
    fn 版が上がったらまた見直す() {
        let dir = temp_dir("bumped");
        mark_reviewed(&dir, "2.1.220");
        assert!(needs_review(&dir, "2.2.0"));
    }

    #[test]
    fn 版が読めないときは見直さない() {
        // 分からないことを理由に無人セッションを起こすのは割に合わない
        let dir = temp_dir("unknown");
        assert!(!needs_review(&dir, ""));
    }

    #[test]
    fn 表のファイル以外を触ったら不合格() {
        assert!(scope_violations(&[TABLE_PATH.to_string()]).is_empty());
        assert_eq!(
            scope_violations(&[
                TABLE_PATH.to_string(),
                "server/crates/protocol/src/lib.rs".to_string(),
            ]),
            vec!["server/crates/protocol/src/lib.rs"]
        );
    }

    #[test]
    fn 形が保たれていれば通る() {
        assert!(table_violations(TABLE, &["opus".to_string()]).is_empty());
    }

    /// 実物の表。**検査が実物を通すことは、実物で確かめるしかない。**
    const REAL_TABLE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../",
        "web/src/lib/models.ts"
    ));

    #[test]
    fn 実物の表が検査を通る() {
        // これが無かったせいで、**どんな見直しも必ず棄却される**状態に気づけなかった。
        // 表の外にある `interface ModelInfo` や関数の引数の `value:` まで数えていたため。
        // 小さな見本だけで試していると、実物にしか無い形は永久に見えない
        let problems = table_violations(REAL_TABLE, &["opus".to_string(), "sonnet".to_string()]);
        assert!(problems.is_empty(), "実物の表が落ちている: {problems:?}");
    }

    #[test]
    fn 表の外にある同名のキーは数えない() {
        let source = format!(
            "export interface ModelInfo {{\n  value: ModelId\n  label: string\n}}\n{TABLE}\n\
             export function modelInfo(value: ModelId) {{ return value }}\n"
        );
        assert!(
            table_violations(&source, &[]).is_empty(),
            "実際: {:?}",
            table_violations(&source, &[])
        );
    }

    #[test]
    fn 括弧を含む別名があっても表の終わりを見失わない() {
        // `opus[1m]` の `]` で切り上げると、以降のエントリが数から漏れる
        let table = r#"
export const MODELS: ModelInfo[] = [
  { value: 'opus[1m]', label: 'Opus 1M', description: '長い文脈', fixed: true },
  { value: 'haiku', label: 'Haiku', description: '軽い作業', fixed: true },
]
"#;
        assert!(table_violations(table, &["haiku".to_string()]).is_empty());
    }

    #[test]
    fn 表ごと消したら不合格() {
        assert!(!table_violations("export const OTHER = []", &[]).is_empty());
    }

    #[test]
    fn 四つ組が欠けたら不合格() {
        // `fixed` を落とすと、版番号で置き換えてよいかの判断ができなくなる
        let broken = TABLE.replace(", fixed: true", "");
        let problems = table_violations(&broken, &[]);
        assert!(
            problems.iter().any(|problem| problem.contains("fixed:")),
            "実際: {problems:?}"
        );
    }

    #[test]
    fn 使われている別名を消したら不合格() {
        // 利用者が実際に選んだ別名が消えると、その人の運用が壊れる
        let problems = table_violations(TABLE, &["haiku".to_string()]);
        assert!(
            problems.iter().any(|problem| problem.contains("haiku")),
            "実際: {problems:?}"
        );
    }

    #[test]
    fn 指示には触ってよい範囲と消さない別名が入る() {
        let prompt = review_prompt("2.1.220", &["opus".to_string(), "haiku".to_string()]);
        assert!(prompt.contains(TABLE_PATH));
        assert!(prompt.contains(DOC_URL));
        assert!(prompt.contains("opus, haiku"));
        assert!(prompt.contains("2.1.220"));
        // 版番号を表へ書かせない、という制約が伝わること
        assert!(prompt.contains("版番号を書いてはいけません"));
        // 変えなくてよい、と言ってあること（無理に変えさせない）
        assert!(prompt.contains("変更が要らないと判断したら"));
    }
}
